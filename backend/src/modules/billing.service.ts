import type { StaffClaims } from '../auth/tokens.js';
import { mockEInvoiceProvider, mockPaymentGateway, type EInvoiceProvider, type PaymentGateway, type PaymentMethod } from '../billing/providers.js';
import { query, queryOne, tx, type Db } from '../db/pool.js';
import { conflict, HttpError } from '../http.js';
import { emit, getIo, rooms } from '../realtime/bus.js';
import { getRestaurant, type Restaurant } from './restaurant.js';
import { publishTable, refreshTableStatus } from './tables.service.js';

// Cambia estas dos líneas para conectar proveedores reales (ver billing/providers.ts).
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
  grandTotal: number;
}

/**
 * Liquidación de impuestos.
 *   · Si la carta ya incluye el impuesto (lo habitual de cara al consumidor),
 *     se desglosa hacia atrás: impuesto = total − total / (1 + tarifa).
 *   · La propina es voluntaria: se calcula sobre la base y nunca la aumenta.
 * Tarifa y nombre del impuesto vienen de la configuración del restaurante.
 */
export function computeTotals(restaurant: Restaurant, gross: number, tipRate: number): BillTotals {
  const decimals = restaurant.currency === 'COP' ? 0 : 2;
  const round = (value: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
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
    grandTotal: round(subtotal + taxTotal + tipTotal),
  };
}

interface OpenBill {
  sessionId: string;
  gross: number;
  ordersInProgress: number;
}

async function loadOpenBill(db: Db | undefined, restaurantId: string, tableId: string, lock: boolean): Promise<OpenBill | null> {
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

/** Vista previa de la cuenta para el panel de la mesa (no escribe nada). */
export async function previewBill(restaurantId: string, tableId: string, tipRate?: number) {
  const restaurant = await getRestaurant(restaurantId);
  const bill = await loadOpenBill(undefined, restaurantId, tableId, false);
  if (!bill) return null;
  return {
    totals: computeTotals(restaurant, bill.gross, tipRate ?? restaurant.suggestedTipRate),
    suggestedTipRate: restaurant.suggestedTipRate,
    currency: restaurant.currency,
    // Con comandas en curso no se cobra: primero se entregan o se rechazan.
    canCharge: bill.gross > 0 && bill.ordersInProgress === 0,
    ordersInProgress: bill.ordersInProgress,
  };
}

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
 * Cobrar y cerrar la mesa. Es el ÚNICO camino para cerrar una mesa que consumió:
 *
 *   1. Se liquida la cuenta y se guarda la factura en borrador.
 *   2. La pasarela valida el pago. Si lo rechaza, queda registrado el intento
 *      y la mesa sigue abierta.
 *   3. Con el pago aprobado, en una sola transacción: pago aprobado → factura
 *      emitida → sesión cerrada → mesa libre. El trigger
 *      trg_guard_session_close impide en la base de datos cerrar la sesión
 *      sin ese pago.
 *   4. El token de sesión de los clientes deja de servir en ese instante.
 */
export async function payAndClose(staff: StaffClaims, tableId: string, input: PayInput): Promise<InvoiceDto> {
  const restaurant = await getRestaurant(staff.rid);

  // 1) Liquidación + borrador
  const draft = await tx(async (db) => {
    const bill = await loadOpenBill(db, staff.rid, tableId, true);
    if (!bill) throw conflict('La mesa no está abierta', 'TABLE_NOT_OPEN');
    if (bill.ordersInProgress > 0) throw conflict('Hay comandas en curso: entrégalas o recházalas antes de cobrar', 'ORDERS_IN_PROGRESS');
    if (bill.gross <= 0) throw conflict('Esta mesa no tiene consumo. Usa "Cerrar sin consumo".', 'NOTHING_TO_BILL');

    const totals = computeTotals(restaurant, bill.gross, input.tipRate);
    const invoice = await queryOne<{ id: string }>(
      `INSERT INTO invoices (restaurant_id, session_id, table_id, subtotal, tax_name, tax_rate, tax_total, tip_rate, tip_total,
                             grand_total, customer_name, customer_doc, customer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'Consumidor final'), COALESCE($12, '222222222222'), $13)
       ON CONFLICT (session_id) DO UPDATE
         SET subtotal = EXCLUDED.subtotal, tax_total = EXCLUDED.tax_total, tip_rate = EXCLUDED.tip_rate, tip_total = EXCLUDED.tip_total,
             grand_total = EXCLUDED.grand_total, customer_name = EXCLUDED.customer_name, customer_doc = EXCLUDED.customer_doc,
             customer_email = EXCLUDED.customer_email
       WHERE invoices.status = 'DRAFT'
       RETURNING id`,
      [
        staff.rid, bill.sessionId, tableId, totals.subtotal, totals.taxName, totals.taxRate, totals.taxTotal, totals.tipRate,
        totals.tipTotal, totals.grandTotal, input.customerName || null, input.customerDoc || null, input.customerEmail || null,
      ],
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

  // 3) Emisión de la factura y cierre de la mesa
  const issuedAt = new Date();
  const seq = await queryOne<{ n: number }>(`SELECT nextval('invoice_number_seq') AS n`);
  const invoiceNumber = `${restaurant.invoicePrefix}${seq!.n}`;
  const customerDoc = input.customerDoc || '222222222222';
  const eInvoice = await eInvoiceProvider.issue({
    invoiceNumber,
    issuerTaxId: restaurant.taxId,
    customerDoc,
    subtotal: draft.totals.subtotal,
    taxTotal: draft.totals.taxTotal,
    grandTotal: draft.totals.grandTotal,
    issuedAt,
  });

  await tx(async (db) => {
    // Si entró una comanda nueva entre la liquidación y el pago, la cuenta cambió: no se cierra.
    // (Con una pasarela real, aquí además se anula la autorización.)
    const bill = await loadOpenBill(db, staff.rid, tableId, true);
    if (!bill || bill.sessionId !== draft.sessionId || bill.gross !== draft.gross || bill.ordersInProgress > 0) {
      throw conflict('La cuenta cambió mientras se procesaba el pago. Vuelve a cobrar.', 'BILL_CHANGED');
    }

    await db.query(
      `INSERT INTO payments (invoice_id, method, amount, amount_received, change_due, status, reference, validated_by, validated_at)
       VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, $7, now())`,
      [draft.invoiceId, input.method, draft.totals.grandTotal, input.amountReceived, payment.changeDue, payment.reference, staff.sub],
    );
    await db.query(
      `UPDATE invoices SET status = 'ISSUED', invoice_number = $2, cufe = $3, provider = $4, provider_response = $5, issued_at = $6
        WHERE id = $1`,
      [draft.invoiceId, invoiceNumber, eInvoice.cufe, eInvoice.provider, JSON.stringify(eInvoice.raw), issuedAt],
    );
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [draft.sessionId]);
    await db.query('UPDATE waiter_calls SET attended_at = now(), attended_by = $2 WHERE session_id = $1 AND attended_at IS NULL', [draft.sessionId, staff.sub]);
    // El trigger de la base de datos verifica aquí que el pago aprobado cubra la factura emitida.
    await db.query(`UPDATE table_sessions SET closed_at = now(), closed_by = $2, close_reason = 'PAID' WHERE id = $1`, [draft.sessionId, staff.sub]);
    await refreshTableStatus(db, tableId);
  });

  // 4) Avisos en tiempo real
  const table = await publishTable(staff.rid, tableId);
  emit(rooms.session(draft.sessionId), 'session:closed', { reason: 'PAID', invoiceNumber, grandTotal: draft.totals.grandTotal });
  getIo().in(rooms.session(draft.sessionId)).socketsLeave(rooms.session(draft.sessionId));
  emit(rooms.staff(staff.rid), 'invoice:issued', { invoiceNumber, tableNumber: table.number, grandTotal: draft.totals.grandTotal });

  return {
    id: draft.invoiceId,
    invoiceNumber,
    tableNumber: table.number,
    subtotal: draft.totals.subtotal,
    taxName: draft.totals.taxName,
    taxRate: draft.totals.taxRate,
    taxTotal: draft.totals.taxTotal,
    tipTotal: draft.totals.tipTotal,
    grandTotal: draft.totals.grandTotal,
    customerName: input.customerName || 'Consumidor final',
    customerDoc,
    cufe: eInvoice.cufe,
    issuedAt: issuedAt.toISOString(),
    payment: { method: input.method, amountReceived: input.amountReceived, changeDue: payment.changeDue, reference: payment.reference! },
    simulated: eInvoice.provider === 'MOCK',
  };
}
