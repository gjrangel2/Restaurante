import { Check, CircleAlert, LoaderCircle, ReceiptText, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { LazyImage } from '../../components/LazyImage';
import { clock, money } from '../../lib/format';
import type { BillPreview, Guest, Order, OrderStatus, PaymentOption, RestaurantInfo } from '../../lib/types';
import { PaymentPicker, type PaymentChoice } from '../payments/PaymentPicker';
import { BottomSheet, GuestAvatar, Stepper } from './parts';
import type { SharedCart } from './useSharedCart';

// ----------------------------------------------------------------------------
// Pestaña "Pedido": el carrito compartido de la mesa + seguimiento de lo enviado
// ----------------------------------------------------------------------------
interface CartViewProps {
  cart: SharedCart;
  me: Guest;
  orders: Order[];
  currency: string;
  sending: boolean;
  onSend: () => void;
  onBrowse: () => void;
}

export function CartView({ cart, me, orders, currency, sending, onSend, onBrowse }: CartViewProps) {
  const empty = cart.cart.items.length === 0;

  return (
    <div className="space-y-8 px-5 pb-6 pt-6">
      <section aria-labelledby="cart-title">
        <h2 id="cart-title" className="font-display text-3xl font-bold leading-none text-tinta">
          Pedido de la mesa
        </h2>
        <p className="mt-1.5 text-sm text-tinta-soft">Lo que agregue cualquiera en la mesa aparece aquí al instante.</p>

        {empty ? (
          <div className="mt-5 rounded-3xl bg-niebla p-6 text-center">
            <p className="text-tinta-soft">{orders.length > 0 ? 'No hay nada nuevo por enviar.' : 'Aún no han agregado nada.'}</p>
            <button type="button" onClick={onBrowse} className="mt-3 rounded-full bg-hoja px-5 py-2.5 text-sm font-semibold text-white">
              Ver la carta
            </button>
          </div>
        ) : (
          <>
            <div className="mt-5 space-y-5">
              {cart.byGuest.map(({ guest, lines }) => (
                <div key={guest.id}>
                  <div className="mb-2 flex items-center gap-2">
                    <GuestAvatar guest={guest} size="sm" />
                    <span className="text-sm font-semibold text-tinta">
                      {guest.alias}
                      {guest.id === me.id && <span className="font-normal text-tinta-soft"> (tú)</span>}
                    </span>
                  </div>
                  <ul className="space-y-3">
                    {lines.map((line) => (
                      <li key={line.id} className="flex items-center gap-3">
                        <LazyImage src={line.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-tinta">{line.name}</p>
                          {line.notes && <p className="truncate text-sm text-tinta-soft">“{line.notes}”</p>}
                          {line.isAvailable ? (
                            <p className="text-sm tabular-nums text-tinta-soft">{money(line.unitPrice * line.quantity, currency)}</p>
                          ) : (
                            <p className="flex items-center gap-1 text-sm font-medium text-red-700">
                              <CircleAlert className="h-4 w-4" aria-hidden /> Se agotó: quítalo para enviar
                            </p>
                          )}
                        </div>
                        <Stepper quantity={line.quantity} label={line.name} onChange={(next) => cart.setQuantity(line, next)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-baseline justify-between border-t border-hoja/10 pt-4">
              <span className="text-tinta-soft">Subtotal</span>
              <span className="font-display text-2xl font-bold tabular-nums text-tinta">{money(cart.cart.subtotal, currency)}</span>
            </div>
            <button
              type="button"
              onClick={onSend}
              disabled={sending || cart.hasUnavailable}
              className="mt-4 h-14 w-full rounded-full bg-maiz text-lg font-bold text-tinta transition active:scale-[0.98] disabled:opacity-50"
            >
              {sending ? 'Enviando…' : 'Enviar pedido'}
            </button>
            <p className="mt-2 text-center text-sm text-tinta-soft">Tu camarero lo confirma y pasa a cocina.</p>
          </>
        )}
      </section>

      {orders.length > 0 && (
        <section aria-labelledby="sent-title">
          <h2 id="sent-title" className="font-display text-xl font-bold text-tinta">
            Ya enviado
          </h2>
          <ul className="mt-3 space-y-3">
            {[...orders].reverse().map((order) => (
              <OrderTracker key={order.id} order={order} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const STEPS: Array<{ label: string; reached: OrderStatus[] }> = [
  { label: 'Recibido', reached: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED'] },
  { label: 'En cocina', reached: ['CONFIRMED', 'PREPARING', 'READY', 'SERVED'] },
  { label: 'Listo', reached: ['READY', 'SERVED'] },
  { label: 'En tu mesa', reached: ['SERVED'] },
];

const STATUS_TEXT: Record<OrderStatus, string> = {
  PENDING: 'Esperando a que tu camarero lo confirme',
  CONFIRMED: 'Confirmado, en cola de cocina',
  PREPARING: 'Lo están preparando',
  READY: 'Listo: ya va para tu mesa',
  SERVED: 'Entregado. ¡Buen provecho!',
  CANCELLED: 'No se pudo tomar este pedido. Habla con tu camarero.',
};

/** Seguimiento de una comanda: Recibido → En cocina → Listo → En tu mesa (es una secuencia real). */
function OrderTracker({ order }: { order: Order }) {
  const cancelled = order.status === 'CANCELLED';
  return (
    <li className={`rounded-3xl border p-4 ${cancelled ? 'border-red-200 bg-red-50' : 'border-hoja/10 bg-white'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold text-tinta">{STATUS_TEXT[order.status]}</p>
        <span className="shrink-0 text-xs text-tinta-soft">{clock(order.createdAt)}</span>
      </div>

      {!cancelled && (
        <ol className="mt-3 grid grid-cols-4 gap-1.5" aria-label="Avance del pedido">
          {STEPS.map((step) => {
            const done = step.reached.includes(order.status);
            return (
              <li key={step.label}>
                <span className={`block h-1.5 rounded-full ${done ? 'bg-hoja' : 'bg-hoja/15'}`} />
                <span className={`mt-1 flex items-center gap-0.5 text-[11px] ${done ? 'font-semibold text-hoja' : 'text-tinta-soft'}`}>
                  {done && <Check className="h-3 w-3" aria-hidden />}
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <ul className="mt-3 space-y-1 text-sm text-tinta-soft">
        {order.items.map((item) => (
          <li key={item.id} className="flex gap-2">
            <span className="w-6 shrink-0 font-semibold tabular-nums text-tinta">{item.quantity}×</span>
            <span className="min-w-0 flex-1">
              {item.name}
              {item.guestAlias && ` (${item.guestAlias})`}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

// ----------------------------------------------------------------------------
// Pestaña "Cuenta": lo consumido hasta ahora y botón para pedir la cuenta
// ----------------------------------------------------------------------------
interface BillViewProps {
  token: string;
  refreshKey: number; // cambia cuando alguien empieza o termina un pago en línea
  orders: Order[];
  restaurant: RestaurantInfo;
  billRequested: boolean;
  onRequestBill: () => void;
  onBrowse: () => void;
}

export function BillView({ token, refreshKey, orders, restaurant, billRequested, onRequestBill, onBrowse }: BillViewProps) {
  const { currency } = restaurant;
  const billable = orders.filter((order) => order.status !== 'CANCELLED');
  const consumed = billable.reduce((sum, order) => sum + order.total, 0);

  // Misma liquidación que hace el backend al cobrar (allí es donde vale).
  const rate = (restaurant.taxRate ?? 0) / 100;
  const tax = restaurant.pricesIncludeTax === false ? Math.round(consumed * rate) : Math.round(consumed - consumed / (1 + rate));
  const base = restaurant.pricesIncludeTax === false ? consumed : consumed - tax;
  const tip = Math.round((base * restaurant.suggestedTipRate) / 100);

  // Un renglón por plato, sumando lo que se repite entre comandas.
  const lines = new Map<string, { name: string; quantity: number; amount: number }>();
  for (const order of billable) {
    for (const item of order.items) {
      if (item.status === 'CANCELLED') continue;
      const line = lines.get(item.name) ?? { name: item.name, quantity: 0, amount: 0 };
      line.quantity += item.quantity;
      line.amount += item.quantity * item.unitPrice;
      lines.set(item.name, line);
    }
  }

  if (billable.length === 0) {
    return (
      <div className="px-5 pt-6">
        <h2 className="font-display text-3xl font-bold leading-none text-tinta">Cuenta</h2>
        <div className="mt-5 rounded-3xl bg-niebla p-6 text-center">
          <p className="text-tinta-soft">Cuando envíen su primer pedido, aquí verán cuánto llevan.</p>
          <button type="button" onClick={onBrowse} className="mt-3 rounded-full bg-hoja px-5 py-2.5 text-sm font-semibold text-white">
            Ver la carta
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 pb-6 pt-6">
      <h2 className="font-display text-3xl font-bold leading-none text-tinta">Cuenta</h2>
      <p className="mt-1.5 text-sm text-tinta-soft">Lo que la mesa lleva hasta ahora.</p>

      <ul className="mt-5 space-y-2">
        {[...lines.values()].map((line) => (
          <li key={line.name} className="flex gap-2 text-tinta">
            <span className="w-7 shrink-0 font-semibold tabular-nums">{line.quantity}×</span>
            <span className="min-w-0 flex-1">{line.name}</span>
            <span className="tabular-nums text-tinta-soft">{money(line.amount, currency)}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-5 space-y-2 rounded-3xl bg-niebla p-5">
        <div className="flex items-baseline justify-between">
          <dt className="font-semibold text-tinta">Consumo</dt>
          <dd className="font-display text-3xl font-bold tabular-nums text-tinta">{money(restaurant.pricesIncludeTax === false ? consumed + tax : consumed, currency)}</dd>
        </div>
        {rate > 0 && (
          <div className="flex justify-between text-sm text-tinta-soft">
            <dt>
              {restaurant.pricesIncludeTax === false ? 'Más' : 'Incluye'} {restaurant.taxName} {restaurant.taxRate}%
            </dt>
            <dd className="tabular-nums">{money(tax, currency)}</dd>
          </div>
        )}
        {tip > 0 && (
          <div className="flex justify-between text-sm text-tinta-soft">
            <dt>Propina sugerida {restaurant.suggestedTipRate}% (voluntaria)</dt>
            <dd className="tabular-nums">{money(tip, currency)}</dd>
          </div>
        )}
      </dl>

      <PayFromPhone token={token} refreshKey={refreshKey} ordersKey={orders.map((o) => `${o.id}:${o.status}`).join(',')} />

      {billRequested ? (
        <p className="mt-3 flex items-center justify-center gap-2 rounded-full bg-hoja px-5 py-4 font-semibold text-white" role="status">
          <Check className="h-5 w-5" aria-hidden /> Cuenta pedida. Tu camarero ya viene.
        </p>
      ) : (
        <button
          type="button"
          onClick={onRequestBill}
          className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-full border-2 border-hoja/15 text-lg font-bold text-tinta transition active:scale-[0.98]"
        >
          <ReceiptText className="h-5 w-5" aria-hidden /> Pagar con el camarero
        </button>
      )}
      <p className="mt-2 text-center text-sm text-tinta-soft">Con el camarero: efectivo, tarjeta o transferencia.</p>
    </div>
  );
}

/**
 * Pagar la cuenta de la mesa desde el celular. La mesa se cierra sola cuando
 * la pasarela confirma el pago; mientras tanto, nadie más puede pagar ni
 * pedir (así el total no cambia a mitad del pago).
 */
function PayFromPhone({ token, refreshKey, ordersKey }: { token: string; refreshKey: number; ordersKey: string }) {
  const toast = useToast();
  const [data, setData] = useState<{ bill: BillPreview | null; payments: PaymentOption[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [tipRate, setTipRate] = useState<number | null>(null);
  const [choice, setChoice] = useState<PaymentChoice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ bill: BillPreview | null; payments: PaymentOption[] }>('/guest/bill', token).then(setData).catch(() => undefined);
  }, [token, refreshKey, ordersKey]);

  const bill = data?.bill;
  if (!bill || bill.totals.gross <= 0 || !data?.payments.length) return null;

  const suggested = bill.suggestedTipRate;
  const tip = tipRate ?? suggested;
  const { subtotal, taxTotal } = bill.totals;
  const tipTotal = Math.round((subtotal * tip) / 100);
  const total = subtotal + taxTotal + tipTotal;

  if (bill.onlinePayment) {
    return (
      <p className="mt-5 flex items-center justify-center gap-2 rounded-2xl bg-hoja-100 px-4 py-4 text-center font-semibold text-hoja" role="status">
        <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden /> Alguien de la mesa está pagando la cuenta…
      </p>
    );
  }

  const pay = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const result = await api.post<{ checkoutUrl: string }>('/guest/bill/checkout', { channel: choice, tipRate: tip }, token);
      window.location.assign(result.checkoutUrl); // a la pasarela; vuelve a /pago/resultado
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={!bill.canCharge}
        onClick={() => setOpen(true)}
        className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-full bg-maiz text-lg font-bold text-tinta transition active:scale-[0.98] disabled:opacity-50"
      >
        <Smartphone className="h-5 w-5" aria-hidden /> Pagar desde mi celular
      </button>
      {!bill.canCharge && bill.ordersInProgress > 0 && (
        <p className="mt-2 text-center text-sm text-tinta-soft">Podrás pagar en línea cuando todos los platos estén en la mesa.</p>
      )}

      {open && (
        <BottomSheet title="Pagar la cuenta" onClose={() => !busy && setOpen(false)}>
          <div className="p-5 pt-6">
            <h2 className="font-display text-2xl font-bold text-tinta">Pagar la cuenta</h2>
            <p className="mt-1 text-sm text-tinta-soft">Al aprobarse el pago, la mesa queda cerrada y recibes la factura.</p>

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-tinta">Propina voluntaria</span>
              <span className="flex overflow-hidden rounded-full border border-hoja/15 text-sm font-semibold">
                {[0, suggested].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    aria-pressed={tip === rate}
                    onClick={() => setTipRate(rate)}
                    className={`px-4 py-1.5 ${tip === rate ? 'bg-hoja text-white' : 'text-tinta-soft'}`}
                  >
                    {rate === 0 ? 'Sin propina' : `${rate}%`}
                  </button>
                ))}
              </span>
            </div>

            <div className="mt-4">
              <PaymentPicker online={data.payments} value={choice} onChange={setChoice} />
            </div>

            <button
              type="button"
              disabled={!choice || busy}
              onClick={() => void pay()}
              className="mt-5 flex h-14 w-full items-center justify-between rounded-full bg-maiz px-6 text-lg font-bold text-tinta disabled:opacity-50"
            >
              <span>{busy ? 'Abriendo la pasarela…' : 'Pagar'}</span>
              <span className="tabular-nums">{money(total, bill.currency)}</span>
            </button>
          </div>
        </BottomSheet>
      )}
    </>
  );
}
