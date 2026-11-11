import { useCallback, useEffect, useState } from 'react';
import { StaffShell } from '../../components/StaffShell';
import { useToast } from '../../components/Toasts';
import { api, errorMessage } from '../../lib/api';
import { useNow } from '../../lib/format';
import { useStaff } from '../../lib/session';
import { useReconnect, useSocket, useSocketEvent } from '../../lib/socket';
import type { CallType, Order, RestaurantTable } from '../../lib/types';
import { FloorMap } from './FloorMap';
import { TableDrawer } from './TableDrawer';

/**
 * Pantalla de sala (Camarero y Admin). Carga las mesas una vez y, a partir de
 * ahí, el mapa se mantiene solo: cada table:updated que llega por WebSocket
 * reemplaza esa mesa y su color cambia al instante.
 */
export function FloorPage() {
  const { token } = useStaff();
  const toast = useToast();
  const now = useNow();
  const [tables, setTables] = useState<RestaurantTable[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { socket, connected } = useSocket({ token });

  const load = useCallback(async () => {
    try {
      setTables(await api.get<RestaurantTable[]>('/tables', token));
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  }, [token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tras una caída de red pudieron perderse eventos: se recarga todo.
  useReconnect(socket, load);

  useSocketEvent<RestaurantTable>(socket, 'table:updated', (table) => {
    setTables((current) => current?.map((t) => (t.id === table.id ? table : t)) ?? current);
    if (table.id === selectedId) setRefreshKey((key) => key + 1);
  });

  useSocketEvent<Order>(socket, 'order:created', (order) => {
    toast.show(`Mesa ${order.tableNumber}: comanda nueva por confirmar`, { emoji: '🧾' });
  });

  useSocketEvent<Order>(socket, 'order:updated', (order) => {
    if (order.tableId === selectedId) setRefreshKey((key) => key + 1);
    if (order.status === 'READY') toast.show(`Mesa ${order.tableNumber}: pedido listo en cocina`, { emoji: '🛎️' });
  });

  useSocketEvent<{ tableNumber: number; type: CallType; guestAlias: string | null }>(socket, 'call:created', (call) => {
    toast.show(call.type === 'BILL' ? `Mesa ${call.tableNumber} pide la cuenta` : `Mesa ${call.tableNumber} llama al camarero`, { tone: 'error', emoji: '🔔' });
  });

  const selected = tables?.find((table) => table.id === selectedId) ?? null;

  return (
    <StaffShell live={connected}>
      <div className={selected ? 'lg:pr-[440px]' : ''}>
        <h1 className="mb-4 font-display text-3xl font-bold tracking-tight">Sala</h1>

        {tables === null ? (
          <div className="h-[420px] animate-pulse rounded-3xl bg-surface" aria-label="Cargando el mapa" />
        ) : tables.length === 0 ? (
          <p className="rounded-3xl border border-dashed border-line p-10 text-center text-ink-soft">
            Este restaurante aún no tiene mesas. Créalas en la tabla restaurant_tables para verlas aquí.
          </p>
        ) : (
          <FloorMap tables={tables} selectedId={selectedId} onSelect={(table) => setSelectedId(table.id)} now={now} />
        )}
      </div>

      {selected && <TableDrawer table={selected} token={token} now={now} refreshKey={refreshKey} onClose={() => setSelectedId(null)} />}
    </StaffShell>
  );
}
