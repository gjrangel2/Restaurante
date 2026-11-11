import { Bike, Check, CircleX, Clock, KeyRound, Phone, Store } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MapView, type MapLine, type MapMarker } from '../../components/MapView';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { clock, money } from '../../lib/format';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { MapConfig, PaymentOption, Tracking } from '../../lib/types';
import { PaymentPicker, type PaymentChoice } from '../payments/PaymentPicker';
import { DELIVERY_STATUS, PAYMENT_LABEL, statusRank, trackingSteps, VEHICLE_LABEL } from './deliveryStatus';

/**
 * Seguimiento del pedido: /pedido/<código>.
 *
 * Mapa arriba (restaurante, destino, repartidor y su recorrido) y una hoja
 * con el estado, el tiempo estimado, el repartidor y el PIN de entrega. Todo
 * llega en vivo por WebSocket; el código de seguimiento es la credencial.
 */
export function TrackingPage() {
  const { code = '' } = useParams();
  const toast = useToast();
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [config, setConfig] = useState<{ map: MapConfig; payments: PaymentOption[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { socket, connected } = useSocket(code ? { trackingCode: code } : null);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api.get<Tracking>(`/public/delivery/track/${code}`),
        api.get<{ map: MapConfig; payments: PaymentOption[] }>('/public/config'),
      ]);
      setTracking(t);
      setConfig(c);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(socket, load);

  useSocketEvent<Tracking>(socket, 'delivery:updated', (next) => {
    setTracking((previous) => {
      if (previous && previous.status !== next.status) toast.show(DELIVERY_STATUS[next.status].customer);
      return next;
    });
  });

  useSocketEvent<{ lat: number; lng: number; etaMinutes: number }>(socket, 'courier:location', ({ lat, lng, etaMinutes }) => {
    setTracking((t) =>
      t && t.courier
        ? { ...t, etaMinutes, courier: { ...t.courier, lat, lng, lastSeenAt: new Date().toISOString() }, track: [...t.track, [lat, lng]] }
        : t,
    );
  });

  // Mapa: marcadores y líneas
  const { markers, lines, fitKey } = useMemo(() => {
    const markers: MapMarker[] = [];
    const lines: MapLine[] = [];
    if (!tracking) return { markers, lines, fitKey: '' };
    const r = tracking.restaurant;
    if (r.lat != null && r.lng != null) markers.push({ id: 'r', lat: Number(r.lat), lng: Number(r.lng), kind: 'restaurant', title: r.name });
    if (tracking.type === 'DELIVERY' && tracking.lat != null && tracking.lng != null) {
      markers.push({ id: 'd', lat: Number(tracking.lat), lng: Number(tracking.lng), kind: 'destination', color: '#E5484D', title: 'Tu dirección', active: true });
      // Lo que falta del viaje: desde el repartidor si ya va en camino, si no desde el restaurante.
      const c = tracking.courier;
      const from = tracking.status === 'ON_THE_WAY' && c?.lat != null && c.lng != null ? [Number(c.lat), Number(c.lng)] : r.lat != null && r.lng != null ? [Number(r.lat), Number(r.lng)] : null;
      if (from && tracking.status !== 'DELIVERED') {
        lines.push({ id: 'route', points: [from as [number, number], [Number(tracking.lat), Number(tracking.lng)]], color: '#0C3B2E', dashed: true, weight: 3 });
      }
    }
    if (tracking.track.length > 1) lines.push({ id: 'trail', points: tracking.track, color: '#16A34A', weight: 5 });
    const c = tracking.courier;
    if (c?.lat != null && c.lng != null && tracking.status === 'ON_THE_WAY') {
      markers.push({ id: 'c', lat: Number(c.lat), lng: Number(c.lng), kind: 'courier', vehicle: c.vehicle, color: '#16A34A', title: `${c.name} · ${VEHICLE_LABEL[c.vehicle]}` });
    }
    // Reencuadrar solo cuando cambia el estado (no con cada movimiento del repartidor).
    return { markers, lines, fitKey: `${tracking.status}` };
  }, [tracking]);

  if (error && !tracking) {
    return (
      <main className="grid min-h-dvh place-items-center bg-hoja p-8 text-center text-white">
        <div>
          <h1 className="font-display text-3xl font-bold">No encontramos tu pedido</h1>
          <p className="mt-2 text-white/75">{error}</p>
          <Link to="/domicilios" className="mt-6 inline-block rounded-full bg-maiz px-6 py-3 font-semibold text-tinta">
            Hacer un pedido
          </Link>
        </div>
      </main>
    );
  }

  if (!tracking || !config) {
    return <main className="min-h-dvh animate-pulse bg-niebla" aria-busy="true" aria-label="Cargando tu pedido" />;
  }

  const status = DELIVERY_STATUS[tracking.status];
  const steps = trackingSteps(tracking.type);
  const rank = statusRank(tracking.status);
  const done = tracking.status === 'DELIVERED';
  const cancelled = tracking.status === 'CANCELLED';
  const currency = tracking.restaurant.currency;

  return (
    <div className="min-h-dvh bg-niebla">
      <div className="relative mx-auto min-h-dvh max-w-md bg-white text-tinta shadow-lift">
        <MapView config={config.map} markers={markers} lines={lines} fitKey={fitKey} className="h-[46dvh] w-full" ariaLabel="Mapa del pedido" />

        <div className="relative z-10 -mt-8 rounded-t-[32px] bg-white px-5 pb-10 pt-6 shadow-dock">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-tinta-soft">
              {tracking.restaurant.name} · Pedido {tracking.code}
            </span>
            {!connected && !done && !cancelled && <span className="text-xs text-tinta-soft">Reconectando…</span>}
          </div>

          <h1 className="mt-2 font-display text-[2rem] font-extrabold leading-tight" aria-live="polite">
            {tracking.type === 'PICKUP' && tracking.status === 'READY' ? 'Tu pedido está listo para recoger' : status.customer}
          </h1>

          {!done && !cancelled && tracking.etaMinutes != null && (
            <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-maiz px-4 py-1.5 font-semibold">
              <Clock className="h-4 w-4" aria-hidden />
              {tracking.status === 'ON_THE_WAY' ? `Llega en ~${tracking.etaMinutes} min` : `Hora estimada ${tracking.estimatedAt ? clock(tracking.estimatedAt) : `en ~${tracking.etaMinutes} min`}`}
            </p>
          )}

          {/* Avance: es una secuencia real */}
          {!cancelled && tracking.status !== 'PENDING_PAYMENT' && (
            <ol className="mt-6 grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Avance del pedido">
              {steps.map((step) => {
                const reached = rank >= statusRank(step.status);
                const current = tracking.status === step.status;
                return (
                  <li key={step.status} aria-current={current ? 'step' : undefined}>
                    <span className={`block h-1.5 rounded-full ${reached ? 'bg-hoja' : 'bg-hoja/15'} ${current && !done ? 'animate-blink' : ''}`} />
                    <span className={`mt-1.5 block break-words text-[10.5px] leading-tight ${reached ? 'font-semibold text-hoja' : 'text-tinta-soft'}`}>{step.label}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {cancelled && (
            <div className="mt-5 flex gap-3 rounded-2xl bg-red-50 p-4 text-red-900">
              <CircleX className="h-5 w-5 shrink-0" aria-hidden />
              <div>
                <p className="font-semibold">{tracking.cancelReason ?? 'El pedido se canceló'}</p>
                {tracking.refundPending && <p className="mt-1 text-sm">Ya pagaste en línea: el restaurante te devolverá el dinero por el mismo medio.</p>}
              </div>
            </div>
          )}

          {tracking.status === 'PENDING_PAYMENT' && <PendingPayment code={code} payments={config.payments} total={tracking.total} currency={currency} onCancelled={setTracking} />}

          {/* Repartidor */}
          {tracking.courier && !done && !cancelled && tracking.type === 'DELIVERY' && (
            <div className="mt-6 flex items-center gap-3 rounded-2xl border border-hoja/10 p-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-green-600 text-white">
                <Bike className="h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {tracking.courier.name} {tracking.status === 'ON_THE_WAY' ? 'va en camino' : 'llevará tu pedido'}
                </p>
                <p className="text-sm text-tinta-soft">
                  {VEHICLE_LABEL[tracking.courier.vehicle]}
                  {tracking.courier.plate ? ` · ${tracking.courier.plate}` : ''}
                </p>
              </div>
              <a href={`tel:${tracking.courier.phone.replace(/\s/g, '')}`} className="grid h-11 w-11 place-items-center rounded-full bg-hoja text-white" aria-label={`Llamar a ${tracking.courier.name}`}>
                <Phone className="h-5 w-5" aria-hidden />
              </a>
            </div>
          )}

          {/* PIN de entrega */}
          {!done && !cancelled && tracking.status !== 'PENDING_PAYMENT' && (
            <div className="mt-4 flex items-center gap-4 rounded-2xl bg-hoja p-4 text-white">
              <KeyRound className="h-6 w-6 shrink-0 text-maiz" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Código de entrega</p>
                <p className="text-sm text-white/80">{tracking.type === 'PICKUP' ? 'Dilo en el mostrador al recoger' : 'Dáselo al repartidor cuando llegue'}</p>
              </div>
              <span className="font-display text-4xl font-extrabold tracking-[0.15em] text-maiz">{tracking.pin}</span>
            </div>
          )}

          {done && (
            <div className="mt-5 flex items-center gap-3 rounded-2xl bg-hoja-100 p-4 font-semibold text-hoja">
              <Check className="h-5 w-5" aria-hidden /> ¡Buen provecho! {tracking.type === 'PICKUP' ? 'Lo recogiste' : 'Llegó'} a las {clock(tracking.deliveredAt!)}
            </div>
          )}

          {/* Detalle */}
          <section className="mt-8" aria-labelledby="tk-items">
            <h2 id="tk-items" className="text-sm font-semibold text-tinta-soft">
              Tu pedido
            </h2>
            <ul className="mt-3 space-y-1.5">
              {tracking.items.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-7 shrink-0 font-semibold tabular-nums">{item.quantity}×</span>
                  <span className="min-w-0 flex-1">
                    {item.name}
                    {item.notes && <span className="block text-sm text-tinta-soft">“{item.notes}”</span>}
                  </span>
                  <span className="tabular-nums text-tinta-soft">{money(item.unitPrice * item.quantity, currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-4 space-y-1.5 border-t border-hoja/10 pt-3 text-sm">
              {tracking.deliveryFee > 0 && (
                <div className="flex justify-between text-tinta-soft">
                  <dt>Domicilio</dt>
                  <dd className="tabular-nums">{money(tracking.deliveryFee, currency)}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between">
                <dt className="font-semibold">Total</dt>
                <dd className="font-display text-2xl font-bold tabular-nums">{money(tracking.total, currency)}</dd>
              </div>
              <div className="flex justify-between text-tinta-soft">
                <dt>Pago</dt>
                <dd>{tracking.paid ? (tracking.paymentMethod === 'ONLINE' ? 'Pagado en línea' : 'Pagado') : PAYMENT_LABEL[tracking.paymentMethod]}</dd>
              </div>
            </dl>
          </section>

          <section className="mt-6 space-y-2 text-sm text-tinta-soft">
            {tracking.type === 'DELIVERY' ? (
              <p>
                Entrega en <span className="font-semibold text-tinta">{tracking.addressLine}</span>
                {tracking.addressDetails ? `, ${tracking.addressDetails}` : ''}
              </p>
            ) : (
              <p className="flex items-center gap-2">
                <Store className="h-4 w-4" aria-hidden /> Recoges en {tracking.restaurant.address ?? tracking.restaurant.name}
              </p>
            )}
            {tracking.restaurant.phone && (
              <a href={`tel:${tracking.restaurant.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 font-semibold text-hoja underline underline-offset-2">
                <Phone className="h-4 w-4" aria-hidden /> Llamar al restaurante
              </a>
            )}
          </section>

          {tracking.status === 'PLACED' && <CancelButton code={code} onCancelled={setTracking} />}
        </div>
      </div>
    </div>
  );
}

function PendingPayment({ code, payments, total, currency, onCancelled }: { code: string; payments: PaymentOption[]; total: number; currency: string; onCancelled: (t: Tracking) => void }) {
  const toast = useToast();
  const [choice, setChoice] = useState<PaymentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const { checkoutUrl } = await api.post<{ checkoutUrl: string }>(`/public/delivery/track/${code}/pay`, { channel: choice });
      window.location.assign(checkoutUrl);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 rounded-2xl bg-niebla p-4">
      <p className="font-semibold">Falta completar el pago</p>
      <p className="mt-1 text-sm text-tinta-soft">El restaurante empieza tu pedido cuando el pago se aprueba. Si no se completa en 30 minutos, se cancela solo.</p>
      <div className="mt-4">
        <PaymentPicker online={payments} value={choice} onChange={setChoice} />
      </div>
      <button type="button" disabled={!choice || busy} onClick={() => void pay()} className="mt-4 flex h-12 w-full items-center justify-between rounded-full bg-maiz px-5 font-bold text-tinta disabled:opacity-50">
        <span>{busy ? 'Abriendo la pasarela…' : 'Pagar ahora'}</span>
        <span className="tabular-nums">{money(total, currency)}</span>
      </button>
      <CancelButton code={code} onCancelled={onCancelled} />
    </div>
  );
}

function CancelButton({ code, onCancelled }: { code: string; onCancelled: (t: Tracking) => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="mt-6 w-full text-center text-sm font-semibold text-tinta-soft underline underline-offset-2">
        Cancelar pedido
      </button>
    );
  }
  return (
    <div className="mt-6 flex items-center gap-3 rounded-2xl bg-red-50 p-3 text-sm text-red-900">
      <span className="flex-1">¿Seguro que quieres cancelar?</span>
      <button
        type="button"
        onClick={() =>
          api
            .post<Tracking>(`/public/delivery/track/${code}/cancel`)
            .then(onCancelled)
            .catch((err) => toast.show(errorMessage(err), { tone: 'error' }))
        }
        className="rounded-full bg-red-700 px-4 py-2 font-semibold text-white"
      >
        Sí, cancelar
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="font-semibold">
        No
      </button>
    </div>
  );
}
