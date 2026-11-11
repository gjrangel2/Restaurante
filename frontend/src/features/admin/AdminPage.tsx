import { ArrowDownRight, ArrowUpRight, PackagePlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, StaffShell } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { money, moneyCompact, quantity } from '../../lib/format';
import { useStaff } from '../../lib/session';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { InventoryItem, Kpis, ProductSales } from '../../lib/types';
import { AlertIcon, coverText } from '../kitchen/KitchenPage';
import { MenuAdmin } from './MenuAdmin';
import { PromotionsAdmin } from './PromotionsAdmin';
import { SalesChart } from './SalesChart';
import { inputClass } from './ui';

const TABS = [
  { id: 'summary', label: 'Resumen' },
  { id: 'menu', label: 'Carta' },
  { id: 'promotions', label: 'Banners' },
  { id: 'inventory', label: 'Inventario' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Dashboard del Admin/Gerente: KPIs del día, platos estrella y menos
 * vendidos, alertas de inventario, y la gestión de carta y banners.
 * Se refresca solo cuando se cobra una mesa o cambia el inventario.
 */
export function AdminPage() {
  const { token } = useStaff();
  const toast = useToast();
  const { socket, connected } = useSocket({ token });
  const [tab, setTab] = useState<TabId>('summary');
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, inv] = await Promise.all([api.get<Kpis>('/admin/kpis', token), api.get<InventoryItem[]>('/admin/inventory', token)]);
      setKpis(k);
      setInventory(inv);
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(socket, load);

  // Varios eventos pueden llegar juntos (cobro = mesa + factura): se agrupan en una sola recarga.
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const refreshSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useSocketEvent(socket, 'invoice:issued', refreshSoon);
  useSocketEvent(socket, 'table:updated', refreshSoon);
  useSocketEvent(socket, 'inventory:alert', refreshSoon);

  const alerts = inventory?.filter((item) => item.alertLevel !== 'OK') ?? [];

  return (
    <StaffShell live={connected}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-3xl font-bold tracking-tight">{TABS.find((t) => t.id === tab)!.label}</h1>
        <div className="flex gap-1 rounded-full border border-line bg-surface p-1" role="tablist" aria-label="Secciones de administración">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${tab === item.id ? 'bg-ink text-surface' : 'text-ink-soft hover:bg-sunken'}`}
            >
              {item.label}
              {item.id === 'inventory' && alerts.length > 0 && (
                <span className="ml-1.5 rounded-full bg-[#d03b3b] px-1.5 py-0.5 text-[11px] font-bold text-white">{alerts.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'summary' && <Summary kpis={kpis} alerts={alerts} loadingInventory={inventory === null} onSeeInventory={() => setTab('inventory')} />}
      {tab === 'menu' && kpis && <MenuAdmin token={token} currency={kpis.currency} />}
      {tab === 'promotions' && <PromotionsAdmin token={token} />}
      {tab === 'inventory' && <Inventory token={token} items={inventory} onChanged={setInventory} />}
    </StaffShell>
  );
}

// ----------------------------------------------------------------------------
// Resumen
// ----------------------------------------------------------------------------
function Summary({ kpis, alerts, loadingInventory, onSeeInventory }: { kpis: Kpis | null; alerts: InventoryItem[]; loadingInventory: boolean; onSeeInventory: () => void }) {
  if (!kpis) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface" />
        ))}
        <div className="h-72 animate-pulse rounded-2xl bg-surface sm:col-span-2 xl:col-span-4" />
      </div>
    );
  }

  const c = kpis.currency;
  // Las dos listas comparten escala: así una barra corta en "menos vendidos" se lee contra el plato estrella.
  const maxUnits = Math.max(1, ...kpis.topProducts.map((p) => p.units));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Ventas de hoy" value={moneyCompact(kpis.salesToday, c)} current={kpis.salesToday} previous={kpis.salesYesterdaySameTime} versus="ayer a esta hora" note={`${kpis.ticketsToday} cuentas cobradas`} />
        <StatTile label="Ticket medio" value={money(Math.round(kpis.avgTicketToday), c)} current={kpis.avgTicketToday} previous={kpis.avgTicketYesterday} versus="ayer" note="por cuenta cobrada" />
        <StatTile label="Mesas abiertas" value={`${kpis.openTables} de ${kpis.totalTables}`} note="en este momento" />
        <StatTile label="Por cobrar" value={moneyCompact(kpis.openAmount, c)} note="consumo de las mesas abiertas" />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card className="p-5">
            <SalesChart daily={kpis.daily} currency={c} />
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Ranking title="Platos estrella" subtitle={`Los más vendidos en ${kpis.periodDays} días`} products={kpis.topProducts} max={maxUnits} currency={c} />
            <Ranking title="Menos vendidos" subtitle="Candidatos a promoción o a salir de la carta" products={kpis.bottomProducts} max={maxUnits} currency={c} />
          </div>
        </div>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-semibold">Alertas de inventario</h2>
            <button type="button" onClick={onSeeInventory} className="text-sm font-medium text-ink-soft underline-offset-2 hover:underline">
              Ver inventario
            </button>
          </div>
          {loadingInventory ? (
            <div className="h-32 animate-pulse rounded-xl bg-sunken" />
          ) : alerts.length === 0 ? (
            <p className="text-sm text-ink-faint">Sin alertas: todos los insumos están por encima de su punto de pedido.</p>
          ) : (
            <ul className="space-y-3">
              {alerts.slice(0, 8).map((item) => (
                <li key={item.id} className={`flex items-start gap-2.5 rounded-xl border-l-4 bg-sunken p-3 text-sm ${item.alertLevel === 'RED' ? 'border-[#d03b3b]' : 'border-[#fab219]'}`}>
                  <AlertIcon level={item.alertLevel} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {item.name}
                      <span className="ml-1.5 font-normal text-ink-soft">{coverText(item)}</span>
                    </p>
                    <p className="truncate text-ink-faint">Afecta a {item.affectedProducts.slice(0, 3).join(', ') || 'ningún plato'}</p>
                  </div>
                </li>
              ))}
              {alerts.length > 8 && <li className="text-sm text-ink-faint">y {alerts.length - 8} más.</li>}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Cifra principal con variación frente a ayer (cuando aplica). */
function StatTile({ label, value, note, current, previous, versus }: { label: string; value: string; note: string; current?: number; previous?: number; versus?: string }) {
  const delta = current !== undefined && previous ? ((current - previous) / previous) * 100 : null;
  return (
    <Card className="p-5">
      <p className="text-sm text-ink-soft">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-ink-faint">
        {delta !== null && (
          <span className={`flex items-center font-semibold ${delta >= 0 ? 'text-state-served' : 'text-[#d03b3b]'}`}>
            {delta >= 0 ? <ArrowUpRight className="h-4 w-4" aria-hidden /> : <ArrowDownRight className="h-4 w-4" aria-hidden />}
            {delta >= 0 ? '+' : '−'}
            {Math.abs(Math.round(delta))}% vs. {versus}
          </span>
        )}
        <span>{note}</span>
      </p>
    </Card>
  );
}

function Ranking({ title, subtitle, products, max, currency }: { title: string; subtitle: string; products: ProductSales[]; max: number; currency: string }) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-ink-faint">{subtitle}</p>
      <ol className="space-y-3">
        {products.map((product) => (
          <li key={product.id} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{product.name}</span>
              <span className="shrink-0 tabular-nums text-ink-soft">
                {product.units} und <span className="text-ink-faint">({moneyCompact(product.revenue, currency)})</span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-sunken" aria-hidden>
              <div className="h-full rounded-full bg-series" style={{ width: `${(product.units / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Inventario
// ----------------------------------------------------------------------------
const LEVEL_TEXT: Record<InventoryItem['alertLevel'], string> = { RED: 'Crítico', YELLOW: 'Bajo', OK: 'Suficiente' };

function Inventory({ token, items, onChanged }: { token: string; items: InventoryItem[] | null; onChanged: (items: InventoryItem[]) => void }) {
  const toast = useToast();
  const [restocking, setRestocking] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  const restock = async (item: InventoryItem) => {
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value === 0) return;
    try {
      onChanged(await api.post<InventoryItem[]>(`/admin/inventory/${item.id}/restock`, { quantity: value }, token));
      toast.show(`${item.name}: entrada de ${quantity(value)} ${item.unit}`, { tone: 'success' });
      setRestocking(null);
      setAmount('');
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  if (!items) return <div className="h-96 animate-pulse rounded-2xl bg-surface" />;

  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <caption className="border-b border-line p-4 text-left text-ink-faint">
          El stock baja solo con cada comanda confirmada, según la receta de cada plato. La alerta combina el punto de pedido con la rotación de los últimos 7 días.
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-faint">
            <th className="px-4 py-3 font-medium">Insumo</th>
            <th className="px-4 py-3 font-medium">Estado</th>
            <th className="px-4 py-3 text-right font-medium">Stock</th>
            <th className="px-4 py-3 text-right font-medium">Punto de pedido</th>
            <th className="px-4 py-3 text-right font-medium">Uso diario</th>
            <th className="px-4 py-3 text-right font-medium">Cobertura</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line last:border-0">
              <td className="px-4 py-3 font-medium">{item.name}</td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-1.5">
                  <AlertIcon level={item.alertLevel} /> {LEVEL_TEXT[item.alertLevel]}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {quantity(item.stock)} {item.unit}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
                {quantity(item.reorderLevel)} {item.unit}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{item.avgDailyUsage > 0 ? `${quantity(item.avgDailyUsage)} ${item.unit}` : 'sin ventas'}</td>
              <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{item.daysOfCover !== null ? `${quantity(item.daysOfCover)} días` : 'n/a'}</td>
              <td className="px-4 py-2 text-right">
                {restocking === item.id ? (
                  <form
                    className="flex justify-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void restock(item);
                    }}
                  >
                    <input
                      autoFocus
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      onKeyDown={(event) => event.key === 'Escape' && setRestocking(null)}
                      placeholder={`Cantidad en ${item.unit}`}
                      aria-label={`Cantidad de ${item.name} que entra, en ${item.unit}`}
                      className={`${inputClass} w-36 py-1.5`}
                    />
                    <Button type="submit" className="py-1.5">
                      Registrar
                    </Button>
                  </form>
                ) : (
                  <Button
                    variant="ghost"
                    className="py-1.5"
                    onClick={() => {
                      setRestocking(item.id);
                      setAmount('');
                    }}
                  >
                    <PackagePlus className="h-4 w-4" aria-hidden /> Registrar entrada
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
