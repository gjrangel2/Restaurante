import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Pasarelas de pago en línea.
 *
 * El resto del sistema solo conoce la interfaz OnlineGateway. Hay tres:
 *   · Wompi        Web Checkout (redirección) con firma de integridad.
 *   · Mercado Pago Checkout Pro (preferencia + redirección).
 *   · Pruebas      Pasarela propia para desarrollar sin credenciales: no
 *                  mueve dinero y lo dice en pantalla.
 *
 * Regla de oro: el estado de un pago lo dicen la API del proveedor o su
 * webhook firmado. La redirección del navegador solo trae una pista (el id
 * de la transacción) que se verifica contra la API.
 */
export type ProviderId = 'WOMPI' | 'MERCADOPAGO' | 'MOCK';
export type PaymentChannel = 'WOMPI' | 'MERCADOPAGO' | 'PSE';
export type ProviderOutcome = 'APPROVED' | 'DECLINED' | 'ERROR' | 'PENDING';

export interface CheckoutRequest {
  reference: string;
  amount: number; // en pesos (COP sin decimales)
  currency: string;
  description: string;
  channel: PaymentChannel;
  returnUrl: string; // la pasarela devuelve aquí al cliente
  notificationUrl?: string; // webhook (solo si hay dirección pública HTTPS)
  expiresAt: Date;
  customer: { name?: string; email?: string; phone?: string };
}

/** Lo que se sabe de una transacción después de consultarla al proveedor. */
export interface ProviderTransaction {
  outcome: ProviderOutcome;
  transactionId: string;
  reference: string;
  amount: number;
  currency: string;
  method: string | null; // CARD, PSE, NEQUI…
  rawStatus: string;
  raw: unknown;
}

export interface OnlineGateway {
  id: ProviderId;
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>;
  /** Consulta activa. hint = id que trajo la redirección; sin él se busca por referencia. */
  fetchTransaction(reference: string, hint?: string): Promise<ProviderTransaction | null>;
}

export class GatewayError extends Error {}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Compara dos firmas en tiempo constante (evita ataques por tiempo de respuesta). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new GatewayError(`No se pudo contactar a la pasarela: ${(err as Error).message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GatewayError(`La pasarela respondió ${response.status}: ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return body;
}

// ============================================================================
// Wompi
// ============================================================================
const wompiConf = config.payments.wompi;
const wompiApiBase = () => (wompiConf.publicKey?.startsWith('pub_prod_') ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1');

/**
 * Firma de integridad: SHA-256 de referencia + monto en centavos + moneda
 * [+ fecha de expiración] + secreto de integridad. Se calcula SIEMPRE en el
 * servidor: con el secreto en el navegador, cualquiera cambiaría el monto.
 */
export function wompiIntegritySignature(reference: string, amountInCents: number, currency: string, secret: string, expirationTime?: string): string {
  return sha256(`${reference}${amountInCents}${currency}${expirationTime ?? ''}${secret}`);
}

/**
 * Valida un evento de Wompi: concatena los valores de signature.properties
 * (rutas dentro de data), luego el timestamp y el secreto de eventos, y
 * compara el SHA-256 con el checksum del evento.
 */
export function wompiEventIsValid(event: any, eventsSecret: string, headerChecksum?: string): boolean {
  const properties: unknown = event?.signature?.properties;
  const checksum: unknown = headerChecksum ?? event?.signature?.checksum;
  if (!Array.isArray(properties) || typeof checksum !== 'string' || event?.timestamp === undefined) return false;

  const values = properties.map((path: string) =>
    String(path.split('.').reduce<any>((node, key) => (node == null ? undefined : node[key]), event.data) ?? ''),
  );
  return safeEqual(sha256(`${values.join('')}${event.timestamp}${eventsSecret}`), checksum);
}

const WOMPI_OUTCOME: Record<string, ProviderOutcome> = { APPROVED: 'APPROVED', DECLINED: 'DECLINED', VOIDED: 'DECLINED', ERROR: 'ERROR', PENDING: 'PENDING' };

export function wompiTransaction(tx: any): ProviderTransaction {
  return {
    outcome: WOMPI_OUTCOME[tx.status] ?? 'PENDING',
    transactionId: String(tx.id),
    reference: String(tx.reference),
    amount: Number(tx.amount_in_cents) / 100,
    currency: String(tx.currency),
    method: tx.payment_method_type ?? null,
    rawStatus: String(tx.status),
    raw: tx,
  };
}

const wompiGateway: OnlineGateway = {
  id: 'WOMPI',
  async createCheckout(request) {
    const amountInCents = Math.round(request.amount * 100);
    const expiration = request.expiresAt.toISOString();
    const params = new URLSearchParams({
      'public-key': wompiConf.publicKey!,
      currency: request.currency,
      'amount-in-cents': String(amountInCents),
      reference: request.reference,
      'signature:integrity': wompiIntegritySignature(request.reference, amountInCents, request.currency, wompiConf.integritySecret!, expiration),
      'redirect-url': request.returnUrl,
      'expiration-time': expiration,
    });
    if (request.customer.email) params.set('customer-data:email', request.customer.email);
    if (request.customer.name) params.set('customer-data:full-name', request.customer.name);
    // Web Checkout muestra los medios habilitados en la cuenta (tarjeta, PSE, Nequi…);
    // si el cliente eligió PSE, lo selecciona allí.
    return { url: `https://checkout.wompi.co/p/?${params.toString()}` };
  },
  async fetchTransaction(reference, hint) {
    if (!hint) return null; // Wompi trae el id en la redirección (?id=…) o en el webhook
    const body = await fetchJson(`${wompiApiBase()}/transactions/${encodeURIComponent(hint)}`, {
      headers: { Authorization: `Bearer ${wompiConf.publicKey}` },
    });
    const tx = wompiTransaction(body.data);
    return tx.reference === reference ? tx : null;
  },
};

// ============================================================================
// Mercado Pago
// ============================================================================
const mpConf = config.payments.mercadoPago;
const MP_API = 'https://api.mercadopago.com';

const MP_OUTCOME: Record<string, ProviderOutcome> = {
  approved: 'APPROVED',
  authorized: 'PENDING',
  pending: 'PENDING',
  in_process: 'PENDING',
  in_mediation: 'PENDING',
  rejected: 'DECLINED',
  cancelled: 'DECLINED',
  refunded: 'DECLINED',
  charged_back: 'DECLINED',
};

function mpTransaction(payment: any): ProviderTransaction {
  return {
    outcome: MP_OUTCOME[payment.status] ?? 'PENDING',
    transactionId: String(payment.id),
    reference: String(payment.external_reference ?? ''),
    amount: Number(payment.transaction_amount),
    currency: String(payment.currency_id),
    // bank_transfer = PSE en Colombia
    method: payment.payment_type_id === 'bank_transfer' ? 'PSE' : (payment.payment_type_id ?? null),
    rawStatus: String(payment.status),
    raw: payment,
  };
}

/**
 * Valida la cabecera x-signature de un webhook de Mercado Pago:
 * HMAC-SHA256 (con la clave secreta del webhook) de
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;", omitiendo lo que no venga.
 */
export function mercadoPagoSignatureIsValid(xSignature: string | undefined, xRequestId: string | undefined, dataId: string | undefined, secret: string): boolean {
  if (!xSignature) return false;
  const parts = Object.fromEntries(
    xSignature.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key.trim(), rest.join('=').trim()];
    }),
  );
  if (!parts.ts || !parts.v1) return false;
  // Los ids alfanuméricos se firman en minúsculas.
  const id = dataId && /[a-z]/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `${id ? `id:${id};` : ''}${xRequestId ? `request-id:${xRequestId};` : ''}ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return safeEqual(expected, parts.v1);
}

const mercadoPagoGateway: OnlineGateway = {
  id: 'MERCADOPAGO',
  async createCheckout(request) {
    const https = request.returnUrl.startsWith('https://');
    const body: Record<string, unknown> = {
      items: [{ id: request.reference, title: request.description, quantity: 1, unit_price: request.amount, currency_id: request.currency }],
      external_reference: request.reference,
      payer: { name: request.customer.name, email: request.customer.email },
      back_urls: { success: request.returnUrl, pending: request.returnUrl, failure: request.returnUrl },
      // Mercado Pago solo regresa solo al sitio con URLs HTTPS; en local el cliente usa "Volver al sitio".
      ...(https ? { auto_return: 'approved' } : {}),
      ...(request.notificationUrl ? { notification_url: request.notificationUrl } : {}),
      expires: true,
      expiration_date_to: request.expiresAt.toISOString(),
      statement_descriptor: 'FRICTIONLESS',
    };
    if (request.channel === 'PSE') {
      // Deja solo la transferencia bancaria (PSE). El dinero en cuenta no se puede excluir.
      body.payment_methods = { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }] };
    }
    const preference = await fetchJson(`${MP_API}/checkout/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mpConf.accessToken}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': request.reference },
      body: JSON.stringify(body),
    });
    const testCredentials = mpConf.accessToken!.startsWith('TEST-');
    const url = (testCredentials && preference.sandbox_init_point) || preference.init_point;
    if (!url) throw new GatewayError('Mercado Pago no devolvió la dirección de pago');
    return { url };
  },
  async fetchTransaction(reference, hint) {
    const headers = { Authorization: `Bearer ${mpConf.accessToken}` };
    if (hint) {
      const tx = mpTransaction(await fetchJson(`${MP_API}/v1/payments/${encodeURIComponent(hint)}`, { headers }));
      return tx.reference === reference ? tx : null;
    }
    // Sin pista: el pago más reciente con esa referencia.
    const search = await fetchJson(
      `${MP_API}/v1/payments/search?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc&limit=1`,
      { headers },
    );
    const payment = search.results?.[0];
    return payment ? mpTransaction(payment) : null;
  },
};

/** Consulta un pago de Mercado Pago por id (lo usa el webhook). */
export async function fetchMercadoPagoPayment(paymentId: string): Promise<ProviderTransaction> {
  return mpTransaction(await fetchJson(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${mpConf.accessToken}` } }));
}

// ============================================================================
// Pasarela de pruebas
// ============================================================================
const mockGateway: OnlineGateway = {
  id: 'MOCK',
  async createCheckout(request) {
    // La página de pruebas vive en el propio frontend; returnUrl ya trae la base correcta.
    const base = request.returnUrl.slice(0, request.returnUrl.indexOf('/pago/'));
    return { url: `${base}/pago/prueba/${encodeURIComponent(request.reference)}` };
  },
  async fetchTransaction() {
    return null; // el estado lo fija quien usa la página de pruebas
  },
};

// ============================================================================
// Selección de pasarela
// ============================================================================
export const providerIsLive = {
  WOMPI: () => !config.payments.forceTest && Boolean(wompiConf.publicKey && wompiConf.integritySecret),
  MERCADOPAGO: () => !config.payments.forceTest && Boolean(mpConf.accessToken),
};

/** Qué pasarela procesa lo que eligió el cliente, y si lo hace en vivo o en pruebas. */
export function resolveGateway(channel: PaymentChannel): { gateway: OnlineGateway; live: boolean } {
  const provider = channel === 'PSE' ? config.payments.pseProvider : channel;
  if (providerIsLive[provider]()) return { gateway: provider === 'WOMPI' ? wompiGateway : mercadoPagoGateway, live: true };
  return { gateway: mockGateway, live: false };
}

export function gatewayFor(provider: ProviderId): OnlineGateway {
  return provider === 'WOMPI' ? wompiGateway : provider === 'MERCADOPAGO' ? mercadoPagoGateway : mockGateway;
}

/** Opciones de pago en línea que ve el cliente. */
export function availableChannels() {
  const pseVia = config.payments.pseProvider;
  return [
    { id: 'WOMPI' as const, label: 'Wompi', detail: 'Tarjeta, Nequi, Bancolombia y más', live: providerIsLive.WOMPI() },
    { id: 'MERCADOPAGO' as const, label: 'Mercado Pago', detail: 'Tarjeta o saldo de Mercado Pago', live: providerIsLive.MERCADOPAGO() },
    { id: 'PSE' as const, label: 'PSE', detail: 'Débito desde tu cuenta bancaria', live: providerIsLive[pseVia](), via: pseVia },
  ];
}
