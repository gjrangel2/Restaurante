import crypto from 'node:crypto';
import type { GuestClaims } from '../auth/tokens.js';
import { config } from '../config.js';
import { query, queryOne, tx, type Db } from '../db/pool.js';
import { conflict, HttpError, notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';
import { closePaidSession, computeTotals, issueInvoice, loadOpenBill, pendingTablePayment, publishTableClosed } from '../modules/billing.service.js';
import { markDeliveryCancelled, publishDelivery, refreshDeliveryStatus } from '../modules/delivery.status.js';
import { getRestaurant } from '../modules/restaurant.js';
import { publishTable } from '../modules/tables.service.js';
import {
  fetchMercadoPagoPayment,
  gatewayFor,
  GatewayError,
  mercadoPagoSignatureIsValid,
  resolveGateway,
  wompiEventIsValid,
  wompiTransaction,
  type PaymentChannel,
  type ProviderId,
  type ProviderTransaction,
} from './gateways.js';

/**
 * Pagos en línea: domicilios y cuenta de la mesa desde el celular.
 *
 *   1. createIntent      se registra el intento y se obtiene la URL de la pasarela
 *   2. el cliente paga en la pasarela y vuelve a /pago/resultado/<referencia>
 *   3. verifyIntent      la página de resultado pide verificar: se consulta la API
 *      handle*Webhook    o llega el webhook firmado del proveedor
 *   4. applyTransaction  si el monto y la referencia cuadran y está aprobado:
 *                        factura + pago + (pedido al restaurante | mesa cerrada)
 *
 * Todo es idempotente: el mismo aprobado puede llegar por la redirección y
 * por el webhook, y solo se aplica una vez.
 */
type IntentStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'ERROR' | 'EXPIRED';

interface IntentRow {
  id: string;
  reference: string;
  restaurant_id: string;
  purpose: 'DELIVERY' | 'TABLE_BILL';
  delivery_order_id: string | null;
  session_id: string | null;
  provider: ProviderId;
  channel: PaymentChannel;
  live: boolean;
  amount: number;
  tip_rate: number;
  currency: string;
  status: IntentStatus;
  checkout_url: string | null;
  provider_tx_id: string | null;
  needs_review: boolean;
  expires_at: Date;
}

const newReference = () => `FO-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

export interface CreateIntentInput {
  restaurantId: string;
  purpose: 'DELIVERY' | 'TABLE_BILL';
  deliveryOrderId?: string;
  sessionId?: string;
  channel: PaymentChannel;
  amount: number;
  tipRate?: number;
  currency: string;
  description: string;
  customer: { name?: string; email?: string; phone?: string };
  baseUrl: string;
}

/** Registra el intento (dentro de la transacción del llamador). La pasarela se llama después, con checkout(). */
export async function insertIntent(db: Db, input: CreateIntentInput): Promise<IntentRow> {
  const { gateway, live } = resolveGateway(input.channel);
  const row = await queryOne<IntentRow>(
    `INSERT INTO payment_intents (reference, restaurant_id, purpose, delivery_order_id, session_id, provider, channel, live,
                                  amount, tip_rate, currency, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12))
     RETURNING *`,
    [
      newReference(), input.restaurantId, input.purpose, input.deliveryOrderId ?? null, input.sessionId ?? null, gateway.id,
      input.channel, live, input.amount, input.tipRate ?? 0, input.currency, config.payments.intentTtlMinutes,
    ],
    db,
  );
  return row!;
}

/** Pide a la pasarela la URL de pago. Si la pasarela falla, el intento queda en ERROR. */
export async function checkout(intent: IntentRow, request: Pick<CreateIntentInput, 'description' | 'customer' | 'baseUrl'>): Promise<string> {
  const base = config.publicBaseUrl ?? request.baseUrl;
  const notificationUrl = config.publicBaseUrl?.startsWith('https://') ? `${config.publicBaseUrl}/api/payments/webhooks/mercadopago` : undefined;
  try {
    const { url } = await gatewayFor(intent.provider).createCheckout({
      reference: intent.reference,
      amount: Number(intent.amount),
      currency: intent.currency,
      description: request.description,
      channel: intent.channel,
      returnUrl: `${base}/pago/resultado/${intent.reference}`,
      notificationUrl,
      expiresAt: new Date(intent.expires_at),
      customer: request.customer,
    });
    await query('UPDATE payment_intents SET checkout_url = $2 WHERE id = $1', [intent.id, url]);
    return url;
  } catch (err) {
    const message = err instanceof GatewayError ? err.message : 'Error inesperado al crear el pago';
    console.error(`[pagos] ${intent.reference}: ${message}`);
    await query(`UPDATE payment_intents SET status = 'ERROR', provider_status = $2, completed_at = now() WHERE id = $1`, [intent.id, message.slice(0, 300)]);
    throw new HttpError(502, 'GATEWAY_UNAVAILABLE', 'La pasarela de pago no respondió. Intenta de nuevo o elige otro medio de pago.');
  }
}

// ----------------------------------------------------------------------------
// Cuenta de la mesa pagada desde el celular
// ----------------------------------------------------------------------------
export async function createTableBillCheckout(guest: GuestClaims, channel: PaymentChannel, tipRate: number, baseUrl: string) {
  const restaurant = await getRestaurant(guest.rid);
  const intent = await tx(async (db) => {
    const bill = await loadOpenBill(db, guest.rid, guest.tid, true);
    if (!bill || bill.sessionId !== guest.sid) throw new HttpError(410, 'SESSION_CLOSED', 'La mesa está cerrada');
    if (bill.ordersInProgress > 0) {
      throw conflict('Aún hay platos en camino. Podrás pagar cuando todo esté en la mesa.', 'ORDERS_IN_PROGRESS');
    }
    if (bill.gross <= 0) throw conflict('Todavía no hay nada que pagar.', 'NOTHING_TO_BILL');
    const pending = await pendingTablePayment(db, guest.sid);
    if (pending) throw conflict('Otra persona de la mesa ya está pagando la cuenta.', 'ONLINE_PAYMENT_IN_PROGRESS');

    const totals = computeTotals(restaurant, bill.gross, tipRate);
    return insertIntent(db, {
      restaurantId: guest.rid,
      purpose: 'TABLE_BILL',
      sessionId: guest.sid,
      channel,
      amount: totals.grandTotal,
      tipRate,
      currency: restaurant.currency,
      description: `Cuenta mesa · ${restaurant.name}`,
      customer: {},
      baseUrl,
    });
  });

  // Toda la mesa y el camarero ven que la cuenta se está pagando.
  emit(rooms.session(guest.sid), 'bill:paying', { alias: guest.alias, channel });
  await publishTable(guest.rid, guest.tid);
  const url = await checkout(intent, { description: `Cuenta mesa · ${restaurant.name}`, customer: {}, baseUrl }).catch(async (err) => {
    await publishTable(guest.rid, guest.tid); // el intento falló: la mesa vuelve a poder pagar
    throw err;
  });
  return { reference: intent.reference, checkoutUrl: url, live: intent.live };
}

// ----------------------------------------------------------------------------
// Consulta y verificación
// ----------------------------------------------------------------------------
export interface IntentView {
  reference: string;
  status: IntentStatus;
  purpose: 'DELIVERY' | 'TABLE_BILL';
  channel: PaymentChannel;
  live: boolean;
  amount: number;
  currency: string;
  expiresAt: string;
  description: string;
  restaurantName: string;
  trackingCode: string | null; // domicilio: a dónde volver
  tableNumber: number | null; // mesa: a dónde volver
  invoiceNumber: string | null;
  needsReview: boolean;
}

export async function getIntentView(reference: string): Promise<IntentView> {
  const row = await queryOne<IntentView>(
    `SELECT pi.reference, pi.status, pi.purpose, pi.channel, pi.live, pi.amount, pi.currency, pi.expires_at AS "expiresAt",
            pi.needs_review AS "needsReview", r.name AS "restaurantName",
            CASE WHEN pi.purpose = 'DELIVERY' THEN 'Pedido D-' || d.code ELSE 'Cuenta de la mesa ' || t.number END AS description,
            d.tracking_code AS "trackingCode", t.number AS "tableNumber",
            (SELECT i.invoice_number FROM payments p JOIN invoices i ON i.id = p.invoice_id
              WHERE p.payment_intent_id = pi.id AND i.status = 'ISSUED' LIMIT 1) AS "invoiceNumber"
       FROM payment_intents pi
       JOIN restaurants r ON r.id = pi.restaurant_id
       LEFT JOIN delivery_orders d ON d.id = pi.delivery_order_id
       LEFT JOIN table_sessions s ON s.id = pi.session_id
       LEFT JOIN restaurant_tables t ON t.id = s.table_id
      WHERE pi.reference = $1`,
    [reference],
  );
  if (!row) throw notFound('No encontramos ese pago');
  return row;
}

/**
 * La página de resultado pide verificar. Si el intento sigue pendiente y es
 * en vivo, se consulta la API del proveedor (con la pista de la redirección).
 */
export async function verifyIntent(reference: string, hint?: string): Promise<IntentView> {
  const intent = await queryOne<IntentRow>('SELECT * FROM payment_intents WHERE reference = $1', [reference]);
  if (!intent) throw notFound('No encontramos ese pago');

  if (intent.live && (intent.status === 'PENDING' || intent.status === 'EXPIRED')) {
    try {
      const transaction = await gatewayFor(intent.provider).fetchTransaction(intent.reference, hint || intent.provider_tx_id || undefined);
      if (transaction) await applyTransaction(intent.reference, transaction);
    } catch (err) {
      // La pasarela no respondió: el webhook o el siguiente intento de verificación lo resolverán.
      console.warn(`[pagos] no se pudo verificar ${reference}: ${(err as Error).message}`);
    }
  }
  return getIntentView(reference);
}

/** Pasarela de pruebas: quien la usa elige el resultado. Nunca aplica a intentos en vivo. */
export async function completeMockIntent(reference: string, outcome: 'APPROVED' | 'DECLINED'): Promise<IntentView> {
  const intent = await queryOne<IntentRow>('SELECT * FROM payment_intents WHERE reference = $1', [reference]);
  if (!intent) throw notFound('No encontramos ese pago');
  if (intent.provider !== 'MOCK' || intent.live) throw conflict('Este pago se procesa en una pasarela real', 'NOT_A_TEST_PAYMENT');

  await applyTransaction(reference, {
    outcome,
    transactionId: `TEST-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    reference,
    amount: Number(intent.amount),
    currency: intent.currency,
    method: intent.channel === 'PSE' ? 'PSE' : 'CARD',
    rawStatus: outcome,
    raw: { simulated: true },
  });
  return getIntentView(reference);
}

// ----------------------------------------------------------------------------
// Aplicar el resultado de una transacción
// ----------------------------------------------------------------------------
const methodFor = (providerMethod: string | null): 'CARD' | 'TRANSFER' =>
  providerMethod && /CARD|credit|debit|prepaid/i.test(providerMethod) ? 'CARD' : 'TRANSFER';

export async function applyTransaction(reference: string, transaction: ProviderTransaction): Promise<void> {
  const after = await tx(async (db) => {
    const intent = await queryOne<IntentRow>('SELECT * FROM payment_intents WHERE reference = $1 FOR UPDATE', [reference], db);
    if (!intent) return null;
    if (intent.status === 'APPROVED') return null; // ya aplicado (redirección y webhook pueden llegar ambos)

    // El monto y la moneda deben ser exactamente los del intento.
    const amountMatches = Math.abs(transaction.amount - Number(intent.amount)) < 0.01 && transaction.currency === intent.currency;
    await db.query(
      `UPDATE payment_intents SET provider_tx_id = $2, provider_method = $3, provider_status = $4, raw = $5 WHERE id = $1`,
      [intent.id, transaction.transactionId, transaction.method, transaction.rawStatus, JSON.stringify(transaction.raw ?? null)],
    );
    if (!amountMatches) {
      await db.query('UPDATE payment_intents SET needs_review = true WHERE id = $1', [intent.id]);
      console.error(`[pagos] ${reference}: el monto o la moneda no cuadran (${transaction.amount} ${transaction.currency}). Queda para revisión.`);
      return { intent, effect: 'review' as const };
    }

    if (transaction.outcome === 'PENDING') return null;
    if (transaction.outcome !== 'APPROVED') {
      await db.query(`UPDATE payment_intents SET status = $2, completed_at = now() WHERE id = $1`, [intent.id, transaction.outcome]);
      return { intent, effect: 'failed' as const };
    }

    await db.query(`UPDATE payment_intents SET status = 'APPROVED', completed_at = now() WHERE id = $1`, [intent.id]);
    const restaurant = await getRestaurant(intent.restaurant_id);
    const payment = {
      method: methodFor(transaction.method),
      amountReceived: Number(intent.amount),
      changeDue: 0,
      reference: transaction.transactionId,
      provider: intent.provider,
      intentId: intent.id,
      validatedBy: null,
    };

    if (intent.purpose === 'DELIVERY') {
      const delivery = await queryOne<{ id: string; subtotal: number; delivery_fee: number; customer_name: string; customer_email: string | null; cancelled_at: Date | null; paid_at: Date | null }>(
        'SELECT id, subtotal, delivery_fee, customer_name, customer_email, cancelled_at, paid_at FROM delivery_orders WHERE id = $1 FOR UPDATE',
        [intent.delivery_order_id],
        db,
      );
      if (!delivery || delivery.cancelled_at || delivery.paid_at) {
        // Pagó algo que ya no existe (cancelado o pagado por otra vía): hay que reembolsar.
        await db.query('UPDATE payment_intents SET needs_review = true WHERE id = $1', [intent.id]);
        if (delivery) await db.query('UPDATE delivery_orders SET refund_pending = true WHERE id = $1', [delivery.id]);
        return { intent, effect: 'review' as const };
      }
      const issued = await issueInvoice(db, restaurant, {
        target: { deliveryOrderId: delivery.id },
        totals: computeTotals(restaurant, Number(delivery.subtotal), 0, Number(delivery.delivery_fee)),
        customer: { name: delivery.customer_name, email: delivery.customer_email ?? undefined },
        payment,
      });
      // Pagado: ahora sí llega al restaurante.
      await db.query('UPDATE delivery_orders SET paid_at = now(), placed_at = COALESCE(placed_at, now()) WHERE id = $1', [delivery.id]);
      await refreshDeliveryStatus(db, delivery.id);
      return { intent, effect: 'delivery-paid' as const, invoiceNumber: issued.invoiceNumber };
    }

    // Cuenta de la mesa
    const session = await queryOne<{ id: string; table_id: string; closed_at: Date | null }>(
      'SELECT id, table_id, closed_at FROM table_sessions WHERE id = $1 FOR UPDATE',
      [intent.session_id],
      db,
    );
    const bill = session && !session.closed_at ? await loadOpenBill(db, intent.restaurant_id, session.table_id, false) : null;
    const totals = bill ? computeTotals(restaurant, bill.gross, Number(intent.tip_rate)) : null;
    if (!session || !bill || !totals || Math.abs(totals.grandTotal - Number(intent.amount)) >= 0.01) {
      // La mesa ya estaba cerrada o la cuenta cambió: el camarero debe revisar este pago.
      await db.query('UPDATE payment_intents SET needs_review = true WHERE id = $1', [intent.id]);
      return { intent, effect: 'review' as const };
    }
    const issued = await issueInvoice(db, restaurant, { target: { sessionId: session.id, tableId: session.table_id }, totals, customer: {}, payment });
    await closePaidSession(db, session.id, session.table_id, null);
    return { intent, effect: 'table-paid' as const, tableId: session.table_id, invoiceNumber: issued.invoiceNumber, grandTotal: totals.grandTotal };
  });

  if (!after) return;
  const { intent } = after;
  emit(rooms.staff(intent.restaurant_id), 'payment:updated', { reference, purpose: intent.purpose, effect: after.effect });

  if (after.effect === 'delivery-paid' && intent.delivery_order_id) {
    const delivery = await publishDelivery(intent.restaurant_id, intent.delivery_order_id);
    emit(rooms.staff(intent.restaurant_id), 'delivery:new', { code: delivery.code, type: delivery.type });
    emit(rooms.staff(intent.restaurant_id), 'invoice:issued', { invoiceNumber: after.invoiceNumber, grandTotal: Number(intent.amount) });
  } else if (after.effect === 'table-paid') {
    await publishTableClosed(intent.restaurant_id, after.tableId!, intent.session_id!, after.invoiceNumber!, after.grandTotal!);
  } else if (intent.purpose === 'TABLE_BILL' && intent.session_id) {
    // Rechazado o en revisión: la mesa vuelve a poder pagar.
    const table = await queryOne<{ table_id: string }>('SELECT table_id FROM table_sessions WHERE id = $1', [intent.session_id]);
    if (table) await publishTable(intent.restaurant_id, table.table_id);
    emit(rooms.session(intent.session_id), 'bill:payment-failed', { reference });
  } else if (intent.delivery_order_id) {
    await publishDelivery(intent.restaurant_id, intent.delivery_order_id);
  }
}

// ----------------------------------------------------------------------------
// Webhooks
// ----------------------------------------------------------------------------
async function logEvent(provider: ProviderId, reference: string | null, validSignature: boolean, payload: unknown) {
  await query('INSERT INTO payment_events (provider, reference, valid_signature, payload) VALUES ($1, $2, $3, $4)', [
    provider, reference, validSignature, JSON.stringify(payload ?? null),
  ]);
}

/**
 * Wompi: valida el checksum con el secreto de eventos. Sin secreto
 * configurado, no confía en el cuerpo y consulta la transacción a la API.
 */
export async function handleWompiWebhook(body: any, headerChecksum?: string): Promise<{ accepted: boolean }> {
  const raw = body?.data?.transaction;
  const reference = typeof raw?.reference === 'string' ? raw.reference : null;
  const secret = config.payments.wompi.eventsSecret;

  if (secret) {
    const valid = wompiEventIsValid(body, secret, headerChecksum);
    await logEvent('WOMPI', reference, valid, body);
    if (!valid) return { accepted: false };
    if (body.event === 'transaction.updated' && reference) await applyTransaction(reference, wompiTransaction(raw));
    return { accepted: true };
  }

  await logEvent('WOMPI', reference, false, body);
  if (body?.event === 'transaction.updated' && reference && raw?.id) {
    const transaction = await gatewayFor('WOMPI').fetchTransaction(reference, String(raw.id));
    if (transaction) await applyTransaction(reference, transaction);
  }
  return { accepted: true };
}

/**
 * Mercado Pago: valida x-signature (si hay clave secreta) y SIEMPRE consulta
 * el pago a la API antes de aplicarlo: la notificación solo trae el id.
 */
export async function handleMercadoPagoWebhook(
  queryParams: Record<string, unknown>,
  headers: { signature?: string; requestId?: string },
  body: any,
): Promise<{ accepted: boolean }> {
  const type = String(queryParams.type ?? queryParams.topic ?? body?.type ?? '');
  const dataId = String(queryParams['data.id'] ?? body?.data?.id ?? queryParams.id ?? '');
  const secret = config.payments.mercadoPago.webhookSecret;
  const valid = secret ? mercadoPagoSignatureIsValid(headers.signature, headers.requestId, dataId || undefined, secret) : false;
  await logEvent('MERCADOPAGO', null, valid, { query: queryParams, body });

  if (secret && !valid) return { accepted: false };
  if (type !== 'payment' || !dataId || !config.payments.mercadoPago.accessToken) return { accepted: true };

  const transaction = await fetchMercadoPagoPayment(dataId);
  if (transaction.reference) await applyTransaction(transaction.reference, transaction);
  return { accepted: true };
}

// ----------------------------------------------------------------------------
// Limpieza periódica
// ----------------------------------------------------------------------------
/**
 * Intentos vencidos → EXPIRED (la mesa vuelve a poder pagar).
 * Domicilios con pago en línea que nunca se completó (30 min) → cancelados.
 */
export async function sweepExpiredPayments(): Promise<void> {
  const expired = await query<{ restaurant_id: string; session_id: string | null; delivery_order_id: string | null }>(
    `UPDATE payment_intents SET status = 'EXPIRED', completed_at = now()
      WHERE status = 'PENDING' AND expires_at < now()
      RETURNING restaurant_id, session_id, delivery_order_id`,
  );
  for (const intent of expired) {
    if (intent.session_id) {
      const table = await queryOne<{ table_id: string; closed_at: Date | null }>('SELECT table_id, closed_at FROM table_sessions WHERE id = $1', [intent.session_id]);
      if (table && !table.closed_at) await publishTable(intent.restaurant_id, table.table_id);
    }
  }

  const abandoned = await query<{ id: string; restaurant_id: string }>(
    `SELECT d.id, d.restaurant_id FROM delivery_orders d
      WHERE d.status = 'PENDING_PAYMENT' AND d.created_at < now() - interval '30 minutes'
        AND NOT EXISTS (SELECT 1 FROM payment_intents pi WHERE pi.delivery_order_id = d.id AND pi.status = 'PENDING')`,
  );
  for (const delivery of abandoned) {
    await tx(async (db) => {
      await db.query(`UPDATE orders SET status = 'CANCELLED', cancelled_at = now() WHERE id = (SELECT order_id FROM delivery_orders WHERE id = $1)`, [delivery.id]);
      await markDeliveryCancelled(db, delivery.id, 'El pago en línea no se completó');
      await refreshDeliveryStatus(db, delivery.id);
    });
    await publishDelivery(delivery.restaurant_id, delivery.id);
  }
}

