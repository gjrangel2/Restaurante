import type { StaffClaims } from '../auth/tokens.js';
import { mockEInvoiceProvider, mockPaymentGateway, type EInvoiceProvider, type PaymentGateway, type PaymentMethod } from '../billing/providers.js';
import { query, queryOne, tx, type Db } from '../db/pool.js';
import { conflict, HttpError } from '../http.js';
import { emit, getIo, rooms } from '../realtime/bus.js';
import { getRestaurant, type Restaurant } from './restaurant.js';
import { publishTable, refreshTableStatus } from './tables.service.js';

// Cambia estas dos líneas para conectar proveedores reales (ver billing/providers.ts).
// El datáfono/caja (POS) es independiente de las pasarelas en línea de payments/gateways.ts.
const paymentGateway: PaymentGateway = mockPaymentGateway;
const eInvoiceProvider: EInvoiceProvider = mockEInvoiceProvider;

export interface BillTotals {
  gross: number; // suma de la carta (lo que el cliente vio)
  subtotal: number; // base gravable
  taxName: string;
  taxRate: number;
  taxTotal: number;
  tipRate: number;
  tipTotal: number;
  deliveryFee: number;
  grandTotal: number;
}

const roundFor = (restaurant: Restaurant) => {
  const decimals = restaurant.currency === 'COP' ? 0 : 2;
  return (value: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
};

/**
 * Liquidación de impuestos.
 *   · Si la carta ya incluye el impuesto (lo habitual de cara al consumidor),
 *     se desglosa hacia atrás: impuesto = total − total / (1 + tarifa).
 *   · La propina es voluntaria: se calcula sobre la base y nunca la aumenta.
 *   · El domicilio va en su propia línea, fuera de la base del impuesto.
 * Tarifa y nombre del impuesto vienen de la configuración del restaurante.
 */
export function computeTotals(restaurant: Restaurant, gross: number, tipRate: number, deliveryFee = 0): BillTotals {
  const round = roundFor(restaurant);
  const rate = restaurant.taxRate / 100;

  const taxTotal = restaurant.pricesIncludeTax ? round(gross - gross / (1 + rate)) : round(gross * rate);
  const subtotal = restaurant.pricesIncludeTax ? round(gross - taxTotal) : round(gross);
  const tipTotal = round((subtotal * tipRate) / 100);

  return {
    gross,
    subtotal,
    taxName: restaurant.taxName,
    taxRate: restaurant.taxRate,
    taxTotal,
    tipRate,
    tipTotal,
    deliveryFee,
    grandTotal: round(subtotal + taxTotal + tipTotal + deliveryFee),
  };
}

// ----------------------------------------------------------------------------
// Cuenta de una mesa
// ----------------------------------------------------------------------------
export interface OpenBill {
  sessionId: string;
  gross: number;
  ordersInProgress: number;
}

export async function loadOpenBill(db: Db | undefined, restaurantId: string, tableId: string, lock: boolean): Promise<OpenBill | null> {
  const session = await queryOne<{ id: string }>(
    `SELECT id FROM table_sessions WHERE table_id = $1 AND restaurant_id = $2 AND closed_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [tableId, restaurantId],
    db,
  );
  if (!session) return null;

  const sums = await queryOne<{ gross: number; in_progress: number }>(
    `SELECT COALESCE(SUM(oi.unit_price * oi.quantity) FILTER (WHERE o.status <> 'CANCELLED' AND oi.status <> 'CANCELLED'), 0) AS gross,
            count(DISTINCT o.id) FILTER (WHERE o.status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY')) AS in_progress
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.session_id = $1`,
    [session.id],
    db,
  );
  return { sessionId: session.id, gross: sums!.gross, ordersInProgress: sums!.in_progress };
}

/** Pago en línea en curso de una mesa (un cliente está en la pasarela). */
export async function pendingTablePayment(db: Db | undefined, sessionId: string) {
  return queryOne<{ id: string; channel: string; expiresAt: string }>(
    `SELECT id, channel, expires_at AS "expiresAt" FROM payment_intents
      WHERE session_id = $1 AND status = 'PENDING' AND expires_at > now()`,
    [sessionId],
    db,
  );
}

/** Vista previa de la cuenta para el panel de la mesa y para el celular del cliente (no escribe nada). */
export async function previewBill(restaurantId: string, tableId: string, tipRate?: number) {
  const restaurant = await getRestaurant(restaurantId);
  const bill = await loadOpenBill(undefined, restaurantId, tableId, false);
  if (!bill) return null;
  const online = await pendingTablePayment(undefined, bill.sessionId);
  return {
    totals: computeTotals(restaurant, bill.gross, tipRate ?? restaurant.suggestedTipRate),
    suggestedTipRate: restaurant.suggestedTipRate,
    currency: restaurant.currency,
    // Con comandas en curso no se cobra: primero se entregan o se rechazan.
    canCharge: bill.gross > 0 && bill.ordersInProgress === 0 && !online,
    ordersInProgress: bill.ordersInProgress,
    onlinePayment: online, // si alguien está pagando desde el celular
  };
}

// ----------------------------------------------------------------------------
// Emisión de factura (mesa o domicilio) + registro del pago aprobado
// ----------------------------------------------------------------------------
export interface IssueInput {
  target: { sessionId: string; tableId: string } | { deliveryOrderId: string };
  totals: BillTotals;
  customer: { name?: string; doc?: string; email?: string };
  payment: {
    method: PaymentMethod;
    amountReceived: number;
    changeDue: number;
    reference: string;
    provider: string; // POS, WOMPI, MERCADOPAGO, MOCK
    intentId?: string;
    validatedBy?: string | null;
  };
}

export interface IssuedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  cufe: string;
  issuedAt: Date;
  simulated: boolean;
}

/**
 * Emite la factura electrónica y registra el pago aprobado, dentro de la
 * transacción del llamador. Si ya había un borrador (intentos rechazados en
 * caja), lo completa; si la factura ya estaba emitida, se niega.
 */
export async function issueInvoice(db: Db, restaurant: Restaurant, input: IssueInput): Promise<IssuedInvoice> {
  const bySession = 'sessionId' in input.target;
  const targetId = bySession ? (input.target as { sessionId: string }).sessionId : (input.target as { deliveryOrderId: string }).deliveryOrderId;
  const existing = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM invoices WHERE ${bySession ? 'session_id' : 'delivery_order_id'} = $1 FOR UPDATE`,
    [targetId],
    db,
  );
  if (existing?.status === 'ISSUED') throw conflict('Esta cuenta ya fue facturada', 'ALREADY_INVOICED');

  const issuedAt = new Date();
  const seq = await queryOne<{ n: number }>(`SELECT nextval('invoice_number_seq') AS n`, [], db);
  const invoiceNumber = `${restaurant.invoicePrefix}${seq!.n}`;
  const customerDoc = input.customer.doc || '222222222222';
  const t = input.totals;
  // Con un proveedor real, esta llamada externa conviene hacerla antes de abrir la transacción.
  const eInvoice = await eInvoiceProvider.issue({
    invoiceNumber,
    issuerTaxId: restaurant.taxId,
    customerDoc,
    subtotal: t.subtotal,
    taxTotal: t.taxTotal,
    grandTotal: t.grandTotal,
    issuedAt,
  });

  const values = [
    t.subtotal, t.taxName, t.taxRate, t.taxTotal, t.tipRate, t.tipTotal, t.deliveryFee, t.grandTotal,
    input.customer.name || 'Consumidor final', customerDoc, input.customer.email || null,
    invoiceNumber, eInvoice.cufe, eInvoice.provider, JSON.stringify(eInvoice.raw), issuedAt,
  ];
  let invoiceId: string;
  if (existing) {
    await db.query(
      `UPDATE invoices SET subtotal = $1, tax_name = $2, tax_rate = $3, tax_total = $4, tip_rate = $5, tip_total = $6, delivery_fee = $7,
              grand_total = $8, customer_name = $9, customer_doc = $10, customer_email = $11, invoice_number = $12, cufe = $13,
              provider = $14, provider_response = $15, issued_at = $16, status = 'ISSUED'
        WHERE id = $17`,
      [...values, existing.id],
    );
    invoiceId = existing.id;
  } else {
    const target = input.target;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO invoices (subtotal, tax_name, tax_rate, tax_total, tip_rate, tip_total, delivery_fee, grand_total, customer_name,
                             customer_doc, customer_email, invoice_number, cufe, provider, provider_response, issued_at, status,
                             restaurant_id, session_id, table_id, delivery_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'ISSUED', $17, $18, $19, $20)
       RETURNING id`,
      [
        ...values,
        restaurant.id,
        'sessionId' in target ? target.sessionId : null,
        'sessionId' in target ? target.tableId : null,
        'deliveryOrderId' in target ? target.deliveryOrderId : null,
      ],
      db,
    );
    invoiceId = row!.id;
  }

  const p = input.payment;
  await db.query(
    `INSERT INTO payments (invoice_id, method, amount, amount_received, change_due, status, reference, provider, payment_intent_id, validated_by, validated_at)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, $7, $8, $9, now())`,
    [invoiceId, p.method, t.grandTotal, p.amountReceived, p.changeDue, p.reference, p.provider, p.intentId ?? null, p.validatedBy ?? null],
  );

  return { invoiceId, invoiceNumber, cufe: eInvoice.cufe, issuedAt, simulated: eInvoice.provider === 'MOCK' };
}

/**
 * Cierra la sesión de una mesa ya pagada. El trigger trg_guard_session_close
 * verifica en la base de datos que la factura emitida esté cubierta por
 * pagos aprobados; si no, la transacción completa se revierte.
 */
export async function closePaidSession(db: Db, sessionId: string, tableId: string, closedBy: string | null): Promise<void> {
  await db.query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
  await db.query('UPDATE waiter_calls SET attended_at = now(), attended_by = $2 WHERE session_id = $1 AND attended_at IS NULL', [sessionId, closedBy]);
  await db.query(`UPDATE table_sessions SET closed_at = now(), closed_by = $2, close_reason = 'PAID' WHERE id = $1`, [sessionId, closedBy]);
  await refreshTableStatus(db, tableId);
}

/** Avisos en tiempo real tras cerrar una mesa pagada (después del COMMIT). */
export async function publishTableClosed(restaurantId: string, tableId: string, sessionId: string, invoiceNumber: string, grandTotal: number) {
  const table = await publishTable(restaurantId, tableId);
  emit(rooms.session(sessionId), 'session:closed', { reason: 'PAID', invoiceNumber, grandTotal });
  getIo().in(rooms.session(sessionId)).socketsLeave(rooms.session(sessionId));
  emit(rooms.staff(restaurantId), 'invoice:issued', { invoiceNumber, tableNumber: table.number, grandTotal });
  return table;
}

// ----------------------------------------------------------------------------
// Cobro en caja (camarero)
// ----------------------------------------------------------------------------
export interface PayInput {
  method: PaymentMethod;
  amountReceived: number;
  tipRate: number;
  customerName?: string;
  customerDoc?: string;
  customerEmail?: string;
}

export interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  tableNumber: number;
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxTotal: number;
  tipTotal: number;
  grandTotal: number;
  customerName: string;
  customerDoc: string;
  cufe: string;
  issuedAt: string;
  payment: { method: PaymentMethod; amountReceived: number; changeDue: number; reference: string };
  simulated: boolean;
}

/**
 * Cobrar y cerrar la mesa desde caja. Junto con el pago en línea del cliente
 * (payments.service.ts), es el único camino para cerrar una mesa que consumió:
 *
 *   1. Se liquida la cuenta y se guarda la factura en borrador.
 *   2. La pasarela valida el pago. Si lo rechaza, queda registrado el intento
 *      y la mesa sigue abierta.
 *   3. Con el pago aprobado, en una sola transacción: factura emitida → pago
 *      aprobado → sesión cerrada → mesa libre.
 *   4. El token de sesión de los clientes deja de servir en ese instante.
 */
export async function payAndClose(staff: StaffClaims, tableId: string, input: PayInput): Promise<InvoiceDto> {
  const restaurant = await getRestaurant(staff.rid);

  // 1) Liquidación + borrador
  const draft = await tx(async (db) => {
    const bill = await loadOpenBill(db, staff.rid, tableId, true);
    if (!bill) throw conflict('La mesa no está abierta', 'TABLE_NOT_OPEN');
    if (await pendingTablePayment(db, bill.sessionId)) {
      throw conflict('Un cliente está pagando esta cuenta en línea. Espera a que termine o a que expire.', 'ONLINE_PAYMENT_IN_PROGRESS');
    }
    if (bill.ordersInProgress > 0) throw conflict('Hay comandas en curso: entrégalas o recházalas antes de cobrar', 'ORDERS_IN_PROGRESS');
    if (bill.gross <= 0) throw conflict('Esta mesa no tiene consumo. Usa "Cerrar sin consumo".', 'NOTHING_TO_BILL');

    const totals = computeTotals(restaurant, bill.gross, input.tipRate);
    const invoice = await queryOne<{ id: string }>(
      `INSERT INTO invoices (restaurant_id, session_id, table_id, subtotal, tax_name, tax_rate, tax_total, tip_rate, tip_total, grand_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id) DO UPDATE
         SET subtotal = EXCLUDED.subtotal, tax_total = EXCLUDED.tax_total, tip_rate = EXCLUDED.tip_rate,
             tip_total = EXCLUDED.tip_total, grand_total = EXCLUDED.grand_total
       WHERE invoices.status = 'DRAFT'
       RETURNING id`,
      [staff.rid, bill.sessionId, tableId, totals.subtotal, totals.taxName, totals.taxRate, totals.taxTotal, totals.tipRate, totals.tipTotal, totals.grandTotal],
      db,
    );
    if (!invoice) throw conflict('Esta cuenta ya fue facturada', 'ALREADY_INVOICED');
    return { invoiceId: invoice.id, sessionId: bill.sessionId, gross: bill.gross, totals };
  });

  // 2) Validación del pago (fuera de la transacción: en producción es una llamada externa)
  const payment = await paymentGateway.authorize({
    method: input.method,
    amountDue: draft.totals.grandTotal,
    amountReceived: input.amountReceived,
  });

  if (!payment.approved) {
    await query(
      `INSERT INTO payments (invoice_id, method, amount, amount_received, status) VALUES ($1, $2, $3, $4, 'REJECTED')`,
      [draft.invoiceId, input.method, draft.totals.grandTotal, input.amountReceived],
    );
    throw new HttpError(402, 'PAYMENT_REJECTED', payment.reason ?? 'El pago fue rechazado');
  }

  // 3) Factura emitida y mesa cerrada
  const issued = await tx(async (db) => {
    // Si entró una comanda nueva entre la liquidación y el pago, la cuenta cambió: no se cierra.
    const bill = await loadOpenBill(db, staff.rid, tableId, true);
    if (!bill || bill.sessionId !== draft.sessionId || bill.gross !== draft.gross || bill.ordersInProgress > 0) {
      throw conflict('La cuenta cambió mientras se procesaba el pago. Vuelve a cobrar.', 'BILL_CHANGED');
    }
    const result = await issueInvoice(db, restaurant, {
      target: { sessionId: draft.sessionId, tableId },
      totals: draft.totals,
      customer: { name: input.customerName, doc: input.customerDoc, email: input.customerEmail },
      payment: {
        method: input.method,
        amountReceived: input.amountReceived,
        changeDue: payment.changeDue,
        reference: payment.reference!,
        provider: 'POS',
        validatedBy: staff.sub,
      },
    });
    await closePaidSession(db, draft.sessionId, tableId, staff.sub);
    return result;
  });

  // 4) Avisos en tiempo real
  const table = await publishTableClosed(staff.rid, tableId, draft.sessionId, issued.invoiceNumber, draft.totals.grandTotal);

  return {
    id: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    tableNumber: table.number,
    subtotal: draft.totals.subtotal,
    taxName: draft.totals.taxName,
    taxRate: draft.totals.taxRate,
    taxTotal: draft.totals.taxTotal,
    tipTotal: draft.totals.tipTotal,
    grandTotal: draft.totals.grandTotal,
    customerName: input.customerName || 'Consumidor final',
    customerDoc: input.customerDoc || '222222222222',
    cufe: issued.cufe,
    issuedAt: issued.issuedAt.toISOString(),
    payment: { method: input.method, amountReceived: input.amountReceived, changeDue: payment.changeDue, reference: payment.reference! },
    simulated: issued.simulated,
  };
}
