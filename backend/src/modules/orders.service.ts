import type { GuestClaims, StaffClaims } from '../auth/tokens.js';
import { pool, query, queryOne, tx, type Db } from '../db/pool.js';
import { badRequest, conflict, HttpError, notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';
import { pendingTablePayment } from './billing.service.js';
import { publishCart } from './cart.service.js';
import { deliveryIdForOrder, markDeliveryAccepted, markDeliveryCancelled, publishDelivery, refreshDeliveryStatus } from './delivery.status.js';
import { publishInventoryAlerts } from './inventory.service.js';
import { acknowledgeLateGuests, publishTable, refreshTableStatus } from './tables.service.js';

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
export type OrderChannel = 'DINE_IN' | 'DELIVERY' | 'PICKUP';
export type ItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';

export interface OrderDto {
  id: string;
  number: number;
  status: OrderStatus;
  channel: OrderChannel;
  tableId: string | null; // null en domicilios y pedidos para recoger
  tableNumber: number | null;
  sessionId: string | null;
  deliveryId: string | null;
  deliveryCode: string | null; // D-2001
  customerName: string | null;
  createdAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  total: number;
  items: Array<{
    id: string;
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    notes: string;
    guestAlias: string | null;
    status: ItemStatus;
  }>;
}

const ORDER_SELECT = `
  SELECT o.id, o.order_number AS number, o.status, o.channel, o.table_id AS "tableId", t.number AS "tableNumber",
         o.session_id AS "sessionId", d.id AS "deliveryId", CASE WHEN d.id IS NULL THEN NULL ELSE 'D-' || d.code END AS "deliveryCode",
         d.customer_name AS "customerName", o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt",
         o.ready_at AS "readyAt", o.served_at AS "servedAt",
         COALESCE((SELECT SUM(oi.unit_price * oi.quantity) FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'CANCELLED'), 0) AS total,
         COALESCE((SELECT json_agg(json_build_object(
                     'id', oi.id, 'productId', oi.product_id, 'name', oi.product_name, 'unitPrice', oi.unit_price,
                     'quantity', oi.quantity, 'notes', oi.notes, 'guestAlias', oi.guest_alias, 'status', oi.status)
                     ORDER BY oi.product_name, oi.id)
                     FROM order_items oi WHERE oi.order_id = o.id), '[]'::json) AS items
    FROM orders o
    LEFT JOIN restaurant_tables t ON t.id = o.table_id
    LEFT JOIN delivery_orders d   ON d.order_id = o.id`;

export async function getOrder(orderId: string, db: Db = pool): Promise<OrderDto> {
  const order = await queryOne<OrderDto>(`${ORDER_SELECT} WHERE o.id = $1`, [orderId], db);
  if (!order) throw notFound('Comanda no encontrada');
  return order;
}

export function listSessionOrders(sessionId: string): Promise<OrderDto[]> {
  return query<OrderDto>(`${ORDER_SELECT} WHERE o.session_id = $1 ORDER BY o.created_at`, [sessionId]);
}

/** Cola de cocina: solo comandas ya confirmadas por sala y aún no entregadas. */
export function listKitchenOrders(restaurantId: string): Promise<OrderDto[]> {
  return query<OrderDto>(
    `${ORDER_SELECT} WHERE o.restaurant_id = $1 AND o.status IN ('CONFIRMED', 'PREPARING', 'READY') ORDER BY o.confirmed_at`,
    [restaurantId],
  );
}

/** Difunde la comanda a quien le importa: sala, cocina y los comensales de esa mesa. */
async function publishOrder(restaurantId: string, orderId: string, event: 'order:created' | 'order:updated' = 'order:updated'): Promise<OrderDto> {
  const order = await getOrder(orderId);
  const targets = [rooms.staff(restaurantId), rooms.kitchen(restaurantId)];
  if (order.sessionId) targets.push(rooms.session(order.sessionId));
  emit(targets, event, order);
  return order;
}

interface LockedOrder {
  id: string;
  status: OrderStatus;
  channel: OrderChannel;
  table_id: string | null;
}

/**
 * Tras cambiar una comanda, dentro de la misma transacción: recalcula el
 * color de su mesa o el estado de su domicilio. Devuelve qué publicar.
 */
async function refreshContext(db: Db, order: LockedOrder): Promise<{ tableId: string | null; deliveryId: string | null }> {
  if (order.table_id) {
    await refreshTableStatus(db, order.table_id);
    return { tableId: order.table_id, deliveryId: null };
  }
  const deliveryId = await deliveryIdForOrder(db, order.id);
  if (deliveryId) await refreshDeliveryStatus(db, deliveryId);
  return { tableId: null, deliveryId };
}

/** Después del COMMIT: avisa a sala (mapa de mesas) o a despacho y al cliente del domicilio. */
async function publishContext(restaurantId: string, context: { tableId: string | null; deliveryId: string | null }): Promise<void> {
  if (context.tableId) await publishTable(restaurantId, context.tableId);
  if (context.deliveryId) await publishDelivery(restaurantId, context.deliveryId);
}

/**
 * Un comensal envía el carrito compartido de la mesa. Todo el carrito se
 * convierte en UNA comanda en estado PENDING: no entra a cocina hasta que un
 * camarero la confirma (segunda barrera anti-fraude del QR).
 */
export async function submitOrder(guest: GuestClaims): Promise<OrderDto> {
  const orderId = await tx(async (db) => {
    // Serializa envíos simultáneos de la misma mesa (dos personas tocando "Pedir" a la vez).
    const session = await queryOne('SELECT id FROM table_sessions WHERE id = $1 AND closed_at IS NULL FOR UPDATE', [guest.sid], db);
    if (!session) throw new HttpError(410, 'SESSION_CLOSED', 'La mesa está cerrada');
    // Mientras alguien paga la cuenta en línea, el total no puede cambiar.
    if (await pendingTablePayment(db, guest.sid)) {
      throw conflict('Alguien de la mesa está pagando la cuenta en línea. Espera a que termine para pedir algo más.', 'ONLINE_PAYMENT_IN_PROGRESS');
    }

    const lines = await query<{ name: string; is_available: boolean }>(
      `SELECT p.name, (p.is_available AND p.deleted_at IS NULL) AS is_available
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.session_id = $1`,
      [guest.sid],
      db,
    );
    if (lines.length === 0) throw badRequest('El pedido de la mesa está vacío', 'EMPTY_CART');

    const unavailable = [...new Set(lines.filter((l) => !l.is_available).map((l) => l.name))];
    if (unavailable.length > 0) {
      throw conflict(`Se agotó: ${unavailable.join(', ')}. Quítalo del pedido para continuar.`, 'PRODUCT_UNAVAILABLE', { unavailable });
    }

    const order = await queryOne<{ id: string }>(
      'INSERT INTO orders (restaurant_id, table_id, session_id) VALUES ($1, $2, $3) RETURNING id',
      [guest.rid, guest.tid, guest.sid],
      db,
    );
    // Se copian nombre y precio: la comanda no cambia si después editan la carta.
    await db.query(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, notes, guest_alias)
       SELECT $1, p.id, p.name, p.price, ci.quantity, ci.notes, g.alias
         FROM cart_items ci
         JOIN products p       ON p.id = ci.product_id
         JOIN session_guests g ON g.id = ci.guest_id
        WHERE ci.session_id = $2`,
      [order!.id, guest.sid],
    );
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [guest.sid]);
    await refreshTableStatus(db, guest.tid);
    return order!.id;
  });

  await publishCart(guest.sid, { by: { id: guest.sub, alias: guest.alias }, action: 'ordered' });
  await publishTable(guest.rid, guest.tid);
  return publishOrder(guest.rid, orderId, 'order:created');
}

async function lockOrder(db: Db, staff: StaffClaims, orderId: string): Promise<LockedOrder> {
  const order = await queryOne<LockedOrder>(
    'SELECT id, status, channel, table_id FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [orderId, staff.rid],
    db,
  );
  if (!order) throw notFound('Comanda no encontrada');
  return order;
}

/**
 * Confirma la comanda: entra a cocina y se descuentan los ingredientes de
 * cada plato. Para una mesa lo hace el camarero; para un domicilio, quien
 * acepta el pedido en despacho (y se fija la hora estimada de entrega).
 */
export async function confirmOrder(staff: StaffClaims, orderId: string): Promise<OrderDto> {
  const context = await tx(async (db) => {
    const order = await lockOrder(db, staff, orderId);
    if (order.status !== 'PENDING') throw conflict('Esta comanda ya fue procesada', 'ORDER_NOT_PENDING');

    await db.query(`UPDATE orders SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2 WHERE id = $1`, [orderId, staff.sub]);
    await db.query('SELECT fn_deduct_inventory($1, $2)', [orderId, staff.sub]);
    if (order.channel === 'DINE_IN') {
      // El camarero ya pasó por la mesa: los avisos de comensales tardíos quedan atendidos.
      await acknowledgeLateGuests(db, order.table_id!, staff.sub);
    } else {
      await markDeliveryAccepted(db, orderId);
    }
    return refreshContext(db, order);
  });

  await publishContext(staff.rid, context);
  await publishInventoryAlerts(staff.rid);
  return publishOrder(staff.rid, orderId);
}

/**
 * Rechaza una comanda que aún no entró a cocina (pedido sospechoso, error del
 * cliente o domicilio que el restaurante no puede atender).
 */
export async function rejectOrder(staff: StaffClaims, orderId: string, reason = 'Rechazado por el restaurante'): Promise<OrderDto> {
  const context = await tx(async (db) => {
    const order = await lockOrder(db, staff, orderId);
    if (order.status !== 'PENDING') throw conflict('Solo se puede rechazar una comanda que aún no entró a cocina', 'ORDER_NOT_PENDING');
    await cancelOrderRows(db, orderId);
    if (order.channel !== 'DINE_IN') {
      const deliveryId = await deliveryIdForOrder(db, orderId);
      if (deliveryId) await markDeliveryCancelled(db, deliveryId, reason);
    }
    return refreshContext(db, order);
  });

  await publishContext(staff.rid, context);
  return publishOrder(staff.rid, orderId);
}

/** Anula la comanda y sus platos (lo ya descontado del inventario se considera merma). */
export async function cancelOrderRows(db: Db, orderId: string): Promise<void> {
  await db.query(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1 AND status <> 'SERVED'`, [orderId]);
  await db.query(`UPDATE order_items SET status = 'CANCELLED' WHERE order_id = $1 AND status <> 'SERVED'`, [orderId]);
}

/** El estado de la comanda se deduce del estado de sus platos. */
async function syncOrderStatusFromItems(db: Db, orderId: string): Promise<void> {
  await db.query(
    `WITH agg AS (
       SELECT count(*) FILTER (WHERE status <> 'CANCELLED')                AS active,
              count(*) FILTER (WHERE status = 'READY')                     AS ready,
              count(*) FILTER (WHERE status IN ('PREPARING', 'READY'))     AS started
         FROM order_items WHERE order_id = $1
     )
     UPDATE orders o
        SET status = (CASE WHEN agg.active > 0 AND agg.ready = agg.active THEN 'READY'
                           WHEN agg.started > 0 THEN 'PREPARING'
                           ELSE 'CONFIRMED' END)::order_status,
            ready_at = CASE WHEN agg.active > 0 AND agg.ready = agg.active THEN COALESCE(o.ready_at, now()) ELSE NULL END
       FROM agg
      WHERE o.id = $1`,
    [orderId],
  );
}

const KITCHEN_STATES: OrderStatus[] = ['CONFIRMED', 'PREPARING', 'READY'];

/** Cocina cambia el estado de UN plato. */
export async function setItemStatus(staff: StaffClaims, itemId: string, status: 'PENDING' | 'PREPARING' | 'READY'): Promise<OrderDto> {
  const { orderId, context } = await tx(async (db) => {
    const item = await queryOne<{ order_id: string; status: ItemStatus }>(
      `SELECT oi.order_id, oi.status
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = $1 AND o.restaurant_id = $2`,
      [itemId, staff.rid],
      db,
    );
    if (!item) throw notFound('Plato no encontrado');

    const order = await lockOrder(db, staff, item.order_id);
    if (!KITCHEN_STATES.includes(order.status)) throw conflict('Esta comanda ya no está en cocina', 'ORDER_NOT_IN_KITCHEN');
    if (item.status === 'CANCELLED' || item.status === 'SERVED') throw conflict('Este plato ya no se puede modificar', 'ITEM_LOCKED');

    await db.query('UPDATE order_items SET status = $2 WHERE id = $1', [itemId, status]);
    await syncOrderStatusFromItems(db, order.id);
    return { orderId: order.id, context: await refreshContext(db, order) };
  });

  await publishContext(staff.rid, context); // el mapa marca "lista" cuando todo salió; el cliente del domicilio lo ve
  return publishOrder(staff.rid, orderId);
}

/** Cocina mueve la comanda completa de una vez ("empezar todo" / "todo listo"). */
export async function bumpOrder(staff: StaffClaims, orderId: string, status: 'PREPARING' | 'READY'): Promise<OrderDto> {
  const context = await tx(async (db) => {
    const order = await lockOrder(db, staff, orderId);
    if (!KITCHEN_STATES.includes(order.status)) throw conflict('Esta comanda ya no está en cocina', 'ORDER_NOT_IN_KITCHEN');

    // "Empezar todo" no devuelve a preparación lo que ya estaba listo.
    await db.query(
      `UPDATE order_items SET status = $2::order_item_status
        WHERE order_id = $1
          AND status IN ('PENDING', 'PREPARING', 'READY')
          AND NOT ($2::order_item_status = 'PREPARING' AND status = 'READY')`,
      [orderId, status],
    );
    await syncOrderStatusFromItems(db, orderId);
    return refreshContext(db, order);
  });

  await publishContext(staff.rid, context);
  return publishOrder(staff.rid, orderId);
}

/** Sala entrega la comanda en la mesa: si no queda nada pendiente, la mesa pasa a verde. */
export async function serveOrder(staff: StaffClaims, orderId: string): Promise<OrderDto> {
  const context = await tx(async (db) => {
    const order = await lockOrder(db, staff, orderId);
    if (order.channel !== 'DINE_IN') throw conflict('Los domicilios se entregan desde despacho, con el PIN del cliente', 'USE_DISPATCH');
    if (!KITCHEN_STATES.includes(order.status)) throw conflict('Esta comanda no está en curso', 'ORDER_NOT_IN_KITCHEN');
    await markOrderServed(db, orderId);
    return refreshContext(db, order);
  });

  await publishContext(staff.rid, context);
  return publishOrder(staff.rid, orderId);
}

/** La comanda sale de cocina: entregada en la mesa, al repartidor o al cliente que recoge. */
export async function markOrderServed(db: Db, orderId: string): Promise<void> {
  await db.query(`UPDATE order_items SET status = 'SERVED' WHERE order_id = $1 AND status <> 'CANCELLED'`, [orderId]);
  await db.query(`UPDATE orders SET status = 'SERVED', served_at = now(), ready_at = COALESCE(ready_at, now()) WHERE id = $1`, [orderId]);
}

/** Publica una comanda tras cambios hechos fuera de este módulo (despacho). */
export async function publishOrderUpdate(restaurantId: string, orderId: string): Promise<OrderDto> {
  return publishOrder(restaurantId, orderId);
}
