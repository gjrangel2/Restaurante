import { Check, CircleAlert, Flame, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, StaffShell } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { minutesSince, quantity, useNow } from '../../lib/format';
import { useStaff } from '../../lib/session';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { InventoryItem, ItemStatus, Order, OrderItem, Product } from '../../lib/types';

const COLUMNS: Array<{ status: Order['status']; title: string; empty: string }> = [
  { status: 'CONFIRMED', title: 'Por preparar', empty: 'Sin comandas en cola.' },
  { status: 'PREPARING', title: 'En preparación', empty: 'Nada en el fuego.' },
  { status: 'READY', title: 'Listas para sala', empty: 'Nada esperando a sala.' },
];

const NEXT_STATUS: Partial<Record<ItemStatus, 'PENDING' | 'PREPARING' | 'READY'>> = { PENDING: 'PREPARING', PREPARING: 'READY', READY: 'PENDING' };

/**
 * Pantalla de cocina: comandas en tiempo real (solo las que sala ya confirmó),
 * cambio de estado plato a plato, alertas de insumos y "agotar" platos de la
 * carta al instante.
 */
export function KitchenPage() {
  const { token } = useStaff();
  const toast = useToast();
  const now = useNow(15_000);
  const { socket, connected } = useSocket({ token });
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [alerts, setAlerts] = useState<InventoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const load = useCallback(async () => {
    try {
      const [kitchenOrders, inventory, menu] = await Promise.all([
        api.get<Order[]>('/kitchen/orders', token),
        api.get<InventoryItem[]>('/kitchen/inventory', token),
        api.get<Product[]>('/kitchen/products', token),
      ]);
      setOrders(kitchenOrders);
      setAlerts(inventory.filter((item) => item.alertLevel !== 'OK'));
      setProducts(menu);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(socket, load);

  // Una comanda entra a cocina al confirmarla sala y sale al entregarse.
  useSocketEvent<Order>(socket, 'order:updated', (order) => {
    const inKitchen = order.status === 'CONFIRMED' || order.status === 'PREPARING' || order.status === 'READY';
    const known = orders?.some((o) => o.id === order.id) ?? false;
    if (inKitchen && !known) toast.show(`Comanda nueva: mesa ${order.tableNumber}`, { emoji: '🧾' });
    setOrders((current) => {
      if (!current) return current;
      if (!inKitchen) return current.filter((o) => o.id !== order.id);
      return current.some((o) => o.id === order.id) ? current.map((o) => (o.id === order.id ? order : o)) : [...current, order];
    });
  });
  useSocketEvent<InventoryItem[]>(socket, 'inventory:alert', setAlerts);
  useSocketEvent(socket, 'menu:updated', () => void api.get<Product[]>('/kitchen/products', token).then(setProducts).catch(() => undefined));

  const act = async (action: () => Promise<Order>) => {
    try {
      const order = await action();
      setOrders((current) => current?.map((o) => (o.id === order.id ? order : o)) ?? current);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
      void load();
    }
  };

  const toggleAvailability = async (product: Product) => {
    try {
      await api.patch(`/kitchen/products/${product.id}/availability`, { isAvailable: !product.isAvailable }, token);
      toast.show(product.isAvailable ? `${product.name} marcado como agotado` : `${product.name} vuelve a la carta`);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  return (
    <StaffShell live={connected}>
      <h1 className="mb-4 font-display text-3xl font-bold tracking-tight">Cocina</h1>

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="grid items-start gap-4 md:grid-cols-3">
          {COLUMNS.map((column) => {
            const list = (orders ?? []).filter((order) => order.status === column.status);
            return (
              <section key={column.status} aria-label={column.title}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft">
                  {column.title}
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs tabular-nums text-ink-faint">{list.length}</span>
                </h2>
                <div className="space-y-3">
                  {orders === null ? (
                    <div className="h-40 animate-pulse rounded-2xl bg-surface" />
                  ) : list.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-line p-5 text-sm text-ink-faint">{column.empty}</p>
                  ) : (
                    list.map((order) => (
                      <Ticket
                        key={order.id}
                        order={order}
                        now={now}
                        onItem={(item) => {
                          const next = NEXT_STATUS[item.status];
                          if (next) void act(() => api.patch<Order>(`/kitchen/items/${item.id}`, { status: next }, token));
                        }}
                        onBump={(status) => void act(() => api.patch<Order>(`/kitchen/orders/${order.id}`, { status }, token))}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-soft">Insumos en alerta</h2>
            {alerts.length === 0 ? (
              <p className="text-sm text-ink-faint">Todo el inventario está por encima del punto de pedido.</p>
            ) : (
              <ul className="space-y-2.5">
                {alerts.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm">
                    <AlertIcon level={item.alertLevel} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-ink-faint">
                        Quedan {quantity(item.stock)} {item.unit}, {coverText(item)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold text-ink-soft">Disponibilidad en carta</h2>
            <p className="mb-3 text-sm text-ink-faint">Lo que agotes desaparece de los móviles de los clientes al instante.</p>
            <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
              {products.map((product) => (
                <li key={product.id} className="flex items-center gap-2 text-sm">
                  <span className={`min-w-0 flex-1 truncate ${product.isAvailable ? '' : 'text-ink-faint line-through'}`}>{product.name}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={product.isAvailable}
                    aria-label={`${product.name} disponible`}
                    onClick={() => void toggleAvailability(product)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${product.isAvailable ? 'bg-state-served' : 'bg-state-free'}`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${product.isAvailable ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </StaffShell>
  );
}

/** Para cuánto alcanza un insumo al ritmo de venta actual. */
export function coverText(item: InventoryItem): string {
  if (item.stock <= 0) return 'agotado';
  if (item.daysOfCover === null) return 'sin ventas recientes';
  if (item.daysOfCover < 1) return 'se agota hoy';
  return `alcanza para ${quantity(item.daysOfCover)} días`;
}

export function AlertIcon({ level }: { level: InventoryItem['alertLevel'] }) {
  if (level === 'RED') return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#d03b3b]" aria-label="Crítico" />;
  if (level === 'YELLOW') return <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#c98500]" aria-label="Bajo" />;
  return <Check className="mt-0.5 h-4 w-4 shrink-0 text-state-served" aria-label="Suficiente" />;
}

function Ticket({ order, now, onItem, onBump }: { order: Order; now: number; onItem: (item: OrderItem) => void; onBump: (status: 'PREPARING' | 'READY') => void }) {
  const minutes = minutesSince(order.confirmedAt ?? order.createdAt, now);
  const late = minutes >= 20;
  const items = order.items.filter((item) => item.status !== 'CANCELLED');

  return (
    <article className={`rounded-2xl border bg-surface p-4 ${late && order.status !== 'READY' ? 'border-state-calling' : 'border-line'}`}>
      <header className="mb-3 flex items-baseline gap-2">
        <h3 className="font-display text-2xl font-bold leading-none">Mesa {order.tableNumber}</h3>
        <span className="text-sm tabular-nums text-ink-faint">#{order.number}</span>
        <span className={`ml-auto flex items-center gap-1 text-sm font-semibold tabular-nums ${late ? 'text-state-calling' : 'text-ink-soft'}`}>
          {late && <CircleAlert className="h-4 w-4" aria-hidden />}
          {minutes} min
        </span>
      </header>

      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onItem(item)}
              className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                item.status === 'READY' ? 'bg-sunken text-ink-faint' : item.status === 'PREPARING' ? 'bg-state-waiting/10' : 'hover:bg-sunken'
              }`}
              aria-label={`${item.quantity} ${item.name}: ${ITEM_LABEL[item.status]}. Toca para avanzar.`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                  item.status === 'READY'
                    ? 'border-state-served bg-state-served text-white'
                    : item.status === 'PREPARING'
                      ? 'border-state-waiting text-state-waiting'
                      : 'border-ink-faint'
                }`}
                aria-hidden
              >
                {item.status === 'READY' && <Check className="h-3 w-3" strokeWidth={3} />}
                {item.status === 'PREPARING' && <Flame className="h-3 w-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`font-semibold ${item.status === 'READY' ? 'line-through' : ''}`}>
                  <span className="tabular-nums">{item.quantity}×</span> {item.name}
                </span>
                {item.notes && <span className="mt-0.5 block rounded-md bg-[#fab219]/25 px-1.5 py-0.5 text-sm font-medium text-ink">{item.notes}</span>}
                {item.guestAlias && <span className="block text-xs text-ink-faint">para {item.guestAlias}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {order.status === 'CONFIRMED' && (
        <Button variant="secondary" className="mt-3 w-full" onClick={() => onBump('PREPARING')}>
          Empezar todo
        </Button>
      )}
      {order.status === 'PREPARING' && (
        <Button className="mt-3 w-full" onClick={() => onBump('READY')}>
          Todo listo
        </Button>
      )}
      {order.status === 'READY' && <p className="mt-3 text-center text-sm text-ink-faint">Sala ya fue avisada.</p>}
    </article>
  );
}

const ITEM_LABEL: Record<ItemStatus, string> = {
  PENDING: 'por preparar',
  PREPARING: 'en preparación',
  READY: 'listo',
  SERVED: 'entregado',
  CANCELLED: 'cancelado',
};
