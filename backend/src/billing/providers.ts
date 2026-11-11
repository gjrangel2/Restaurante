import crypto from 'node:crypto';

/**
 * Puertos de facturación. El resto del sistema solo conoce estas dos
 * interfaces; las implementaciones de este archivo son SIMULADAS para poder
 * desarrollar y demostrar el flujo completo sin credenciales reales.
 *
 * Para salir a producción se sustituyen por adaptadores reales:
 *   · EInvoiceProvider → un proveedor tecnológico de factura electrónica
 *     habilitado por la DIAN (el adaptador arma el documento y recibe el CUFE).
 *   · PaymentGateway   → datáfono o pasarela de pagos.
 * Nada más cambia: billing.service.ts ya trabaja contra las interfaces.
 */

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export interface PaymentRequest {
  method: PaymentMethod;
  amountDue: number;
  amountReceived: number;
}

export interface PaymentResult {
  approved: boolean;
  reference: string | null;
  changeDue: number;
  reason?: string;
}

export interface PaymentGateway {
  authorize(request: PaymentRequest): Promise<PaymentResult>;
}

export interface EInvoiceDraft {
  invoiceNumber: string;
  issuerTaxId: string | null;
  customerDoc: string;
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  issuedAt: Date;
}

export interface EInvoiceResult {
  cufe: string;
  provider: string;
  raw: Record<string, unknown>;
}

export interface EInvoiceProvider {
  issue(draft: EInvoiceDraft): Promise<EInvoiceResult>;
}

/** Pasarela simulada: aprueba si lo recibido cubre el total; calcula el cambio en efectivo. */
export const mockPaymentGateway: PaymentGateway = {
  async authorize({ method, amountDue, amountReceived }) {
    if (amountReceived < amountDue) {
      return { approved: false, reference: null, changeDue: 0, reason: 'El monto recibido no cubre el total de la cuenta' };
    }
    return {
      approved: true,
      reference: `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      changeDue: method === 'CASH' ? amountReceived - amountDue : 0,
    };
  },
};

/**
 * Facturación electrónica simulada. Devuelve un código con la misma forma que
 * un CUFE (hash SHA-384 de los datos de la factura), pero NO envía nada a la
 * DIAN ni tiene validez fiscal.
 */
export const mockEInvoiceProvider: EInvoiceProvider = {
  async issue(draft) {
    const seed = [
      draft.invoiceNumber,
      draft.issuedAt.toISOString(),
      draft.subtotal.toFixed(2),
      draft.taxTotal.toFixed(2),
      draft.grandTotal.toFixed(2),
      draft.issuerTaxId ?? '',
      draft.customerDoc,
    ].join('|');
    return {
      cufe: crypto.createHash('sha384').update(seed).digest('hex'),
      provider: 'MOCK',
      raw: { simulated: true, message: 'Factura simulada: no fue transmitida a la DIAN ni tiene validez fiscal.' },
    };
  },
};
