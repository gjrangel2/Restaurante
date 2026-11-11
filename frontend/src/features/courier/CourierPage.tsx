import { Banknote, CircleCheck, CreditCard, Crosshair, LogOut, Moon, Navigation, Package, Phone, Route, Sun, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, googleMapsDirections, type MapLine, type MapMarker } from '../../components/MapView';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { ago, elapsed, money, useNow } from '../../lib/format';
import { useAuth, useStaff, useTheme } from '../../lib/session';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { Delivery, MapConfig, Vehicle } from '../../lib/types';
import { DELIVERY_STATUS, VEHICLE_LABEL } from '../delivery/deliveryStatus';

interface CourierHome {
  profile: { id: string; name: string; phone: string; vehicle: Vehicle; plate: string | null; isAvailable: boolean; lat: number | null; lng: number | null; lastSeenAt: string | null; deliveredToday: number };
  deliveries: Delivery[];
  restaurant: { name: string; lat: number | null; lng: number | null; address: string | null; phone: string | null; currency: string };
  map: MapConfig;
}

type GpsState = 'off' | 'waiting' | 'on' | 'denied' | 'insecure' | 'simulating';

/**
 * App del repartidor: /repartidor (rol COURIER).
 *
 * Pensada para el celular en la calle: botones grandes, un solo pedido en
 * foco, llamar al cliente, abrir la ruta en Google Maps y entregar con el
 * PIN que dicta el cliente. Mientras está "En turno", el celular comparte
 * su ubicación por WebSocket y el cliente lo ve moverse en su mapa.
 */
export function CourierPage() {
  const { token } = useStaff();
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const toast = useToast();
  const now = useNow(15_000);
  const { socket, connected } = useSocket({ token });
  const [home, setHome] = useState<CourierHome | null>(null);
  const [tab, setTab] = useState<'mine' | 'available'>('mine');
  const [busy, setBusy] = useState<string | null>(null);
  const [deliverFor, setDeliverFor] = useState<Delivery | null>(null);
  const [gps, setGps] = useState<GpsState>('off');
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<CourierHome>('/courier/me', token);
      setHome(data);
      if (data.profile.lat != null) setPosition((p) => p ?? { lat: Number(data.profile.lat), lng: Number(data.profile.lng) });
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(socket, load);
  useSocketEvent(socket, 'delivery:updated', () => void load());
  useSocketEvent<{ code: string }>(socket, 'delivery:assigned', ({ code }) => {
    toast.show(`Te asignaron el pedido ${code}`, { emoji: '🛵' });
    setTab('mine');
  });
  useSocketEvent<{ code: string }>(socket, 'delivery:unassigned', ({ code }) => toast.show(`El pedido ${code} se reasignó`));

  const mine = useMemo(() => home?.deliveries.filter((d) => d.courier?.id === home.profile.id) ?? [], [home]);
  const available = useMemo(() => home?.deliveries.filter((d) => !d.courier) ?? [], [home]);
  // En foco, lo que se puede mover ya: lo que va en camino y luego lo que está listo para recoger.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focus = mine.find((d) => d.id === focusId) ?? mine.find((d) => d.status === 'ON_THE_WAY') ?? mine.find((d) => d.status === 'READY') ?? mine[0] ?? null;

  // --- Ubicación -------------------------------------------------------------
  const lastSent = useRef(0);
  const sendLocation = useCallback(
    (lat: number, lng: number, heading?: number | null) => {
      setPosition({ lat, lng });
      if (!socket || Date.now() - lastSent.current < 4_000) return;
      lastSent.current = Date.now();
      socket.emit('courier:location', { lat, lng, ...(heading != null && !Number.isNaN(heading) ? { heading } : {}) });
    },
    [socket],
  );

  const shouldTrack = Boolean(home?.profile.isAvailable || mine.some((d) => d.status === 'ON_THE_WAY'));
  useEffect(() => {
    if (!shouldTrack || gps === 'simulating') return;
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setGps('insecure');
      return;
    }
    setGps('waiting');
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGps('on');
        sendLocation(p.coords.latitude, p.coords.longitude, p.coords.heading);
      },
      (err) => setGps(err.code === err.PERMISSION_DENIED ? 'denied' : 'waiting'),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [shouldTrack, gps === 'simulating', sendLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Simulación de recorrido (para probar sin GPS, p. ej. en local sin HTTPS)
  const simulate = (delivery: Delivery) => {
    if (!home || delivery.lat == null) return;
    const start = position ?? { lat: Number(home.restaurant.lat), lng: Number(home.restaurant.lng) };
    const end = { lat: Number(delivery.lat), lng: Number(delivery.lng) };
    const heading = (Math.atan2(end.lng - start.lng, end.lat - start.lat) * 180) / Math.PI;
    setGps('simulating');
    let step = 0;
    const steps = 24;
    const timer = setInterval(() => {
      step += 1;
      const t = step / steps;
      lastSent.current = 0; // la simulación envía cada paso
      sendLocation(start.lat + (end.lat - start.lat) * t, start.lng + (end.lng - start.lng) * t, Math.round((heading + 360) % 360));
      if (step >= steps) {
        clearInterval(timer);
        setGps('off');
        toast.show('Llegaste al destino (simulado). Pide el PIN al cliente.');
      }
    }, 2_500);
  };

  // --- Acciones ----------------------------------------------------------------
  const act = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.show(success, { tone: 'success' });
      await load();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (!home) return <main className="min-h-dvh animate-pulse bg-canvas" aria-busy="true" aria-label="Cargando" />;
  const p = home.profile;
  const currency = home.restaurant.currency;

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto max-w-md pb-10">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-lg font-bold leading-tight">{p.name}</p>
              <p className="text-xs text-ink-faint">
                {VEHICLE_LABEL[p.vehicle]}
                {p.plate ? ` · ${p.plate}` : ''} · {p.deliveredToday} {p.deliveredToday === 1 ? 'entrega' : 'entregas'} hoy
              </p>
            </div>
            <span className={`flex items-center gap-1 text-xs font-medium ${connected ? 'text-ink-soft' : 'text-state-calling'}`} role="status">
              {connected ? <Wifi className="h-4 w-4" aria-hidden /> : <WifiOff className="h-4 w-4" aria-hidden />}
              <span className="sr-only">{connected ? 'En línea' : 'Sin conexión'}</span>
            </span>
            <button type="button" onClick={toggle} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}>
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" aria-hidden /> : <Moon className="h-[18px] w-[18px]" aria-hidden />}
            </button>
            <button type="button" onClick={logout} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label="Cerrar sesión">
              <LogOut className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={p.isAvailable}
              disabled={busy === 'availability'}
              onClick={() => void act('availability', () => api.patch('/courier/me', { isAvailable: !p.isAvailable }, token))}
              className={`flex flex-1 items-center justify-between rounded-2xl px-4 py-3 font-semibold transition-colors ${p.isAvailable ? 'bg-state-served text-white' : 'bg-sunken text-ink-soft'}`}
            >
              <span>{p.isAvailable ? 'En turno' : 'Fuera de turno'}</span>
              <span className={`relative h-6 w-11 rounded-full ${p.isAvailable ? 'bg-white/30' : 'bg-line'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${p.isAvailable ? 'left-[22px]' : 'left-0.5'}`} />
              </span>
            </button>
          </div>
          <GpsNotice state={gps} />
        </header>

        {/* Pedido en foco */}
        {focus && (
          <ActiveDelivery
            delivery={focus}
            home={home}
            position={position}
            busy={busy}
            now={now}
            gps={gps}
            onPickUp={() => void act(`pickup-${focus.id}`, () => api.post(`/courier/deliveries/${focus.id}/pickup`, {}, token), '¡En camino! El cliente ya puede verte en el mapa.')}
            onDeliver={() => setDeliverFor(focus)}
            onSimulate={() => simulate(focus)}
          />
        )}

        <div className="mt-4 px-4">
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-sunken p-1" role="tablist">
            {(
              [
                ['mine', `Mis entregas (${mine.length})`],
                ['available', `Disponibles (${available.length})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-xl py-2 text-sm font-semibold ${tab === id ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <ul className="mt-3 space-y-3">
            {(tab === 'mine' ? mine.filter((d) => d.id !== focus?.id) : available).map((d) => (
              <li key={d.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-center gap-2">
                  <span className="font-display text-lg font-bold">{d.code}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${DELIVERY_STATUS[d.status].pill}`}>{DELIVERY_STATUS[d.status].label}</span>
                  <span className="ml-auto text-sm tabular-nums text-ink-soft">{d.distanceKm != null ? `${Number(d.distanceKm).toLocaleString('es-CO')} km` : ''}</span>
                </div>
                <p className="mt-1 text-sm">{d.addressLine}</p>
                <p className="text-sm text-ink-faint">
                  {d.paid ? 'Pagado' : `Cobrar ${money(d.total, currency)} ${d.paymentMethod === 'CASH' ? 'en efectivo' : 'con datáfono'}`} · domicilio {money(d.deliveryFee, currency)}
                </p>
                {tab === 'mine' && (
                  <button
                    type="button"
                    onClick={() => {
                      setFocusId(d.id);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="mt-3 h-11 w-full rounded-xl border border-line font-semibold"
                  >
                    Atender esta entrega
                  </button>
                )}
                {tab === 'available' && (
                  <button
                    type="button"
                    disabled={!p.isAvailable || busy === `take-${d.id}`}
                    onClick={() => void act(`take-${d.id}`, () => api.post(`/courier/deliveries/${d.id}/take`, {}, token), `Tomaste ${d.code}`)}
                    className="mt-3 h-11 w-full rounded-xl bg-ink font-semibold text-surface disabled:opacity-40"
                  >
                    {p.isAvailable ? 'Tomar pedido' : 'Activa "En turno" para tomarlo'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(tab === 'mine' ? mine.length <= 1 : available.length === 0) && (
            <p className="mt-3 rounded-2xl border border-dashed border-line p-6 text-center text-sm text-ink-soft">
              {tab === 'available'
                ? 'No hay pedidos esperando repartidor.'
                : mine.length === 0
                  ? 'No tienes entregas asignadas. Mira los pedidos disponibles.'
                  : 'No tienes más entregas asignadas: la de arriba es la única.'}
            </p>
          )}
        </div>
      </div>

      {deliverFor && (
        <DeliverSheet
          delivery={deliverFor}
          currency={currency}
          onClose={() => setDeliverFor(null)}
          onConfirm={async (pin, amountReceived) => {
            await api.post(`/courier/deliveries/${deliverFor.id}/deliver`, { pin, amountReceived }, token);
            setDeliverFor(null);
            toast.show(`Entregado ${deliverFor.code}. ¡Buen trabajo!`, { tone: 'success' });
            await load();
          }}
        />
      )}
    </div>
  );
}

function GpsNotice({ state }: { state: GpsState }) {
  const text: Record<GpsState, string | null> = {
    off: null,
    on: null,
    waiting: 'Buscando señal GPS…',
    simulating: 'Simulando el recorrido (modo de prueba)',
    denied: 'Sin permiso de ubicación: actívalo en el navegador para que el cliente te vea.',
    insecure: 'El GPS del navegador solo funciona con HTTPS. En local puedes simular el recorrido.',
  };
  if (!text[state]) return null;
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-ink-soft" role="status">
      <Crosshair className={`h-3.5 w-3.5 ${state === 'waiting' || state === 'simulating' ? 'animate-blink' : ''}`} aria-hidden /> {text[state]}
    </p>
  );
}

function ActiveDelivery({
  delivery: d,
  home,
  position,
  busy,
  now,
  gps,
  onPickUp,
  onDeliver,
  onSimulate,
}: {
  delivery: Delivery;
  home: CourierHome;
  position: { lat: number; lng: number } | null;
  busy: string | null;
  now: number;
  gps: GpsState;
  onPickUp: () => void;
  onDeliver: () => void;
  onSimulate: () => void;
}) {
  const r = home.restaurant;
  const markers: MapMarker[] = [];
  const lines: MapLine[] = [];
  if (r.lat != null) markers.push({ id: 'r', lat: Number(r.lat), lng: Number(r.lng), kind: 'restaurant', title: r.name });
  if (d.lat != null) markers.push({ id: 'd', lat: Number(d.lat), lng: Number(d.lng), kind: 'destination', color: '#E5484D', label: d.code.replace('D-', ''), title: d.addressLine ?? '' });
  if (position) markers.push({ id: 'me', lat: position.lat, lng: position.lng, kind: 'courier', vehicle: home.profile.vehicle, color: '#16A34A', title: 'Tú' });
  if (position && d.lat != null && d.status === 'ON_THE_WAY') lines.push({ id: 'go', points: [[position.lat, position.lng], [Number(d.lat), Number(d.lng)]], color: '#16A34A', dashed: true });
  else if (r.lat != null && d.lat != null) lines.push({ id: 'route', points: [[Number(r.lat), Number(r.lng)], [Number(d.lat), Number(d.lng)]], color: '#0C3B2E', dashed: true, weight: 3 });

  const status = DELIVERY_STATUS[d.status];
  const toCollect = !d.paid;

  return (
    <section className="mt-3 overflow-hidden border-y border-line bg-surface sm:mx-4 sm:rounded-3xl sm:border" aria-label={`Pedido ${d.code}`}>
      <MapView config={home.map} markers={markers} lines={lines} fitKey={`${d.id}:${d.status}`} className="h-56 w-full" ariaLabel="Mapa de la entrega" />
      <div className="p-4">
        <div className="flex items-center gap-2">
          <span className="font-display text-2xl font-bold">{d.code}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.pill}`}>{status.label}</span>
          {d.acceptedAt && <span className="ml-auto text-xs text-ink-faint">{ago(d.acceptedAt, now)}</span>}
        </div>

        <p className="mt-3 text-lg font-semibold leading-snug">{d.addressLine}</p>
        {(d.addressDetails || d.addressNotes) && <p className="text-sm text-ink-soft">{[d.addressDetails, d.addressNotes].filter(Boolean).join(' · ')}</p>}

        <div className="mt-3 flex items-center gap-3 rounded-2xl bg-sunken p-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{d.customerName}</p>
            <p className="text-sm text-ink-soft">{d.items.reduce((n, i) => n + i.quantity, 0)} productos</p>
          </div>
          <a href={`tel:${d.customerPhone.replace(/\s/g, '')}`} className="grid h-11 w-11 place-items-center rounded-full bg-ink text-surface" aria-label={`Llamar a ${d.customerName}`}>
            <Phone className="h-5 w-5" aria-hidden />
          </a>
        </div>

        <p className={`mt-3 flex items-center gap-2 rounded-2xl p-3 font-semibold ${toCollect ? 'bg-[#fab219]/20' : 'bg-state-served/15'}`}>
          {toCollect ? (
            d.paymentMethod === 'CASH' ? <Banknote className="h-5 w-5" aria-hidden /> : <CreditCard className="h-5 w-5" aria-hidden />
          ) : (
            <CircleCheck className="h-5 w-5 text-state-served" aria-hidden />
          )}
          {toCollect ? `Cobrar ${money(d.total, home.restaurant.currency)} ${d.paymentMethod === 'CASH' ? 'en efectivo' : 'con datáfono'}` : 'Ya pagado: no cobres nada'}
        </p>

        <div className="mt-4 grid gap-2">
          {(d.status === 'ACCEPTED' || d.status === 'PREPARING') && (
            <p className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-line p-3 text-sm text-ink-soft">
              <Package className="h-4 w-4" aria-hidden /> Cocina lo está preparando. Te avisamos cuando esté listo.
            </p>
          )}
          {d.status === 'READY' && (
            <button type="button" disabled={busy === `pickup-${d.id}`} onClick={onPickUp} className="h-14 rounded-2xl bg-ink text-lg font-bold text-surface disabled:opacity-50">
              Recogí el pedido
            </button>
          )}
          {d.status === 'ON_THE_WAY' && (
            <>
              {d.lat != null && (
                <a href={googleMapsDirections(Number(d.lat), Number(d.lng))} target="_blank" rel="noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-line font-semibold">
                  <Navigation className="h-5 w-5" aria-hidden /> Abrir ruta en Google Maps
                </a>
              )}
              {(gps === 'insecure' || gps === 'denied' || gps === 'off') && (
                <button type="button" onClick={onSimulate} className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-sm font-semibold text-ink-soft">
                  <Route className="h-4 w-4" aria-hidden /> Simular recorrido (prueba)
                </button>
              )}
              <button type="button" onClick={onDeliver} className="h-14 rounded-2xl bg-state-served text-lg font-bold text-white">
                Entregar
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function DeliverSheet({ delivery, currency, onClose, onConfirm }: { delivery: Delivery; currency: string; onClose: () => void; onConfirm: (pin: string, amountReceived?: number) => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [received, setReceived] = useState(String(delivery.total));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cash = !delivery.paid && delivery.paymentMethod === 'CASH';
  const amount = Number(received.replace(/\D/g, '')) || 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pin, cash ? amount : undefined);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Entregar pedido">
      <div className="absolute inset-0 bg-black/50" onClick={() => !busy && onClose()} aria-hidden />
      <form
        className="pb-safe relative w-full max-w-md animate-sheet-up rounded-t-3xl bg-surface p-5 text-ink"
        onSubmit={(e) => {
          e.preventDefault();
          if (pin.length === 4) void submit();
        }}
      >
        <h2 className="font-display text-2xl font-bold">Entregar {delivery.code}</h2>
        <p className="mt-1 text-sm text-ink-soft">Pide al cliente su código de entrega de 4 dígitos.</p>
        <label className="mt-4 block">
          <span className="sr-only">Código de entrega</span>
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="w-full rounded-2xl border-2 border-line bg-sunken py-4 text-center font-display text-5xl font-extrabold tracking-[0.4em] outline-none focus:border-ink"
            aria-label="Código de entrega"
          />
        </label>
        {cash && (
          <label className="mt-4 block text-sm">
            <span className="font-semibold">Efectivo recibido</span>
            <input inputMode="numeric" value={received} onChange={(e) => setReceived(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 tabular-nums outline-none focus:border-ink" />
            <span className="mt-1 block text-ink-soft">
              Total {money(delivery.total, currency)}
              {amount > delivery.total ? ` · Cambio ${money(amount - delivery.total, currency)}` : ''}
            </span>
          </label>
        )}
        {error && (
          <p className="mt-3 rounded-xl bg-state-calling/10 p-3 text-sm font-medium text-state-calling" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pin.length !== 4 || busy || (cash && amount < delivery.total)} className="mt-5 h-14 w-full rounded-2xl bg-state-served text-lg font-bold text-white disabled:opacity-40">
          {busy ? 'Confirmando…' : 'Confirmar entrega'}
        </button>
        <button type="button" onClick={onClose} className="mt-2 h-11 w-full font-semibold text-ink-soft">
          Cancelar
        </button>
      </form>
    </div>
  );
}
