import { pool, query, queryOne, type Db } from '../db/pool.js';
import { estimateTravelMinutes, type Vehicle } from '../geo.js';
import { notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';

/**
 * Estado y vistas de un domicilio. Este módulo no depende de las comandas
 * (orders.service lo usa), así se evitan dependencias circulares.
 */
export type DeliveryStatus = 'PENDING_PAYMENT' | 'PLACED' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'ON_THE_WAY' | 'DELIVERED' | 'CANCELLED';
export const ACTIVE_STATUSES: DeliveryStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY'];

/**
 * Igual que con las mesas, el estado no se asigna a mano: se deriva de las
 * marcas de tiempo del domicilio y del estado de su comanda en cocina.
 */
export async function refreshDeliveryStatus(db: Db, deliveryId: string): Promise<DeliveryStatus | null> {
  const row = await queryOne<{ status: DeliveryStatus }>(
    `UPDATE delivery_orders d
        SET status = (CASE
              WHEN d.cancelled_at IS NOT NULL THEN 'CANCELLED'
              WHEN d.delivered_at IS NOT NULL THEN 'DELIVERED'
              WHEN d.picked_up_at IS NOT NULL THEN 'ON_THE_WAY'
              WHEN o.status = 'READY'          THEN 'READY'
              WHEN o.status = 'PREPARING'      THEN 'PREPARING'
              WHEN o.status = 'CONFIRMED'      THEN 'ACCEPTED'
              WHEN d.placed_at IS NOT NULL     THEN 'PLACED'
              ELSE 'PENDING_PAYMENT'
            END)::delivery_status
       FROM orders o
      WHERE o.id = d.order_id AND d.id = $1
      RETURNING d.status`,
    [deliveryId],
    db,
  );
  return row?.status ?? null;
}

export async function deliveryIdForOrder(db: Db, orderId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>('SELECT id FROM delivery_orders WHERE order_id = $1', [orderId], db);
  return row?.id ?? null;
}

/** Al aceptar el pedido, se fija la hora estimada de entrega: preparación + trayecto de la zona. */
export async function markDeliveryAccepted(db: Db, orderId: string): Promise<void> {
  await db.query(
    `UPDATE delivery_orders d
        SET accepted_at = now(),
            estimated_at = now() + make_interval(mins => r.delivery_prep_minutes
                                   + COALESCE((SELECT z.travel_minutes FROM delivery_zones z WHERE z.id = d.zone_id), 0))
       FROM restaurants r
      WHERE d.order_id = $1 AND r.id = d.restaurant_id`,
    [orderId],
  );
}

/** Cancela el domicilio; si ya se había pagado en línea, queda marcado para reembolso. */
export async function markDeliveryCancelled(db: Db, deliveryId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE delivery_orders SET cancelled_at = now(), cancel_reason = $2, refund_pending = (paid_at IS NOT NULL AND payment_method = 'ONLINE')
      WHERE id = $1 AND cancelled_at IS NULL AND delivered_at IS NULL`,
    [deliveryId, reason],
  );
}

// ----------------------------------------------------------------------------
// Vistas
// ----------------------------------------------------------------------------
export interface CourierSummary {
  id: string;
  name: string;
  phone: string;
  vehicle: Vehicle;
  plate: string | null;
  lat: number | null;
  lng: number | null;
  lastSeenAt: string | null;
}

/** Vista para el personal (despacho y repartidores). No incluye el PIN de entrega. */
export interface DeliveryDto {
  id: string;
  code: string; // D-2001
  orderId: string;
  orderNumber: number;
  type: 'DELIVERY' | 'PICKUP';
  status: DeliveryStatus;
  createdAt: string;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  estimatedAt: string | null;
  customerName: string;
  customerPhone: string;
  addressLine: string | null;
  addressDetails: string | null;
  addressNotes: string | null;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  zoneName: string | null;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: 'CASH' | 'CARD_ON_DELIVERY' | 'ONLINE';
  paid: boolean;
  refundPending: boolean;
  courier: CourierSummary | null;
  items: Array<{ name: string; quantity: number; unitPrice: number; notes: string; status: string }>;
}

const DELIVERY_SELECT = `
  SELECT d.id, 'D-' || d.code AS code, d.order_id AS "orderId", o.order_number AS "orderNumber", d.type, d.status,
         d.created_at AS "createdAt", d.placed_at AS "placedAt", d.accepted_at AS "acceptedAt", o.ready_at AS "readyAt",
         d.picked_up_at AS "pickedUpAt", d.delivered_at AS "deliveredAt", d.cancelled_at AS "cancelledAt",
         d.cancel_reason AS "cancelReason", d.estimated_at AS "estimatedAt",
         d.customer_name AS "customerName", d.customer_phone AS "customerPhone",
         d.address_line AS "addressLine", d.address_details AS "addressDetails", d.address_notes AS "addressNotes",
         d.lat, d.lng, d.distance_km AS "distanceKm", z.name AS "zoneName",
         d.subtotal, d.delivery_fee AS "deliveryFee", d.total, d.payment_method AS "paymentMethod",
         d.paid_at IS NOT NULL AS paid, d.refund_pending AS "refundPending",
         CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object(
           'id', u.id, 'name', u.full_name, 'phone', cp.phone, 'vehicle', cp.vehicle, 'plate', cp.plate,
           'lat', cp.last_lat, 'lng', cp.last_lng, 'lastSeenAt', cp.last_seen_at) END AS courier,
         COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'quantity', oi.quantity, 'unitPrice', oi.unit_price,
                                                     'notes', oi.notes, 'status', oi.status) ORDER BY oi.product_name)
                     FROM order_items oi WHERE oi.order_id = o.id), '[]'::json) AS items
    FROM delivery_orders d
    JOIN orders o ON o.id = d.order_id
    LEFT JOIN delivery_zones z ON z.id = d.zone_id
    LEFT JOIN users u ON u.id = d.courier_id
    LEFT JOIN courier_profiles cp ON cp.user_id = u.id`;

export async function getDelivery(restaurantId: string, deliveryId: string, db: Db = pool): Promise<DeliveryDto> {
  const row = await queryOne<DeliveryDto>(`${DELIVERY_SELECT} WHERE d.restaurant_id = $1 AND d.id = $2`, [restaurantId, deliveryId], db);
  if (!row) throw notFound('Pedido no encontrado');
  return row;
}

/** Tablero de despacho: activos + lo terminado hoy (hora del restaurante). */
export function listBoardDeliveries(restaurantId: string): Promise<DeliveryDto[]> {
  return query<DeliveryDto>(
    `${DELIVERY_SELECT}
      JOIN restaurants r ON r.id = d.restaurant_id
     WHERE d.restaurant_id = $1
       AND (d.status IN ('PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY')
            OR d.created_at >= date_trunc('day', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone)
     ORDER BY d.created_at DESC`,
    [restaurantId],
  );
}

/** Para el repartidor: lo suyo en curso y lo que está disponible para tomar. */
export function listCourierDeliveries(restaurantId: string, courierId: string): Promise<DeliveryDto[]> {
  return query<DeliveryDto>(
    `${DELIVERY_SELECT}
     WHERE d.restaurant_id = $1 AND d.type = 'DELIVERY'
       AND ((d.courier_id = $2 AND d.status IN ('ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY'))
            OR (d.courier_id IS NULL AND d.status IN ('ACCEPTED', 'PREPARING', 'READY')))
     ORDER BY (d.courier_id = $2) DESC NULLS LAST, d.accepted_at`,
    [restaurantId, courierId],
  );
}

export interface CourierDto extends CourierSummary {
  isAvailable: boolean;
  active: number; // entregas en curso
  deliveredToday: number;
}

export function listCouriers(restaurantId: string): Promise<CourierDto[]> {
  return query<CourierDto>(
    `SELECT u.id, u.full_name AS name, cp.phone, cp.vehicle, cp.plate, cp.last_lat AS lat, cp.last_lng AS lng,
            cp.last_seen_at AS "lastSeenAt", cp.is_available AS "isAvailable",
            (SELECT count(*) FROM delivery_orders d WHERE d.courier_id = u.id AND d.status IN ('ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY')) AS active,
            (SELECT count(*) FROM delivery_orders d WHERE d.courier_id = u.id AND d.delivered_at >= date_trunc('day', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone) AS "deliveredToday"
       FROM users u
       JOIN courier_profiles cp ON cp.user_id = u.id
       JOIN restaurants r ON r.id = u.restaurant_id
      WHERE u.restaurant_id = $1 AND u.is_active
      ORDER BY cp.is_available DESC, u.full_name`,
    [restaurantId],
  );
}

/** Vista pública del seguimiento (quien tiene el código de seguimiento es el cliente). Incluye el PIN. */
export interface TrackingDto {
  code: string;
  type: 'DELIVERY' | 'PICKUP';
  status: DeliveryStatus;
  trackingCode: string;
  pin: string;
  createdAt: string;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  estimatedAt: string | null;
  etaMinutes: number | null;
  customerName: string;
  addressLine: string | null;
  addressDetails: string | null;
  lat: number | null;
  lng: number | null;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: 'CASH' | 'CARD_ON_DELIVERY' | 'ONLINE';
  paid: boolean;
  refundPending: boolean;
  items: Array<{ name: string; quantity: number; unitPrice: number; notes: string }>;
  restaurant: { name: string; address: string | null; phone: string | null; lat: number | null; lng: number | null; currency: string };
  courier: { name: string; vehicle: Vehicle; plate: string | null; phone: string; lat: number | null; lng: number | null; lastSeenAt: string | null } | null;
  track: Array<[number, number]>;
}

export async function getTracking(trackingCode: string): Promise<TrackingDto> {
  const row = await queryOne<TrackingDto & { id: string }>(
    `SELECT d.id, 'D-' || d.code AS code, d.type, d.status, d.tracking_code AS "trackingCode", d.delivery_pin AS pin,
            d.created_at AS "createdAt", d.placed_at AS "placedAt", d.accepted_at AS "acceptedAt", o.ready_at AS "readyAt",
            d.picked_up_at AS "pickedUpAt", d.delivered_at AS "deliveredAt", d.cancelled_at AS "cancelledAt",
            d.cancel_reason AS "cancelReason", d.estimated_at AS "estimatedAt",
            d.customer_name AS "customerName", d.address_line AS "addressLine", d.address_details AS "addressDetails",
            d.lat, d.lng, d.subtotal, d.delivery_fee AS "deliveryFee", d.total, d.payment_method AS "paymentMethod",
            d.paid_at IS NOT NULL AS paid, d.refund_pending AS "refundPending",
            COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'quantity', oi.quantity, 'unitPrice', oi.unit_price, 'notes', oi.notes)
                                      ORDER BY oi.product_name)
                        FROM order_items oi WHERE oi.order_id = o.id AND oi.status <> 'CANCELLED'), '[]'::json) AS items,
            json_build_object('name', r.name, 'address', r.address, 'phone', r.phone, 'lat', r.lat, 'lng', r.lng, 'currency', r.currency) AS restaurant,
            CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object(
              'name', split_part(u.full_name, ' ', 1), 'vehicle', cp.vehicle, 'plate', cp.plate, 'phone', cp.phone,
              'lat', cp.last_lat, 'lng', cp.last_lng, 'lastSeenAt', cp.last_seen_at) END AS courier,
            COALESCE((SELECT json_agg(json_build_array(t.lat, t.lng) ORDER BY t.recorded_at)
                        FROM delivery_tracks t WHERE t.delivery_order_id = d.id), '[]'::json) AS track
       FROM delivery_orders d
       JOIN orders o ON o.id = d.order_id
       JOIN restaurants r ON r.id = d.restaurant_id
       LEFT JOIN users u ON u.id = d.courier_id
       LEFT JOIN courier_profiles cp ON cp.user_id = u.id
      WHERE d.tracking_code = $1`,
    [trackingCode],
  );
  if (!row) throw notFound('No encontramos ese pedido. Revisa el enlace de seguimiento.');
  const { id: _id, ...tracking } = row;
  return { ...tracking, track: tracking.track.map(([lat, lng]) => [Number(lat), Number(lng)]), etaMinutes: etaFor(tracking) };
}

/** Minutos que faltan: en camino, por la posición del repartidor; antes, por la hora estimada. */
function etaFor(t: Pick<TrackingDto, 'status' | 'courier' | 'lat' | 'lng' | 'estimatedAt'>): number | null {
  if (t.status === 'ON_THE_WAY' && t.courier?.lat != null && t.lat != null && t.lng != null) {
    return estimateTravelMinutes({ lat: Number(t.courier.lat), lng: Number(t.courier.lng!) }, { lat: Number(t.lat), lng: Number(t.lng) }, t.courier.vehicle);
  }
  if (t.estimatedAt && ['ACCEPTED', 'PREPARING', 'READY'].includes(t.status)) {
    return Math.max(1, Math.round((new Date(t.estimatedAt).getTime() - Date.now()) / 60_000));
  }
  return null;
}

/**
 * Difunde un domicilio después de un cambio (tras el COMMIT): el tablero de
 * despacho y los repartidores reciben la vista del personal; el cliente que
 * sigue el pedido, la vista pública.
 */
export async function publishDelivery(restaurantId: string, deliveryId: string): Promise<DeliveryDto> {
  const delivery = await getDelivery(restaurantId, deliveryId);
  emit([rooms.staff(restaurantId), rooms.couriers(restaurantId)], 'delivery:updated', delivery);
  const code = await queryOne<{ tracking_code: string }>('SELECT tracking_code FROM delivery_orders WHERE id = $1', [deliveryId]);
  emit(rooms.delivery(deliveryId), 'delivery:updated', await getTracking(code!.tracking_code));
  return delivery;
}
