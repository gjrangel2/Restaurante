import { Bike, CircleAlert, ExternalLink, Phone, Plus, Store, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView, googleMapsDirections, type MapLine, type MapMarker, type MapRing } from '../../components/MapView';
import { Button, Card, StaffShell } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { clock, elapsed, money, useNow } from '../../lib/format';
import { useStaff } from '../../lib/session';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { Courier, Delivery, DeliverySettings, MapConfig } from '../../lib/types';
import { Field, inputClass, Switch } from '../admin/ui';
import { DELIVERY_STATUS, isStale, PAYMENT_LABEL, VEHICLE_LABEL } from './deliveryStatus';

interface Board {
  restaurant: {
    name: string;
    lat: number | null;
    lng: number | null;
    address: string | null;
    currency: string;
  };
  deliveries: Delivery[];
  couriers: Courier[];
  map: MapConfig;
}

const COLUMNS: Array<{
  title: string;
  statuses: Delivery['status'][];
  empty: string;
}> = [
  { title: 'Nuevos', statuses: ['PLACED'], empty: 'Sin pedidos por aceptar.' },
  {
    title: 'En cocina',
    statuses: ['ACCEPTED', 'PREPARING'],
    empty: 'Nada en cocina.',
  },
  { title: 'Listos', statuses: ['READY'], empty: 'Nada esperando salida.' },
  {
    title: 'En camino',
    statuses: ['ON_THE_WAY'],
    empty: 'Ningún repartidor en ruta.',
  },
];

/**
 * Despacho de domicilios: /despacho (Admin y Camarero).
 *
 * A la izquierda, los pedidos por etapa; a la derecha, el mapa en vivo con
 * el restaurante, los destinos y los repartidores moviéndose. Al tocar un
 * pedido se abre su panel: aceptar, asignar repartidor, entregar en
 * mostrador (para recoger) o cancelar.
 */
export function DispatchPage() {
  const { token, user } = useStaff();
  const toast = useToast();
  const now = useNow(15_000);
  const { socket, connected } = useSocket({ token });
  const [board, setBoard] = useState<Board | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'board' | 'settings'>('board');

  const load = useCallback(async () => {
    try {
      setBoard(await api.get<Board>('/delivery/board', token));
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(socket, load);

  useSocketEvent<Delivery>(socket, 'delivery:updated', (delivery) => {
    setBoard((b) => {
      if (!b) return b;
      const exists = b.deliveries.some((d) => d.id === delivery.id);
      return {
        ...b,
        deliveries: exists ? b.deliveries.map((d) => (d.id === delivery.id ? delivery : d)) : [delivery, ...b.deliveries],
      };
    });
  });
  useSocketEvent<{ code: string; type: string }>(socket, 'delivery:new', ({ code, type }) => {
    toast.show(`${type === 'PICKUP' ? 'Pedido para recoger' : 'Domicilio'} nuevo: ${code}`, { emoji: '🛵' });
  });
  useSocketEvent<Courier[]>(socket, 'couriers:updated', (couriers) => setBoard((b) => (b ? { ...b, couriers } : b)));
  useSocketEvent<{
    courierId: string;
    lat: number;
    lng: number;
    heading: number | null;
    at: string;
  }>(socket, 'courier:location', (loc) => {
    setBoard((b) =>
      b
        ? {
            ...b,
            couriers: b.couriers.map((c) =>
              c.id === loc.courierId
                ? {
                    ...c,
                    lat: loc.lat,
                    lng: loc.lng,
                    lastSeenAt: loc.at,
                    heading: loc.heading,
                  }
                : c,
            ),
            deliveries: b.deliveries.map((d) =>
              d.courier?.id === loc.courierId
                ? {
                    ...d,
                    courier: {
                      ...d.courier,
                      lat: loc.lat,
                      lng: loc.lng,
                      lastSeenAt: loc.at,
                    },
                  }
                : d,
            ),
          }
        : b,
    );
  });

  const selected = board?.deliveries.find((d) => d.id === selectedId) ?? null;
  const active = useMemo(() => board?.deliveries.filter((d) => ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'ON_THE_WAY'].includes(d.status)) ?? [], [board]);
  const finished = useMemo(() => board?.deliveries.filter((d) => d.status === 'DELIVERED' || d.status === 'CANCELLED') ?? [], [board]);
  const waitingPayment = board?.deliveries.filter((d) => d.status === 'PENDING_PAYMENT').length ?? 0;

  // Mapa
  const { markers, lines } = useMemo(() => {
    const markers: MapMarker[] = [];
    const lines: MapLine[] = [];
    if (!board) return { markers, lines };
    const r = board.restaurant;
    if (r.lat != null)
      markers.push({
        id: 'r',
        lat: Number(r.lat),
        lng: Number(r.lng),
        kind: 'restaurant',
        title: r.name,
      });
    for (const d of active) {
      if (d.type !== 'DELIVERY' || d.lat == null) continue;
      markers.push({
        id: d.id,
        lat: Number(d.lat),
        lng: Number(d.lng),
        kind: 'destination',
        color: DELIVERY_STATUS[d.status].color,
        label: d.code.replace('D-', ''),
        title: `${d.code} · ${DELIVERY_STATUS[d.status].label} · ${d.customerName}`,
        active: d.id === selectedId,
        onClick: () => setSelectedId(d.id),
      });
      if (d.status === 'ON_THE_WAY' && d.courier?.lat != null) {
        lines.push({
          id: `l-${d.id}`,
          points: [
            [Number(d.courier.lat), Number(d.courier.lng)],
            [Number(d.lat), Number(d.lng)],
          ],
          color: DELIVERY_STATUS.ON_THE_WAY.color,
          dashed: true,
          weight: 3,
        });
      }
    }
    for (const c of board.couriers) {
      if (c.lat == null || (!c.isAvailable && c.active === 0)) continue;
      markers.push({
        id: `c-${c.id}`,
        lat: Number(c.lat),
        lng: Number(c.lng),
        kind: 'courier',
        vehicle: c.vehicle,
        color: c.active > 0 ? '#16A34A' : '#475569',
        label: c.name.split(' ')[0],
        heading: (c as Courier & { heading?: number | null }).heading ?? null,
        stale: isStale(c.lastSeenAt, now),
        title: `${c.name} · ${c.active > 0 ? `${c.active} en curso` : 'disponible'}${isStale(c.lastSeenAt, now) ? ' · ubicación vieja' : ''}`,
      });
    }
    return { markers, lines };
  }, [board, active, selectedId, now]);

  return (
    <StaffShell live={connected}>
      <div className={selected ? 'lg:pr-[440px]' : ''}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight">Domicilios</h1>
          {user.role === 'ADMIN' && (
            <div className="flex gap-1 rounded-full border border-line bg-surface p-1" role="tablist">
              {(
                [
                  ['board', 'Despacho'],
                  ['settings', 'Zonas y ajustes'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${tab === id ? 'bg-ink text-surface' : 'text-ink-soft hover:bg-sunken'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'settings' ? (
          <SettingsPanel token={token} map={board?.map} onSaved={load} />
        ) : !board ? (
          <div className="h-[560px] animate-pulse rounded-3xl bg-surface" />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="space-y-5">
              {COLUMNS.map((column) => {
                const list = active.filter((d) => column.statuses.includes(d.status));
                return (
                  <section key={column.title} aria-label={column.title}>
                    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft">
                      {column.title}
                      <span className="rounded-full bg-surface px-2 py-0.5 text-xs tabular-nums text-ink-faint">{list.length}</span>
                    </h2>
                    {list.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-faint">{column.empty}</p>
                    ) : (
                      <ul className="space-y-2">
                        {list.map((d) => (
                          <DeliveryCard key={d.id} delivery={d} now={now} currency={board.restaurant.currency} selected={d.id === selectedId} onSelect={() => setSelectedId(d.id)} />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
              {waitingPayment > 0 && (
                <p className="text-sm text-ink-faint">
                  {waitingPayment} {waitingPayment === 1 ? 'pedido espera' : 'pedidos esperan'} que el cliente complete el pago en línea.
                </p>
              )}
              {finished.length > 0 && (
                <details className="rounded-2xl border border-line bg-surface p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-ink-soft">Terminados hoy ({finished.length})</summary>
                  <ul className="mt-3 space-y-2">
                    {finished.map((d) => (
                      <DeliveryCard key={d.id} delivery={d} now={now} currency={board.restaurant.currency} selected={d.id === selectedId} onSelect={() => setSelectedId(d.id)} />
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
              <Card className="overflow-hidden">
                <MapView config={board.map} markers={markers} lines={lines} fitKey={`${active.length}`} className="h-[440px] w-full xl:h-[520px]" ariaLabel="Mapa de domicilios y repartidores" />
              </Card>
              <CouriersStrip couriers={board.couriers} now={now} />
            </div>
          </div>
        )}
      </div>

      {selected && board && tab === 'board' && (
        <DeliveryDrawer key={selected.id} delivery={selected} couriers={board.couriers} currency={board.restaurant.currency} token={token} now={now} onClose={() => setSelectedId(null)} />
      )}
    </StaffShell>
  );
}

function gpsAge(iso: string, now: number) {
  const age = elapsed(iso, now);
  return age === 'ahora' ? 'GPS en vivo' : `GPS hace ${age}`;
}

function DeliveryCard({ delivery: d, now, currency, selected, onSelect }: { delivery: Delivery; now: number; currency: string; selected: boolean; onSelect: () => void }) {
  const status = DELIVERY_STATUS[d.status];
  const since = d.placedAt ?? d.createdAt;
  const late = d.estimatedAt && !['DELIVERED', 'CANCELLED'].includes(d.status) && new Date(d.estimatedAt).getTime() < now;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full rounded-2xl border bg-surface p-3.5 text-left transition-colors hover:border-ink-faint ${selected ? 'border-ink ring-1 ring-ink' : 'border-line'}`}
      >
        <div className="flex items-center gap-2">
          {d.type === 'PICKUP' ? <Store className="h-4 w-4 text-ink-soft" aria-label="Para recoger" /> : <Bike className="h-4 w-4 text-ink-soft" aria-label="Domicilio" />}
          <span className="font-display text-lg font-bold">{d.code}</span>
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: status.color }} aria-hidden />
          <span className="text-sm text-ink-soft">{status.label}</span>
          <span className={`ml-auto text-xs tabular-nums ${late ? 'font-semibold text-state-calling' : 'text-ink-faint'}`}>
            {late && <CircleAlert className="mr-1 inline h-3.5 w-3.5" aria-label="Atrasado" />}
            {elapsed(since, now)}
          </span>
        </div>
        <p className="mt-1 truncate text-sm">
          {d.customerName}
          {d.type === 'DELIVERY' && d.addressLine ? <span className="text-ink-faint"> · {d.addressLine}</span> : null}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-faint">
          <span className="tabular-nums">{money(d.total, currency)}</span>
          <span>{d.paid ? 'Pagado' : PAYMENT_LABEL[d.paymentMethod]}</span>
          {d.type === 'DELIVERY' && <span>{d.courier ? d.courier.name : 'Sin repartidor'}</span>}
          {d.refundPending && <span className="font-semibold text-state-calling">Reembolso pendiente</span>}
        </p>
      </button>
    </li>
  );
}

function CouriersStrip({ couriers, now }: { couriers: Courier[]; now: number }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-soft">Repartidores</h2>
      {couriers.length === 0 ? (
        <p className="text-sm text-ink-faint">Aún no hay usuarios con rol Repartidor.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {couriers.map((c) => (
            <li key={c.id} className="flex items-center gap-3 rounded-xl bg-sunken p-3 text-sm">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.isAvailable ? 'bg-state-served' : 'bg-state-free'}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{c.name}</p>
                <p className="text-xs text-ink-faint">
                  {VEHICLE_LABEL[c.vehicle]} · {c.isAvailable ? 'En turno' : 'Fuera de turno'} · {c.active} en curso · {c.deliveredToday} hoy
                  {c.isAvailable && isStale(c.lastSeenAt, now) ? ' · sin GPS reciente' : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeliveryDrawer({ delivery: d, couriers, currency, token, now, onClose }: { delivery: Delivery; couriers: Courier[]; currency: string; token: string; now: number; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const status = DELIVERY_STATUS[d.status];
  const canCancel = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'].includes(d.status);
  const canAssign = d.type === 'DELIVERY' && ['PLACED', 'ACCEPTED', 'PREPARING', 'READY'].includes(d.status);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.show(success, { tone: 'success' });
      return true;
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const cancelForm = reason !== null && (
    <form
      className="rounded-2xl border border-state-calling/40 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run('cancel', () => api.post(`/delivery/${d.id}/cancel`, { reason }, token), d.status === 'PLACED' ? 'Pedido rechazado' : 'Pedido cancelado');
        if (ok) setReason(null);
      }}
    >
      <Field label="Motivo (lo verá el cliente)">
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={160} required className={inputClass} />
      </Field>
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="danger" disabled={busy === 'cancel' || reason.trim().length < 3}>
          {d.status === 'PLACED' ? 'Rechazar' : 'Cancelar pedido'}
        </Button>
        <Button variant="ghost" onClick={() => setReason(null)}>
          Volver
        </Button>
      </div>
    </form>
  );

  const timeline: Array<[string, string | null]> = [
    ['Recibido', d.placedAt],
    ['Aceptado', d.acceptedAt],
    ['Listo', d.readyAt],
    [d.type === 'PICKUP' ? 'Recogido' : 'Salió', d.pickedUpAt],
    ['Entregado', d.deliveredAt],
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 animate-fade-in bg-black/40 lg:hidden" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Pedido ${d.code}`}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] animate-sheet-up flex-col rounded-t-3xl border border-line bg-surface shadow-lift lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-[72px] lg:max-h-none lg:w-[420px] lg:animate-slide-in lg:rounded-3xl"
      >
        <header className="flex items-start gap-3 border-b border-line p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-2xl font-bold">{d.code}</h2>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.pill}`}>{status.label}</span>
            </div>
            <p className="mt-0.5 text-sm text-ink-soft">
              {d.type === 'PICKUP' ? 'Para recoger' : `Domicilio${d.distanceKm != null ? ` · ${Number(d.distanceKm).toLocaleString('es-CO')} km${d.zoneName ? ` (${d.zoneName})` : ''}` : ''}`}
              {d.estimatedAt && !['DELIVERED', 'CANCELLED'].includes(d.status) ? ` · estimado ${clock(d.estimatedAt)}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-ink-soft hover:bg-sunken" aria-label="Cerrar panel">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {d.status === 'PLACED' && reason !== null && cancelForm}
          {d.status === 'PLACED' && reason === null && (
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy === 'accept'} onClick={() => void run('accept', () => api.post(`/delivery/${d.id}/accept`, {}, token), `${d.code} aceptado: va a cocina`)}>
                Aceptar y enviar a cocina
              </Button>
              <Button variant="secondary" onClick={() => setReason('No podemos atender este pedido')}>
                Rechazar
              </Button>
            </div>
          )}

          {d.refundPending && (
            <p className="flex items-start gap-2 rounded-2xl bg-state-calling/10 p-3 text-sm font-medium text-state-calling">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Se pagó en línea y se canceló: reembolsa desde el panel de la pasarela.
            </p>
          )}
          {d.cancelReason && <p className="rounded-2xl bg-sunken p-3 text-sm">Motivo: {d.cancelReason}</p>}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink-soft">Cliente</h3>
            <div className="flex items-center gap-3 rounded-2xl bg-sunken p-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{d.customerName}</p>
                <p className="text-sm text-ink-soft">{d.customerPhone}</p>
              </div>
              <a href={`tel:${d.customerPhone.replace(/\s/g, '')}`} className="grid h-10 w-10 place-items-center rounded-full bg-ink text-surface" aria-label="Llamar al cliente">
                <Phone className="h-4 w-4" aria-hidden />
              </a>
            </div>
            {d.type === 'DELIVERY' && (
              <div className="mt-2 text-sm">
                <p className="font-medium">{d.addressLine}</p>
                {(d.addressDetails || d.addressNotes) && <p className="text-ink-soft">{[d.addressDetails, d.addressNotes].filter(Boolean).join(' · ')}</p>}
                {d.lat != null && (
                  <a
                    href={googleMapsDirections(Number(d.lat), Number(d.lng))}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                  >
                    Ver en Google Maps <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                )}
              </div>
            )}
          </section>

          {canAssign && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink-soft">Repartidor</h3>
              <select
                value={d.courier?.id ?? ''}
                disabled={busy === 'assign'}
                onChange={(e) =>
                  void run('assign', () => api.post(`/delivery/${d.id}/assign`, { courierId: e.target.value || null }, token), e.target.value ? 'Repartidor asignado' : 'Repartidor quitado')
                }
                className={inputClass}
                aria-label="Asignar repartidor"
              >
                <option value="">Sin asignar (lo toma el primero disponible)</option>
                {couriers.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.isAvailable && c.id !== d.courier?.id}>
                    {c.name} · {VEHICLE_LABEL[c.vehicle]} · {c.isAvailable ? `${c.active} en curso` : 'fuera de turno'}
                  </option>
                ))}
              </select>
            </section>
          )}
          {!canAssign && d.courier && (
            <p className="flex items-center gap-2 text-sm">
              <Bike className="h-4 w-4" aria-hidden /> {d.courier.name} · {VEHICLE_LABEL[d.courier.vehicle]}
              {d.courier.lastSeenAt && d.status === 'ON_THE_WAY' ? <span className="text-ink-faint">· {gpsAge(d.courier.lastSeenAt, now)}</span> : null}
            </p>
          )}

          {d.type === 'PICKUP' && d.status === 'READY' && (
            <form
              className="rounded-2xl bg-sunken p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run('handover', () => api.post(`/delivery/${d.id}/handover`, { pin }, token), 'Entregado al cliente');
              }}
            >
              <label className="block text-sm font-semibold">
                Código del cliente
                <input
                  inputMode="numeric"
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className={`${inputClass} mt-1 text-center font-display text-2xl tracking-[0.3em]`}
                />
              </label>
              <Button type="submit" className="mt-3 w-full" disabled={pin.length !== 4 || busy === 'handover'}>
                Entregar en mostrador {!d.paid && `· cobrar ${money(d.total, currency)}`}
              </Button>
            </form>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink-soft">Pedido #{d.orderNumber}</h3>
            <ul className="space-y-1.5 text-sm">
              {d.items.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-6 shrink-0 font-semibold tabular-nums">{item.quantity}×</span>
                  <span className="min-w-0 flex-1">
                    {item.name}
                    {item.notes && <span className="block text-ink-soft">“{item.notes}”</span>}
                  </span>
                  <span className="tabular-nums text-ink-soft">{money(item.unitPrice * item.quantity, currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <div className="flex justify-between text-ink-soft">
                <dt>Domicilio</dt>
                <dd className="tabular-nums">{money(d.deliveryFee, currency)}</dd>
              </div>
              <div className="flex justify-between font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{money(d.total, currency)}</dd>
              </div>
              <div className="flex justify-between text-ink-soft">
                <dt>Pago</dt>
                <dd>{d.paid ? 'Pagado' : PAYMENT_LABEL[d.paymentMethod]}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink-soft">Historial</h3>
            <ol className="space-y-1 text-sm">
              {timeline.map(([label, at]) => (
                <li key={label} className={`flex justify-between ${at ? '' : 'text-ink-faint'}`}>
                  <span>{label}</span>
                  <span className="tabular-nums">{at ? clock(at) : '—'}</span>
                </li>
              ))}
            </ol>
          </section>

          {canCancel && reason === null && d.status !== 'PLACED' && (
            <button type="button" onClick={() => setReason('')} className="text-sm font-semibold text-state-calling underline-offset-2 hover:underline">
              Cancelar pedido
            </button>
          )}
          {reason !== null && d.status !== 'PLACED' && cancelForm}
        </div>
      </aside>
    </>
  );
}

// ----------------------------------------------------------------------------
// Ajustes: ubicación, horario de recepción y zonas (solo Admin)
// ----------------------------------------------------------------------------
function SettingsPanel({ token, map, onSaved }: { token: string; map?: MapConfig; onSaved: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<DeliverySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<DeliverySettings>('/delivery/settings', token)
      .then(setSettings)
      .catch((err) => toast.show(errorMessage(err), { tone: 'error' }));
  }, [token, toast]);

  if (!settings || !map) return <div className="h-96 animate-pulse rounded-3xl bg-surface" />;
  const set = <K extends keyof DeliverySettings>(key: K, value: DeliverySettings[K]) => setSettings((s) => (s ? { ...s, [key]: value } : s));
  const origin = settings.lat != null && settings.lng != null ? { lat: settings.lat, lng: settings.lng } : null;
  const rings: MapRing[] = origin
    ? settings.zones.map((z) => ({
        id: `${z.maxKm}`,
        lat: origin.lat,
        lng: origin.lng,
        radiusKm: z.maxKm,
        color: '#2563EB',
        label: `${z.name}: ${z.maxKm} km`,
      }))
    : [];

  const save = async () => {
    setSaving(true);
    try {
      setSettings(await api.put<DeliverySettings>('/delivery/settings', settings, token));
      toast.show('Ajustes guardados', { tone: 'success' });
      onSaved();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Card className="space-y-5 p-5">
        <div className="flex flex-wrap gap-6 text-sm">
          <span className="flex items-center gap-2">
            <Switch checked={settings.deliveryEnabled} onChange={(v) => set('deliveryEnabled', v)} label="Recibir domicilios" /> Recibir domicilios
          </span>
          <span className="flex items-center gap-2">
            <Switch checked={settings.pickupEnabled} onChange={(v) => set('pickupEnabled', v)} label="Recibir pedidos para recoger" /> Pedidos para recoger
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pedido mínimo (domicilio)">
            <input type="number" min={0} value={settings.minOrder} onChange={(e) => set('minOrder', Number(e.target.value))} className={inputClass} />
          </Field>
          <Field label="Minutos de preparación">
            <input type="number" min={0} max={240} value={settings.prepMinutes} onChange={(e) => set('prepMinutes', Number(e.target.value))} className={inputClass} />
          </Field>
        </div>
        <Field label="Dirección del restaurante">
          <input value={settings.address ?? ''} onChange={(e) => set('address', e.target.value || null)} className={inputClass} />
        </Field>
        <Field label="Teléfono para clientes">
          <input value={settings.phone ?? ''} onChange={(e) => set('phone', e.target.value || null)} className={inputClass} />
        </Field>

        <div>
          <h3 className="mb-1 text-sm font-semibold">Zonas de entrega</h3>
          <p className="mb-3 text-sm text-ink-faint">Anillos de distancia desde el restaurante. Más allá del último no se entrega.</p>
          <div className="space-y-2">
            {settings.zones.map((zone, i) => (
              <div key={i} className="grid grid-cols-[1fr_80px_100px_80px_auto] items-end gap-2">
                {(
                  [
                    ['name', 'Nombre', 'text'],
                    ['maxKm', 'Hasta km', 'number'],
                    ['fee', 'Tarifa', 'number'],
                    ['travelMinutes', 'Min.', 'number'],
                  ] as const
                ).map(([key, label, type]) => (
                  <label key={key} className="block text-xs text-ink-faint">
                    {i === 0 && <span className="mb-1 block">{label}</span>}
                    <input
                      type={type}
                      step="any"
                      value={zone[key]}
                      aria-label={`${label} de la zona ${i + 1}`}
                      onChange={(e) =>
                        set(
                          'zones',
                          settings.zones.map((z, j) =>
                            j === i
                              ? {
                                  ...z,
                                  [key]: type === 'number' ? Number(e.target.value) : e.target.value,
                                }
                              : z,
                          ),
                        )
                      }
                      className={`${inputClass} py-2 text-sm`}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    set(
                      'zones',
                      settings.zones.filter((_, j) => j !== i),
                    )
                  }
                  className="grid h-10 w-10 place-items-center rounded-full text-ink-soft hover:bg-sunken"
                  aria-label={`Quitar zona ${zone.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => {
              const last = settings.zones[settings.zones.length - 1];
              set('zones', [
                ...settings.zones,
                {
                  name: 'Nueva zona',
                  maxKm: (last?.maxKm ?? 0) + 2,
                  fee: (last?.fee ?? 4000) + 2000,
                  travelMinutes: (last?.travelMinutes ?? 10) + 8,
                },
              ]);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden /> Agregar zona
          </Button>
        </div>

        <Button className="w-full" disabled={saving} onClick={() => void save()}>
          {saving ? 'Guardando…' : 'Guardar ajustes'}
        </Button>
      </Card>

      <Card className="overflow-hidden">
        <p className="border-b border-line p-4 text-sm text-ink-soft">Toca el mapa para fijar la ubicación del restaurante. Los anillos muestran la cobertura.</p>
        <MapView
          config={map}
          className="h-[520px] w-full"
          ariaLabel="Ubicación del restaurante y zonas de entrega"
          markers={
            origin
              ? [
                  {
                    id: 'r',
                    lat: origin.lat,
                    lng: origin.lng,
                    kind: 'restaurant',
                    title: 'Restaurante',
                  },
                ]
              : []
          }
          rings={rings}
          fitRings
          fitKey={origin ? `${settings.zones.map((z) => z.maxKm).join('|')}` : 'unset'}
          onMapClick={(lat, lng) =>
            setSettings((s) =>
              s
                ? {
                    ...s,
                    lat: Math.round(lat * 1e6) / 1e6,
                    lng: Math.round(lng * 1e6) / 1e6,
                  }
                : s,
            )
          }
        />
      </Card>
    </div>
  );
}
