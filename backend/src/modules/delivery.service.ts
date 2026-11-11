import crypto from 'node:crypto';
import { z } from 'zod';
import type { StaffClaims } from '../auth/tokens.js';
import { config } from '../config.js';
import { pool, query, queryOne, tx, type Db } from '../db/pool.js';
import { distanceKm, estimateTravelMinutes, type LatLng } from '../geo.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http.js';
import { availableChannels, type PaymentChannel } from '../payments/gateways.js';
import { checkout, insertIntent } from '../payments/payments.service.js';
import { emit, rooms } from '../realtime/bus.js';
import { computeTotals, issueInvoice } from './billing.service.js';
import {
  getDelivery,
  getTracking,
  listBoardDeliveries,
  listCourierDeliveries,
  listCouriers,
  markDeliveryCancelled,
  publishDelivery,
  refreshDeliveryStatus,
  type DeliveryDto,
} from './delivery.status.js';
import { cancelOrderRows, confirmOrder, markOrderServed, publishOrderUpdate, rejectOrder } from './orders.service.js';
import { getPublicRestaurant, getRestaurant, type Restaurant } from './restaurant.js';

/**
 * Domicilios y pedidos para recoger.
 *
 *   Cliente     arma el pedido en /domicilios, paga (en línea o al recibir) y
 *               lo sigue en /pedido/<código> con el mapa y el estado en vivo.
 *   Despacho    (Admin y Sala) acepta, asigna repartidor, ve todo en un mapa.
 *   Repartidor  toma o recibe entregas, comparte su ubicación, recoge y
 *               entrega con el PIN que le dicta el cliente.
 *   Cocina      no cambia nada: el domicilio es una comanda más de su cola.
 */

// ----------------------------------------------------------------------------
// Configuración pública y cotización
// ----------------------------------------------------------------------------
interface ZoneRow {
  id: string;
  name: string;
  maxKm: number;
  fee: number;
  travelMinutes: number;
}

const listZones = (restaurantId: string, db: Db = pool) =>
  query<ZoneRow>(
    `SELECT id, name, max_km AS "maxKm", fee, travel_minutes AS "travelMinutes" FROM delivery_zones WHERE restaurant_id = $1 ORDER BY max_km`,
    [restaurantId],
    db,
  );

export async function getPublicDeliveryConfig() {
  const restaurant = await getPublicRestaurant();
  return {
    restaurant: {
      name: restaurant.name,
      address: restaurant.address,
      phone: restaurant.phone,
      lat: restaurant.lat,
      lng: restaurant.lng,
      currency: restaurant.currency,
      taxName: restaurant.taxName,
      taxRate: restaurant.taxRate,
      pricesIncludeTax: restaurant.pricesIncludeTax,
      deliveryEnabled: restaurant.deliveryEnabled && restaurant.lat !== null,
      pickupEnabled: restaurant.pickupEnabled,
      minOrder: restaurant.deliveryMinOrder,
      prepMinutes: restaurant.deliveryPrepMinutes,
    },
    zones: (await listZones(restaurant.id)).map(({ id: _id, ...zone }) => zone),
    payments: availableChannels(),
    map: config.map,
  };
}

export interface Quote {
  inCoverage: boolean;
  distanceKm: number;
  zone: ZoneRow | null;
  fee: number;
  etaMinutes: number; // preparación + trayecto
  maxKm: number;
}

async function quoteFor(restaurant: Restaurant, point: LatLng, db: Db = pool): Promise<Quote> {
  if (restaurant.lat === null || restaurant.lng === null) throw conflict('El restaurante aún no tiene ubicación configurada', 'NO_LOCATION');
  const zones = await listZones(restaurant.id, db);
  const km = Math.round(distanceKm({ lat: Number(restaurant.lat), lng: Number(restaurant.lng) }, point) * 100) / 100;
  const zone = zones.find((z) => km <= Number(z.maxKm)) ?? null;
  return {
    inCoverage: zone !== null,
    distanceKm: km,
    zone,
    fee: zone ? Number(zone.fee) : 0,
    etaMinutes: restaurant.deliveryPrepMinutes + (zone?.travelMinutes ?? 0),
    maxKm: zones.length ? Number(zones[zones.length - 1].maxKm) : 0,
  };
}

export async function quoteDelivery(point: LatLng): Promise<Quote> {
  return quoteFor(await getPublicRestaurant(), point);
}

// ----------------------------------------------------------------------------
// Crear un pedido (cliente)
// ----------------------------------------------------------------------------
export const createDeliverySchema = z
  .object({
    type: z.enum(['DELIVERY', 'PICKUP']),
    items: z
      .array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(50), notes: z.string().trim().max(200).default('') }))
      .min(1)
      .max(40),
    customer: z.object({
      name: z.string().trim().min(2).max(80),
      phone: z.string().trim().regex(/^[+\d][\d\s-]{6,19}$/, 'Teléfono inválido'),
      email: z.string().trim().email().max(200).optional().or(z.literal('')),
    }),
    address: z
      .object({
        line: z.string().trim().min(5).max(160),
        details: z.string().trim().max(120).default(''),
        notes: z.string().trim().max(200).default(''),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .optional(),
    payment: z.enum(['CASH', 'CARD_ON_DELIVERY', 'WOMPI', 'MERCADOPAGO', 'PSE']),
  })
  .refine((d) => d.type === 'PICKUP' || d.address, { message: 'Indica la dirección de entrega', path: ['address'] });
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;

// Código de seguimiento: 10 caracteres sin letras que se confundan (0/O, 1/I).
const TRACKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newTrackingCode = () => Array.from(crypto.randomBytes(10), (b) => TRACKING_ALPHABET[b % TRACKING_ALPHABET.length]).join('');
const newPin = () => String(crypto.randomInt(0, 10_000)).padStart(4, '0');

export async function createDeliveryOrder(input: CreateDeliveryInput, baseUrl: string) {
  const restaurant = await getPublicRestaurant();
  if (input.type === 'DELIVERY' && !restaurant.deliveryEnabled) throw conflict('Por ahora no estamos recibiendo domicilios', 'DELIVERY_CLOSED');
  if (input.type === 'PICKUP' && !restaurant.pickupEnabled) throw conflict('Por ahora no estamos recibiendo pedidos para recoger', 'PICKUP_CLOSED');
  const online = ['WOMPI', 'MERCADOPAGO', 'PSE'].includes(input.payment);

  const created = await tx(async (db) => {
    // Precios y disponibilidad salen de la base de datos, nunca del navegador.
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const products = await query<{ id: string; name: string; price: number; available: boolean }>(
      `SELECT id, name, price, (is_available AND deleted_at IS NULL) AS available FROM products WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
      [restaurant.id, ids],
      db,
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = input.items.filter((i) => !byId.get(i.productId)?.available).map((i) => byId.get(i.productId)?.name ?? 'un plato');
    if (missing.length) throw conflict(`Se agotó: ${[...new Set(missing)].join(', ')}. Quítalo del pedido para continuar.`, 'PRODUCT_UNAVAILABLE');

    const subtotal = input.items.reduce((sum, i) => sum + Number(byId.get(i.productId)!.price) * i.quantity, 0);
    if (input.type === 'DELIVERY' && subtotal < Number(restaurant.deliveryMinOrder)) {
      throw conflict(`El pedido mínimo para domicilio es de $${Number(restaurant.deliveryMinOrder).toLocaleString('es-CO')}`, 'BELOW_MINIMUM');
    }

    let quote: Quote | null = null;
    if (input.type === 'DELIVERY') {
      quote = await quoteFor(restaurant, { lat: input.address!.lat, lng: input.address!.lng }, db);
      if (!quote.inCoverage) throw conflict(`Esa dirección está fuera de nuestra zona de entrega (hasta ${quote.maxKm} km)`, 'OUT_OF_COVERAGE');
    }

    const order = await queryOne<{ id: string }>(
      `INSERT INTO orders (restaurant_id, channel) VALUES ($1, $2) RETURNING id`,
      [restaurant.id, input.type],
      db,
    );
    for (const item of input.items) {
      const product = byId.get(item.productId)!;
      await db.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, notes, guest_alias) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order!.id, product.id, product.name, product.price, item.quantity, item.notes, input.customer.name],
      );
    }

    const fee = quote?.fee ?? 0;
    const delivery = await queryOne<{ id: string; tracking_code: string; code: number }>(
      `INSERT INTO delivery_orders (restaurant_id, order_id, type, status, tracking_code, delivery_pin, customer_name, customer_phone,
                                    customer_email, address_line, address_details, address_notes, lat, lng, distance_km, zone_id,
                                    subtotal, delivery_fee, total, payment_method, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING id, tracking_code, code`,
      [
        restaurant.id, order!.id, input.type, online ? 'PENDING_PAYMENT' : 'PLACED', newTrackingCode(), newPin(),
        input.customer.name, input.customer.phone, input.customer.email || null,
        input.address?.line ?? null, input.address?.details || null, input.address?.notes || null,
        input.address?.lat ?? null, input.address?.lng ?? null, quote?.distanceKm ?? null, quote?.zone?.id ?? null,
        subtotal, fee, subtotal + fee, online ? 'ONLINE' : input.payment,
        // Con pago en línea, el restaurante lo ve cuando el pago se aprueba.
        online ? null : new Date(),
      ],
      db,
    );

    const intent = online
      ? await insertIntent(db, {
          restaurantId: restaurant.id,
          purpose: 'DELIVERY',
          deliveryOrderId: delivery!.id,
          channel: input.payment as PaymentChannel,
          amount: subtotal + fee,
          currency: restaurant.currency,
          description: `Pedido D-${delivery!.code} · ${restaurant.name}`,
          customer: input.customer,
          baseUrl,
        })
      : null;
    return { deliveryId: delivery!.id, trackingCode: delivery!.tracking_code, code: delivery!.code, intent };
  });

  if (!created.intent) {
    await publishDelivery(restaurant.id, created.deliveryId);
    emit(rooms.staff(restaurant.id), 'delivery:new', { code: `D-${created.code}`, type: input.type });
    return { trackingCode: created.trackingCode, checkoutUrl: null };
  }
  // Si la pasarela falla, el pedido queda "pendiente de pago" y desde el seguimiento se puede reintentar.
  try {
    const checkoutUrl = await checkout(created.intent, {
      description: `Pedido D-${created.code} · ${restaurant.name}`,
      customer: input.customer,
      baseUrl,
    });
    return { trackingCode: created.trackingCode, checkoutUrl };
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(err.status, err.code, err.message, { trackingCode: created.trackingCode });
    throw err;
  }
}

/** Reintentar el pago en línea desde la página de seguimiento. */
export async function retryDeliveryPayment(trackingCode: string, channel: PaymentChannel, baseUrl: string) {
  const restaurant = await getPublicRestaurant();
  const intent = await tx(async (db) => {
    const delivery = await queryOne<{ id: string; code: number; status: string; total: number; customer_name: string; customer_email: string | null; customer_phone: string }>(
      'SELECT id, code, status, total, customer_name, customer_email, customer_phone FROM delivery_orders WHERE tracking_code = $1 FOR UPDATE',
      [trackingCode],
      db,
    );
    if (!delivery) throw notFound('No encontramos ese pedido');
    if (delivery.status !== 'PENDING_PAYMENT') throw conflict('Este pedido ya no está esperando el pago', 'NOT_PENDING_PAYMENT');
    await db.query(`UPDATE payment_intents SET status = 'EXPIRED', completed_at = now() WHERE delivery_order_id = $1 AND status = 'PENDING'`, [delivery.id]);
    return insertIntent(db, {
      restaurantId: restaurant.id,
      purpose: 'DELIVERY',
      deliveryOrderId: delivery.id,
      channel,
      amount: Number(delivery.total),
      currency: restaurant.currency,
      description: `Pedido D-${delivery.code} · ${restaurant.name}`,
      customer: { name: delivery.customer_name, email: delivery.customer_email ?? undefined, phone: delivery.customer_phone },
      baseUrl,
    });
  });
  const checkoutUrl = await checkout(intent, { description: `Pedido · ${restaurant.name}`, customer: {}, baseUrl });
  return { checkoutUrl };
}

/** El cliente cancela antes de que el restaurante acepte. */
export async function cancelByCustomer(trackingCode: string) {
  const delivery = await queryOne<{ id: string; restaurant_id: string; order_id: string; status: string }>(
    'SELECT id, restaurant_id, order_id, status FROM delivery_orders WHERE tracking_code = $1',
    [trackingCode],
  );
  if (!delivery) throw notFound('No encontramos ese pedido');
  if (!['PENDING_PAYMENT', 'PLACED'].includes(delivery.status)) {
    throw conflict('El restaurante ya aceptó tu pedido. Para cancelarlo, llámanos.', 'ALREADY_ACCEPTED');
  }
  await tx(async (db) => {
    await cancelOrderRows(db, delivery.order_id);
    await markDeliveryCancelled(db, delivery.id, 'Cancelado por el cliente');
    await db.query(`UPDATE payment_intents SET status = 'EXPIRED', completed_at = now() WHERE delivery_order_id = $1 AND status = 'PENDING'`, [delivery.id]);
    await refreshDeliveryStatus(db, delivery.id);
  });
  await publishDelivery(delivery.restaurant_id, delivery.id);
  return getTracking(trackingCode);
}

// ----------------------------------------------------------------------------
// Despacho (Admin y Sala)
// ----------------------------------------------------------------------------
export async function getBoard(restaurantId: string) {
  const restaurant = await getRestaurant(restaurantId);
  const [deliveries, couriers] = await Promise.all([listBoardDeliveries(restaurantId), listCouriers(restaurantId)]);
  return {
    restaurant: { name: restaurant.name, lat: restaurant.lat, lng: restaurant.lng, address: restaurant.address, currency: restaurant.currency },
    deliveries,
    couriers,
    map: config.map,
  };
}

async function lockDelivery(db: Db, restaurantId: string, deliveryId: string) {
  const row = await queryOne<{
    id: string; order_id: string; type: 'DELIVERY' | 'PICKUP'; status: string; courier_id: string | null; delivery_pin: string;
    payment_method: 'CASH' | 'CARD_ON_DELIVERY' | 'ONLINE'; paid_at: Date | null; subtotal: number; delivery_fee: number;
    customer_name: string; customer_email: string | null;
  }>('SELECT * FROM delivery_orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [deliveryId, restaurantId], db);
  if (!row) throw notFound('Pedido no encontrado');
  return row;
}

export async function acceptDelivery(staff: StaffClaims, deliveryId: string): Promise<DeliveryDto> {
  const delivery = await getDelivery(staff.rid, deliveryId);
  if (delivery.status !== 'PLACED') throw conflict('Este pedido no está esperando aceptación', 'NOT_PLACED');
  await confirmOrder(staff, delivery.orderId); // entra a cocina, descuenta inventario, fija la hora estimada
  return getDelivery(staff.rid, deliveryId);
}

/** Rechazar o cancelar. Antes de que salga del restaurante; si se pagó en línea queda para reembolso. */
export async function cancelDelivery(staff: StaffClaims, deliveryId: string, reason: string): Promise<DeliveryDto> {
  const current = await getDelivery(staff.rid, deliveryId);
  if (current.status === 'PLACED') {
    await rejectOrder(staff, current.orderId, reason);
    return getDelivery(staff.rid, deliveryId);
  }
  if (!['ACCEPTED', 'PREPARING', 'READY'].includes(current.status)) {
    throw conflict('Este pedido ya salió o ya terminó: no se puede cancelar', 'CANNOT_CANCEL');
  }
  await tx(async (db) => {
    await lockDelivery(db, staff.rid, deliveryId);
    await cancelOrderRows(db, current.orderId);
    await markDeliveryCancelled(db, deliveryId, reason);
    await refreshDeliveryStatus(db, deliveryId);
  });
  await publishOrderUpdate(staff.rid, current.orderId); // sale de la pantalla de cocina
  return publishDelivery(staff.rid, deliveryId);
}

async function assertCourier(db: Db, restaurantId: string, courierId: string) {
  const courier = await queryOne<{ is_available: boolean }>(
    `SELECT cp.is_available FROM users u JOIN courier_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 AND u.restaurant_id = $2 AND u.role = 'COURIER' AND u.is_active`,
    [courierId, restaurantId],
    db,
  );
  if (!courier) throw notFound('Repartidor no encontrado');
  return courier;
}

export async function assignCourier(staff: StaffClaims, deliveryId: string, courierId: string | null): Promise<DeliveryDto> {
  const previous = await tx(async (db) => {
    const delivery = await lockDelivery(db, staff.rid, deliveryId);
    if (delivery.type !== 'DELIVERY') throw conflict('Los pedidos para recoger no llevan repartidor', 'PICKUP_ORDER');
    if (!['PLACED', 'ACCEPTED', 'PREPARING', 'READY'].includes(delivery.status)) {
      throw conflict('Ya no se puede cambiar el repartidor de este pedido', 'CANNOT_ASSIGN');
    }
    if (courierId) await assertCourier(db, staff.rid, courierId);
    await db.query('UPDATE delivery_orders SET courier_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END WHERE id = $1', [deliveryId, courierId]);
    return delivery.courier_id;
  });
  const result = await publishDelivery(staff.rid, deliveryId);
  if (courierId) emit(rooms.courier(courierId), 'delivery:assigned', { code: result.code });
  if (previous && previous !== courierId) emit(rooms.courier(previous), 'delivery:unassigned', { code: result.code });
  await publishCouriers(staff.rid);
  return result;
}

// ----------------------------------------------------------------------------
// Entrega con PIN (repartidor o mostrador para pedidos para recoger)
// ----------------------------------------------------------------------------
// Freno contra adivinar el PIN: 5 intentos fallidos bloquean ese pedido 5 minutos.
const pinFailures = new Map<string, { count: number; until: number }>();

function checkPin(deliveryId: string, expected: string, given: string) {
  const now = Date.now();
  const state = pinFailures.get(deliveryId) ?? { count: 0, until: 0 };
  if (state.until > now) throw new HttpError(429, 'PIN_LOCKED', 'Demasiados intentos. Espera unos minutos o llama al restaurante.');
  if (state.until !== 0) Object.assign(state, { count: 0, until: 0 }); // el bloqueo ya venció

  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (ok) {
    pinFailures.delete(deliveryId);
    return;
  }
  state.count += 1;
  if (state.count >= 5) state.until = now + 5 * 60_000;
  pinFailures.set(deliveryId, state);
  throw badRequest(state.count >= 5 ? 'El PIN no coincide. Pedido bloqueado 5 minutos.' : 'El PIN no coincide', 'WRONG_PIN');
}

/** Factura el pedido pagado al recibir (efectivo o datáfono) dentro de la transacción de entrega. */
async function invoiceOnDelivery(db: Db, restaurantId: string, delivery: Awaited<ReturnType<typeof lockDelivery>>, receivedBy: string, amountReceived?: number) {
  if (delivery.paid_at) return;
  const restaurant = await getRestaurant(restaurantId);
  const totals = computeTotals(restaurant, Number(delivery.subtotal), 0, Number(delivery.delivery_fee));
  const cash = delivery.payment_method === 'CASH';
  const received = cash ? Math.max(amountReceived ?? totals.grandTotal, totals.grandTotal) : totals.grandTotal;
  await issueInvoice(db, restaurant, {
    target: { deliveryOrderId: delivery.id },
    totals,
    customer: { name: delivery.customer_name, email: delivery.customer_email ?? undefined },
    payment: {
      method: cash ? 'CASH' : 'CARD',
      amountReceived: received,
      changeDue: received - totals.grandTotal,
      reference: `ENT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      provider: 'POS',
      validatedBy: receivedBy,
    },
  });
  await db.query('UPDATE delivery_orders SET paid_at = now() WHERE id = $1', [delivery.id]);
}

/** Mostrador: el cliente recoge su pedido y dicta el PIN. */
export async function handOverPickup(staff: StaffClaims, deliveryId: string, pin: string, amountReceived?: number): Promise<DeliveryDto> {
  const orderId = await tx(async (db) => {
    const delivery = await lockDelivery(db, staff.rid, deliveryId);
    if (delivery.type !== 'PICKUP') throw conflict('Los domicilios los entrega el repartidor', 'NOT_PICKUP');
    if (delivery.status !== 'READY') throw conflict('El pedido aún no está listo', 'NOT_READY');
    checkPin(deliveryId, delivery.delivery_pin, pin);
    await invoiceOnDelivery(db, staff.rid, delivery, staff.sub, amountReceived);
    await markOrderServed(db, delivery.order_id);
    await db.query('UPDATE delivery_orders SET picked_up_at = now(), delivered_at = now() WHERE id = $1', [deliveryId]);
    await refreshDeliveryStatus(db, deliveryId);
    return delivery.order_id;
  });
  await publishOrderUpdate(staff.rid, orderId);
  emit(rooms.staff(staff.rid), 'invoice:issued', {});
  return publishDelivery(staff.rid, deliveryId);
}

// ----------------------------------------------------------------------------
// Repartidor
// ----------------------------------------------------------------------------
export async function getCourierHome(courier: StaffClaims) {
  const [profile, deliveries, restaurant] = await Promise.all([
    queryOne(
      `SELECT u.id, u.full_name AS name, cp.phone, cp.vehicle, cp.plate, cp.is_available AS "isAvailable",
              cp.last_lat AS lat, cp.last_lng AS lng, cp.last_seen_at AS "lastSeenAt",
              (SELECT count(*) FROM delivery_orders d JOIN restaurants r ON r.id = d.restaurant_id
                WHERE d.courier_id = u.id AND d.delivered_at >= date_trunc('day', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone) AS "deliveredToday"
         FROM users u JOIN courier_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
      [courier.sub],
    ),
    listCourierDeliveries(courier.rid, courier.sub),
    getRestaurant(courier.rid),
  ]);
  if (!profile) throw forbidden('Tu usuario no tiene perfil de repartidor. Pide al administrador que lo cree.');
  return {
    profile,
    deliveries,
    restaurant: { name: restaurant.name, lat: restaurant.lat, lng: restaurant.lng, address: restaurant.address, phone: restaurant.phone, currency: restaurant.currency },
    map: config.map,
  };
}

async function publishCouriers(restaurantId: string) {
  emit(rooms.staff(restaurantId), 'couriers:updated', await listCouriers(restaurantId));
}

export async function setAvailability(courier: StaffClaims, isAvailable: boolean) {
  await query('UPDATE courier_profiles SET is_available = $2 WHERE user_id = $1', [courier.sub, isAvailable]);
  await publishCouriers(courier.rid);
  return getCourierHome(courier);
}

/** El repartidor toma un pedido disponible (el primero que lo toma, se lo queda). */
export async function takeDelivery(courier: StaffClaims, deliveryId: string): Promise<DeliveryDto> {
  await tx(async (db) => {
    const delivery = await lockDelivery(db, courier.rid, deliveryId);
    const me = await assertCourier(db, courier.rid, courier.sub);
    if (!me.is_available) throw conflict('Activa "En turno" para tomar pedidos', 'NOT_AVAILABLE');
    if (delivery.type !== 'DELIVERY' || !['ACCEPTED', 'PREPARING', 'READY'].includes(delivery.status)) {
      throw conflict('Este pedido ya no está disponible', 'NOT_AVAILABLE_ORDER');
    }
    if (delivery.courier_id && delivery.courier_id !== courier.sub) throw conflict('Otro repartidor ya tomó este pedido', 'ALREADY_TAKEN');
    await db.query('UPDATE delivery_orders SET courier_id = $2, assigned_at = now() WHERE id = $1', [deliveryId, courier.sub]);
  });
  await publishCouriers(courier.rid);
  return publishDelivery(courier.rid, deliveryId);
}

export async function pickUpDelivery(courier: StaffClaims, deliveryId: string): Promise<DeliveryDto> {
  const orderId = await tx(async (db) => {
    const delivery = await lockDelivery(db, courier.rid, deliveryId);
    if (delivery.courier_id !== courier.sub) throw forbidden('Este pedido no está asignado a ti');
    if (delivery.status !== 'READY') throw conflict('La cocina aún no lo ha marcado como listo', 'NOT_READY');
    await markOrderServed(db, delivery.order_id);
    await db.query('UPDATE delivery_orders SET picked_up_at = now() WHERE id = $1', [deliveryId]);
    // Punto de partida del recorrido: donde está el repartidor (o el restaurante).
    await db.query(
      `INSERT INTO delivery_tracks (delivery_order_id, lat, lng)
       SELECT $1, COALESCE(cp.last_lat, r.lat), COALESCE(cp.last_lng, r.lng)
         FROM courier_profiles cp, restaurants r
        WHERE cp.user_id = $2 AND r.id = $3 AND COALESCE(cp.last_lat, r.lat) IS NOT NULL`,
      [deliveryId, courier.sub, courier.rid],
    );
    await refreshDeliveryStatus(db, deliveryId);
    return delivery.order_id;
  });
  await publishOrderUpdate(courier.rid, orderId);
  return publishDelivery(courier.rid, deliveryId);
}

export async function completeDelivery(courier: StaffClaims, deliveryId: string, pin: string, amountReceived?: number): Promise<DeliveryDto> {
  await tx(async (db) => {
    const delivery = await lockDelivery(db, courier.rid, deliveryId);
    if (delivery.courier_id !== courier.sub) throw forbidden('Este pedido no está asignado a ti');
    if (delivery.status !== 'ON_THE_WAY') throw conflict('Primero marca el pedido como recogido', 'NOT_ON_THE_WAY');
    checkPin(deliveryId, delivery.delivery_pin, pin);
    await invoiceOnDelivery(db, courier.rid, delivery, courier.sub, amountReceived);
    await db.query('UPDATE delivery_orders SET delivered_at = now() WHERE id = $1', [deliveryId]);
    await refreshDeliveryStatus(db, deliveryId);
  });
  emit(rooms.staff(courier.rid), 'invoice:issued', {});
  await publishCouriers(courier.rid);
  return publishDelivery(courier.rid, deliveryId);
}

// Throttle por repartidor: se guarda un punto de recorrido cada 20 s o 25 m.
const lastTrackPoint = new Map<string, { at: number; lat: number; lng: number }>();

/**
 * Ubicación del repartidor (por WebSocket desde su celular). Se guarda en su
 * perfil, se agrega al recorrido de sus entregas en camino y se difunde al
 * mapa de despacho y al cliente que espera.
 */
export async function updateCourierLocation(courier: StaffClaims, point: LatLng & { heading?: number }) {
  await query(
    `UPDATE courier_profiles SET last_lat = $2, last_lng = $3, last_heading = $4, last_seen_at = now() WHERE user_id = $1`,
    [courier.sub, point.lat, point.lng, point.heading ?? null],
  );
  const active = await query<{ id: string; lat: number; lng: number; vehicle: 'MOTO' | 'BICI' | 'CARRO' }>(
    `SELECT d.id, d.lat, d.lng, cp.vehicle FROM delivery_orders d JOIN courier_profiles cp ON cp.user_id = d.courier_id
      WHERE d.courier_id = $1 AND d.status = 'ON_THE_WAY'`,
    [courier.sub],
  );

  const previous = lastTrackPoint.get(courier.sub);
  const moved = !previous || Date.now() - previous.at > 20_000 || distanceKm(previous, point) > 0.025;
  if (moved && active.length) {
    lastTrackPoint.set(courier.sub, { at: Date.now(), lat: point.lat, lng: point.lng });
    for (const delivery of active) {
      await query('INSERT INTO delivery_tracks (delivery_order_id, lat, lng) VALUES ($1, $2, $3)', [delivery.id, point.lat, point.lng]);
    }
  }

  const at = new Date().toISOString();
  emit(rooms.staff(courier.rid), 'courier:location', { courierId: courier.sub, lat: point.lat, lng: point.lng, heading: point.heading ?? null, at });
  for (const delivery of active) {
    emit(rooms.delivery(delivery.id), 'courier:location', {
      lat: point.lat,
      lng: point.lng,
      at,
      etaMinutes: estimateTravelMinutes(point, { lat: Number(delivery.lat), lng: Number(delivery.lng) }, delivery.vehicle),
    });
  }
}

// ----------------------------------------------------------------------------
// Ajustes (Admin)
// ----------------------------------------------------------------------------
export const settingsSchema = z.object({
  deliveryEnabled: z.boolean(),
  pickupEnabled: z.boolean(),
  minOrder: z.number().min(0).max(10_000_000),
  prepMinutes: z.number().int().min(0).max(240),
  address: z.string().trim().max(160).nullable(),
  phone: z.string().trim().max(30).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  zones: z
    .array(z.object({ name: z.string().trim().min(1).max(40), maxKm: z.number().gt(0).max(50), fee: z.number().min(0).max(1_000_000), travelMinutes: z.number().int().min(0).max(180) }))
    .max(10)
    .refine((zones) => new Set(zones.map((z) => z.maxKm)).size === zones.length, 'Dos zonas no pueden tener la misma distancia máxima'),
});
export type DeliverySettings = z.infer<typeof settingsSchema>;

export async function getSettings(restaurantId: string): Promise<DeliverySettings> {
  const r = await getRestaurant(restaurantId);
  return {
    deliveryEnabled: r.deliveryEnabled,
    pickupEnabled: r.pickupEnabled,
    minOrder: Number(r.deliveryMinOrder),
    prepMinutes: r.deliveryPrepMinutes,
    address: r.address,
    phone: r.phone,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    zones: (await listZones(restaurantId)).map((z) => ({ name: z.name, maxKm: Number(z.maxKm), fee: Number(z.fee), travelMinutes: z.travelMinutes })),
  };
}

export async function saveSettings(restaurantId: string, input: DeliverySettings): Promise<DeliverySettings> {
  if (input.deliveryEnabled && (input.lat === null || input.lng === null)) throw badRequest('Marca la ubicación del restaurante en el mapa para activar domicilios', 'NO_LOCATION');
  if (input.deliveryEnabled && input.zones.length === 0) throw badRequest('Agrega al menos una zona de entrega', 'NO_ZONES');
  await tx(async (db) => {
    await db.query(
      `UPDATE restaurants SET delivery_enabled = $2, pickup_enabled = $3, delivery_min_order = $4, delivery_prep_minutes = $5,
              address = $6, phone = $7, lat = $8, lng = $9 WHERE id = $1`,
      [restaurantId, input.deliveryEnabled, input.pickupEnabled, input.minOrder, input.prepMinutes, input.address, input.phone, input.lat, input.lng],
    );
    // Los pedidos guardan su zona por id; al reemplazar zonas, los históricos conservan distancia y tarifa.
    await db.query('DELETE FROM delivery_zones WHERE restaurant_id = $1', [restaurantId]);
    for (const zone of input.zones) {
      await db.query('INSERT INTO delivery_zones (restaurant_id, name, max_km, fee, travel_minutes) VALUES ($1, $2, $3, $4, $5)', [
        restaurantId, zone.name, zone.maxKm, zone.fee, zone.travelMinutes,
      ]);
    }
  });
  emit(rooms.menu(restaurantId), 'menu:updated', { at: new Date().toISOString() });
  return getSettings(restaurantId);
}
