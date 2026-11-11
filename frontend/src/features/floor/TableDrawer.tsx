import { Banknote, Check, CreditCard, Landmark, Link2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { clock, elapsed, money } from '../../lib/format';
import type { Invoice, Order, OrderStatus, PaymentMethod, RestaurantTable, TableDetail } from '../../lib/types';
import { TABLE_STATUS, statusSentence } from './tableStatus';

interface TableDrawerProps {
  table: RestaurantTable; // siempre la versión más reciente del mapa
  token: string;
  now: number;
  refreshKey: number; // cambia cuando llega un evento en vivo de esta mesa
  onClose: () => void;
}

const ORDER_LABEL: Record<OrderStatus, { text: string; className: string }> = {
  PENDING: { text: 'Por confirmar', className: 'bg-state-waiting text-white' },
  CONFIRMED: { text: 'En cola de cocina', className: 'bg-sunken text-ink-soft' },
  PREPARING: { text: 'En preparación', className: 'bg-sunken text-ink-soft' },
  READY: { text: 'Lista para llevar', className: 'bg-state-served text-white' },
  SERVED: { text: 'Entregada', className: 'bg-sunken text-ink-faint' },
  CANCELLED: { text: 'Rechazada', className: 'bg-sunken text-ink-faint line-through' },
};

const METHODS: Array<{ id: PaymentMethod; label: string; icon: typeof Banknote }> = [
  { id: 'CASH', label: 'Efectivo', icon: Banknote },
  { id: 'CARD', label: 'Tarjeta', icon: CreditCard },
  { id: 'TRANSFER', label: 'Transferencia', icon: Landmark },
];

/**
 * Panel de una mesa: todo lo que el camarero hace sobre ella.
 * Abrirla (genera la sesión que habilita el QR), confirmar o rechazar
 * comandas, marcar entregas, atender llamados y cobrar. La mesa solo vuelve a
 * "Libre" cuando el backend valida el pago.
 */
export function TableDrawer({ table, token, now, refreshKey, onClose }: TableDrawerProps) {
  const toast = useToast();
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<TableDetail>(`/tables/${table.id}`, token));
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [table.id, token, toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Al cambiar de mesa se descarta el recibo de la anterior.
  useEffect(() => {
    setInvoice(null);
    setDetail(null);
  }, [table.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Ejecuta una acción, muestra el error si falla y recarga el panel. */
  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.show(success, { tone: 'success' });
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const style = TABLE_STATUS[table.status];
  const session = table.session;
  const orders = detail?.orders ?? [];
  const liveOrders = orders.filter((order) => order.status !== 'CANCELLED');
  const guestUrl = `${window.location.origin}/mesa/${table.number}`;

  return (
    <>
      <div className="fixed inset-0 z-40 animate-fade-in bg-black/40 lg:hidden" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Mesa ${table.number}`}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] animate-sheet-up flex-col rounded-t-3xl border border-line bg-surface shadow-lift lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-[72px] lg:max-h-none lg:w-[420px] lg:animate-slide-in lg:rounded-3xl"
      >
        <header className="flex items-start gap-3 border-b border-line p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-2xl font-bold">Mesa {table.number}</h2>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.pill} ${style.blink ? 'animate-blink' : ''}`}>{style.label}</span>
            </div>
            <p className="mt-0.5 text-sm text-ink-soft">
              {table.zone}, {table.seats} puestos
              {session && `, abierta hace ${elapsed(session.openedAt, now)}`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label="Cerrar panel">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {invoice ? (
            <Receipt invoice={invoice} onDone={onClose} />
          ) : !session ? (
            <ClosedTable
              guestUrl={guestUrl}
              busy={busy === 'open'}
              onOpen={() => run('open', () => api.post(`/tables/${table.id}/open`, {}, token), `Mesa ${table.number} abierta: el QR ya acepta pedidos`)}
            />
          ) : (
            <>
              {session.call && (
                <div className="flex items-center gap-3 rounded-2xl bg-state-calling p-4 text-white">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{statusSentence(table)}</p>
                    <p className="text-sm text-white/80">hace {elapsed(session.call.createdAt, now)}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy === 'attend'}
                    onClick={() => run('attend', () => api.post(`/tables/${table.id}/attend`, {}, token))}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-state-calling disabled:opacity-60"
                  >
                    Atender
                  </button>
                </div>
              )}

              {detail && detail.guests.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink-soft">En la mesa</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {detail.guests.map((guest) => (
                      <li key={guest.id} className="flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-sm">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: guest.color }} aria-hidden /> {guest.alias}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-soft">Comandas</h3>
                {!detail ? (
                  <div className="h-24 animate-pulse rounded-2xl bg-sunken" />
                ) : orders.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
                    Todavía no han pedido. Los clientes entran escaneando el QR de la mesa.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {orders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        busy={busy}
                        onConfirm={() => run(`confirm-${order.id}`, () => api.post(`/orders/${order.id}/confirm`, {}, token), 'Comanda enviada a cocina')}
                        onReject={() => run(`reject-${order.id}`, () => api.post(`/orders/${order.id}/reject`, {}, token))}
                        onServe={() => run(`serve-${order.id}`, () => api.post(`/orders/${order.id}/serve`, {}, token))}
                      />
                    ))}
                  </ul>
                )}
              </div>

              {detail?.bill && liveOrders.length > 0 && (
                <Checkout
                  detail={detail}
                  busy={busy === 'pay'}
                  onPay={async (input) => {
                    setBusy('pay');
                    try {
                      setInvoice(await api.post<Invoice>(`/tables/${table.id}/pay`, input, token));
                    } catch (err) {
                      toast.show(errorMessage(err), { tone: 'error' });
                      void load();
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              )}

              {detail && liveOrders.length === 0 && (
                <div className="space-y-3">
                  <GuestLink guestUrl={guestUrl} />
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={busy === 'cancel'}
                    onClick={() => run('cancel', () => api.post(`/tables/${table.id}/cancel`, {}, token), `Mesa ${table.number} cerrada sin consumo`)}
                  >
                    Cerrar sin consumo
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function ClosedTable({ guestUrl, busy, onOpen }: { guestUrl: string; busy: boolean; onOpen: () => void }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        La mesa está cerrada: quien escanee su QR verá una pantalla de espera y no podrá pedir. Ábrela cuando los clientes se sienten.
      </p>
      <Button className="w-full py-3 text-base" disabled={busy} onClick={onOpen}>
        Abrir mesa
      </Button>
      <GuestLink guestUrl={guestUrl} showQr />
    </div>
  );
}

/** Enlace (y QR) de la mesa. El QR es estático: se imprime una vez y sirve siempre. */
function GuestLink({ guestUrl, showQr = false }: { guestUrl: string; showQr?: boolean }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(guestUrl);
      toast.show('Enlace copiado');
    } catch {
      toast.show('No se pudo copiar. Selecciona el enlace y cópialo a mano.', { tone: 'error' });
    }
  };
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line p-4">
      {showQr && (
        <div className="rounded-xl bg-white p-2">
          <QRCodeSVG value={guestUrl} size={88} aria-label="Código QR de la mesa" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">QR de la mesa</p>
        <p className="truncate text-sm text-ink-faint">{guestUrl}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" onClick={copy} className="flex items-center gap-1 whitespace-nowrap text-sm font-medium text-ink underline-offset-2 hover:underline">
            <Link2 className="h-4 w-4" aria-hidden /> Copiar enlace
          </button>
          <a href={guestUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap text-sm font-medium text-ink underline-offset-2 hover:underline">
            Abrir como cliente
          </a>
        </div>
      </div>
    </div>
  );
}

function OrderCard({
  order,
  busy,
  onConfirm,
  onReject,
  onServe,
}: {
  order: Order;
  busy: string | null;
  onConfirm: () => void;
  onReject: () => void;
  onServe: () => void;
}) {
  const label = ORDER_LABEL[order.status];
  const inKitchen = order.status === 'CONFIRMED' || order.status === 'PREPARING' || order.status === 'READY';
  return (
    <li className={`rounded-2xl border p-4 ${order.status === 'PENDING' ? 'border-state-waiting' : 'border-line'} ${order.status === 'CANCELLED' ? 'opacity-60' : ''}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold tabular-nums">#{order.number}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${label.className}`}>{label.text}</span>
        <span className="ml-auto text-xs text-ink-faint">{clock(order.createdAt)}</span>
      </div>
      <ul className="space-y-1.5 text-sm">
        {order.items.map((item) => (
          <li key={item.id} className="flex gap-2">
            <span className="w-6 shrink-0 font-semibold tabular-nums">{item.quantity}×</span>
            <span className="min-w-0 flex-1">
              {item.name}
              {item.guestAlias && <span className="text-ink-faint"> para {item.guestAlias}</span>}
              {item.notes && <span className="block text-ink-soft">“{item.notes}”</span>}
            </span>
            <span className="tabular-nums text-ink-soft">{money(item.unitPrice * item.quantity)}</span>
          </li>
        ))}
      </ul>

      {order.status === 'PENDING' && (
        <div className="mt-3 flex gap-2">
          <Button className="flex-1" disabled={busy === `confirm-${order.id}`} onClick={onConfirm}>
            Confirmar y enviar a cocina
          </Button>
          <Button variant="secondary" disabled={busy === `reject-${order.id}`} onClick={onReject}>
            Rechazar
          </Button>
        </div>
      )}
      {inKitchen && (
        <Button
          variant={order.status === 'READY' ? 'primary' : 'secondary'}
          className="mt-3 w-full"
          disabled={busy === `serve-${order.id}`}
          onClick={onServe}
        >
          Marcar entregada en la mesa
        </Button>
      )}
    </li>
  );
}

interface PayInput {
  method: PaymentMethod;
  amountReceived: number;
  tipRate: number;
  customerName?: string;
  customerDoc?: string;
}

function Checkout({ detail, busy, onPay }: { detail: TableDetail; busy: boolean; onPay: (input: PayInput) => void }) {
  const bill = detail.bill!;
  const [open, setOpen] = useState(false);
  const [tipRate, setTipRate] = useState(bill.suggestedTipRate);
  const [method, setMethod] = useState<PaymentMethod>('CARD');
  const [received, setReceived] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerDoc, setCustomerDoc] = useState('');

  // La propina se recalcula aquí para respuesta inmediata; el backend vuelve a liquidar al cobrar.
  const { subtotal, taxTotal, taxName, taxRate } = bill.totals;
  const tipTotal = Math.round((subtotal * tipRate) / 100);
  const total = subtotal + taxTotal + tipTotal;
  const amountReceived = method === 'CASH' ? Number(received.replace(/\D/g, '')) || 0 : total;
  const change = Math.max(0, amountReceived - total);

  return (
    <div className="rounded-2xl bg-sunken p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink-soft">Cuenta</h3>
      <dl className="space-y-1.5 text-sm">
        <Row label="Subtotal" value={money(subtotal, bill.currency)} />
        <Row label={`${taxName} ${taxRate}%`} value={money(taxTotal, bill.currency)} />
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-soft">Propina voluntaria</dt>
          <dd className="flex items-center gap-2">
            <span className="flex overflow-hidden rounded-lg border border-line bg-surface text-xs font-semibold">
              {[0, bill.suggestedTipRate].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  aria-pressed={tipRate === rate}
                  onClick={() => setTipRate(rate)}
                  className={`px-2.5 py-1 ${tipRate === rate ? 'bg-ink text-surface' : 'text-ink-soft'}`}
                >
                  {rate === 0 ? 'Sin' : `${rate}%`}
                </button>
              ))}
            </span>
            <span className="w-20 text-right tabular-nums">{money(tipTotal, bill.currency)}</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between border-t border-line pt-2">
          <dt className="font-semibold">Total</dt>
          <dd className="font-display text-2xl font-bold tabular-nums">{money(total, bill.currency)}</dd>
        </div>
      </dl>

      {!bill.canCharge ? (
        <p className="mt-3 text-sm text-ink-soft">Para cobrar, primero entrega o rechaza las comandas en curso.</p>
      ) : !open ? (
        <Button className="mt-4 w-full" onClick={() => setOpen(true)}>
          Cobrar
        </Button>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onPay({ method, amountReceived, tipRate, customerName: customerName || undefined, customerDoc: customerDoc || undefined });
          }}
        >
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Medio de pago">
            {METHODS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={method === id}
                onClick={() => setMethod(id)}
                className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold ${
                  method === id ? 'border-ink bg-surface text-ink' : 'border-line text-ink-soft'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {method === 'CASH' && (
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Efectivo recibido</span>
              <input
                inputMode="numeric"
                value={received}
                onChange={(event) => setReceived(event.target.value)}
                placeholder={String(total)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 tabular-nums outline-none focus:border-ink"
              />
              {amountReceived >= total && <span className="mt-1 block text-ink-soft">Cambio: {money(change, bill.currency)}</span>}
            </label>
          )}

          <details className="text-sm">
            <summary className="cursor-pointer text-ink-soft">Factura a nombre de (opcional)</summary>
            <div className="mt-2 grid gap-2">
              <input
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Nombre o razón social"
                aria-label="Nombre o razón social"
                className="rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-ink"
              />
              <input
                value={customerDoc}
                onChange={(event) => setCustomerDoc(event.target.value)}
                placeholder="Cédula o NIT"
                aria-label="Cédula o NIT"
                className="rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-ink"
              />
            </div>
          </details>

          <Button type="submit" className="w-full py-3" disabled={busy}>
            {busy ? 'Validando pago…' : 'Validar pago y cerrar mesa'}
          </Button>
        </form>
      )}
    </div>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-2">
    <dt className="text-ink-soft">{label}</dt>
    <dd className="tabular-nums">{value}</dd>
  </div>
);

function Receipt({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-state-served text-white">
          <Check className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="font-semibold">Pago validado. Mesa {invoice.tableNumber} libre.</p>
          <p className="text-sm text-ink-soft">Factura {invoice.invoiceNumber}</p>
        </div>
      </div>

      <dl className="space-y-1.5 rounded-2xl bg-sunken p-4 text-sm">
        <Row label="Cliente" value={invoice.customerName} />
        <Row label="Subtotal" value={money(invoice.subtotal)} />
        <Row label={`${invoice.taxName} ${invoice.taxRate}%`} value={money(invoice.taxTotal)} />
        <Row label="Propina" value={money(invoice.tipTotal)} />
        <div className="flex items-baseline justify-between border-t border-line pt-2">
          <dt className="font-semibold">Total</dt>
          <dd className="font-display text-xl font-bold tabular-nums">{money(invoice.grandTotal)}</dd>
        </div>
        {invoice.payment.changeDue > 0 && <Row label="Cambio a entregar" value={money(invoice.payment.changeDue)} />}
        <Row label="Autorización" value={invoice.payment.reference} />
      </dl>

      <div className="text-xs text-ink-faint">
        <p className="break-all">CUFE {invoice.cufe}</p>
        {invoice.simulated && <p className="mt-1 font-medium text-ink-soft">Factura simulada: no fue transmitida a la DIAN ni tiene validez fiscal.</p>}
      </div>

      <Button className="w-full" onClick={onDone}>
        Listo
      </Button>
    </div>
  );
}
