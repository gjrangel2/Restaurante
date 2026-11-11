import { ClipboardList, ConciergeBell, Users } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { elapsed } from '../../lib/format';
import type { RestaurantTable, TableShape, TableStatus } from '../../lib/types';
import { STATUS_ORDER, TABLE_STATUS, statusIcon, statusSentence } from './tableStatus';

/**
 * Mapa visual del restaurante.
 *
 * Dibuja el salón como un plano: cada mesa es un botón colocado en una grilla
 * (pos_x / pos_y vienen de la base de datos) con forma de mesa vista desde
 * arriba, sus sillas alrededor y el color de su estado:
 *
 *   Libre ................ gris
 *   Ocupada .............. azul      leyendo la carta
 *   Esperando pedido ..... naranja   comanda por confirmar o en cocina
 *   Servida .............. verde     comiendo
 *   Llamando ............. rojo parpadeante   llama al camarero o pide la cuenta
 *
 * El componente es de presentación: recibe las mesas ya actualizadas (FloorPage
 * las mantiene al día por WebSocket) y avisa cuál se tocó. No pide datos.
 */
interface FloorMapProps {
  tables: RestaurantTable[];
  selectedId: string | null;
  onSelect: (table: RestaurantTable) => void;
  now: number; // reloj compartido para los "hace 12 min"
}

const span = (shape: TableShape) => (shape === 'RECT' ? 2 : 1);
const AISLE = '20px'; // ancho de una columna o fila sin mesas

export function FloorMap({ tables, selectedId, onSelect, now }: FloorMapProps) {
  // Filtro por estado: tocar un chip de la leyenda atenúa las demás mesas.
  const [filter, setFilter] = useState<TableStatus | null>(null);

  const counts = useMemo(() => {
    const result: Record<TableStatus, number> = { FREE: 0, OCCUPIED: 0, WAITING_ORDER: 0, SERVED: 0, CALLING: 0 };
    for (const table of tables) result[table.status]++;
    return result;
  }, [tables]);

  // Geometría del plano, deducida de las posiciones de las mesas:
  //   · contorno de cada zona (la caja que envuelve a sus mesas)
  //   · columnas y filas sin ninguna mesa → pasillos estrechos
  const { columnTracks, rowTracks, zones } = useMemo(() => {
    const usedColumns = new Set<number>();
    const usedRows = new Set<number>();
    const boxes = new Map<string, { minX: number; maxX: number; minY: number; maxY: number; count: number }>();

    for (const table of tables) {
      const right = table.posX + span(table.shape) - 1;
      for (let x = table.posX; x <= right; x++) usedColumns.add(x);
      usedRows.add(table.posY);

      const box = boxes.get(table.zone);
      if (box) {
        box.minX = Math.min(box.minX, table.posX);
        box.maxX = Math.max(box.maxX, right);
        box.minY = Math.min(box.minY, table.posY);
        box.maxY = Math.max(box.maxY, table.posY);
        box.count++;
      } else {
        boxes.set(table.zone, { minX: table.posX, maxX: right, minY: table.posY, maxY: table.posY, count: 1 });
      }
    }

    const tracks = (used: Set<number>, size: string) =>
      Array.from({ length: Math.max(0, ...used) + 1 }, (_, i) => (used.has(i) ? size : AISLE)).join(' ');

    return {
      columnTracks: tracks(usedColumns, 'minmax(0, 1fr)'),
      rowTracks: tracks(usedRows, 'auto'),
      zones: [...boxes.entries()].map(([name, box]) => ({ name, ...box })),
    };
  }, [tables]);

  const busy = tables.length - counts.FREE;

  return (
    <section aria-label="Mapa del restaurante">
      {/* Leyenda: explica los colores, cuenta las mesas y sirve de filtro */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUS_ORDER.map((status) => {
          const style = TABLE_STATUS[status];
          const active = filter === status;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(active ? null : status)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                active ? 'border-ink bg-ink text-surface' : 'border-line bg-surface text-ink-soft hover:border-ink-faint'
              }`}
            >
              <span className={`relative h-2.5 w-2.5 rounded-full ${style.dot} ${style.blink && counts[status] > 0 ? 'animate-blink' : ''}`} aria-hidden />
              {style.label}
              <span className={`tabular-nums ${active ? 'text-surface/70' : 'text-ink-faint'}`}>{counts[status]}</span>
            </button>
          );
        })}
        <p className="ml-auto text-sm text-ink-faint">
          {busy} de {tables.length} mesas ocupadas
        </p>
      </div>

      {/* Plano. En pantallas estrechas se desplaza en horizontal sin deformar las mesas. */}
      <div className="overflow-x-auto rounded-3xl border border-line bg-surface">
        <div className="floor-dots min-w-[860px] p-8 pt-10">
          <div
            className="grid gap-7"
            style={{ gridTemplateColumns: columnTracks, gridTemplateRows: rowTracks }}
          >
            {zones.map((zone) => (
              <ZoneOutline key={zone.name} {...zone} />
            ))}

            {tables.map((table) => (
              <TableNode
                key={table.id}
                table={table}
                now={now}
                selected={table.id === selectedId}
                dimmed={filter !== null && table.status !== filter}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Clave de los avisos que aparecen en la esquina de una mesa */}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-faint">
        <li className="flex items-center gap-1.5">
          <ClipboardList className="h-4 w-4 text-state-waiting" aria-hidden /> Comanda por confirmar
        </li>
        <li className="flex items-center gap-1.5">
          <ConciergeBell className="h-4 w-4 text-state-served" aria-hidden /> Pedido listo para llevar a la mesa
        </li>
      </ul>
    </section>
  );
}

/** Contorno punteado que agrupa las mesas de una zona (Salón, Terraza, Barra…). */
function ZoneOutline({ name, minX, maxX, minY, maxY, count }: { name: string; minX: number; maxX: number; minY: number; maxY: number; count: number }) {
  return (
    <div
      className="pointer-events-none relative -m-3 rounded-[28px] border border-dashed border-ink-faint/40 bg-sunken/70"
      style={{ gridColumn: `${minX + 1} / ${maxX + 2}`, gridRow: `${minY + 1} / ${maxY + 2}` }}
      aria-hidden
    >
      <span className="absolute -top-3 left-5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-ink-soft">
        {name}, {count} {count === 1 ? 'mesa' : 'mesas'}
      </span>
    </div>
  );
}

interface TableNodeProps {
  table: RestaurantTable;
  now: number;
  selected: boolean;
  dimmed: boolean;
  onSelect: (table: RestaurantTable) => void;
}

function TableNode({ table, now, selected, dimmed, onSelect }: TableNodeProps) {
  const style = TABLE_STATUS[table.status];
  const Icon = statusIcon(table);
  const wide = table.shape === 'RECT';
  const topShape = table.shape === 'ROUND' ? 'inset-[15%] rounded-full' : wide ? 'inset-x-[8%] inset-y-[15%] rounded-[18px]' : 'inset-[15%] rounded-[18px]';
  const session = table.session;

  const label =
    `Mesa ${table.number}, ${style.label.toLowerCase()}: ${statusSentence(table).toLowerCase()}` +
    (table.status === 'FREE' ? `, ${table.seats} puestos` : `, hace ${elapsed(table.statusChangedAt, now)}`);

  return (
    <button
      type="button"
      onClick={() => onSelect(table)}
      aria-label={label}
      aria-pressed={selected}
      className={`group relative rounded-[22px] outline-offset-4 transition-[opacity,transform] duration-200 hover:scale-[1.03] ${
        wide ? 'aspect-[2/1]' : 'aspect-square'
      } ${dimmed ? 'opacity-25' : 'opacity-100'}`}
      style={{ gridColumn: `${table.posX + 1} / span ${span(table.shape)}`, gridRow: table.posY + 1 }}
    >
      {/* Sillas */}
      {chairPositions(table.shape, table.seats).map((position, index) => (
        <span key={index} className={`absolute h-[11%] rounded-full ${wide ? 'w-[5.5%]' : 'w-[11%]'} ${style.chair}`} style={position} aria-hidden />
      ))}

      {/* Onda roja: refuerza el parpadeo y sigue visible con las animaciones reducidas */}
      {style.blink && <span className={`absolute ${topShape} animate-ring border-2 border-state-calling`} aria-hidden />}

      {/* Tablero */}
      <span
        className={`absolute ${topShape} flex flex-col items-center justify-center shadow-sm transition-colors duration-300 ${style.top} ${style.ink} ${
          style.blink ? 'animate-blink' : ''
        } ${selected ? 'ring-[3px] ring-ink ring-offset-2 ring-offset-surface' : ''}`}
      >
        <span className="font-display text-2xl font-bold leading-none">{table.number}</span>
        <span className="mt-1 flex items-center gap-1 text-[11px] font-medium leading-none opacity-90">
          {table.status === 'FREE' ? (
            <>
              <Users className="h-3 w-3" aria-hidden />
              {table.seats}
            </>
          ) : (
            <>
              {Icon && <Icon className="h-3 w-3" aria-hidden />}
              {elapsed(table.statusChangedAt, now)}
            </>
          )}
        </span>
      </span>

      {/* Avisos: lo que el camarero tiene que hacer en esta mesa */}
      {session && (session.pendingOrders > 0 || session.readyOrders > 0) && (
        <span className="absolute right-0 top-0 flex gap-1">
          {session.pendingOrders > 0 && (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-surface text-state-waiting shadow-lift ring-1 ring-line" title="Comanda por confirmar">
              <ClipboardList className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
          {session.readyOrders > 0 && (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-surface text-state-served shadow-lift ring-1 ring-line" title="Pedido listo en cocina">
              <ConciergeBell className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * Posición de cada silla (centro, en % del recuadro de la mesa).
 *   Redonda: repartidas en círculo.
 *   Cuadrada: una por lado (dos enfrentadas si es de 2 puestos).
 *   Rectangular: cabeceras + el resto repartido arriba y abajo.
 */
function chairPositions(shape: TableShape, seats: number): CSSProperties[] {
  const at = (left: number, top: number): CSSProperties => ({ left: `${left}%`, top: `${top}%`, transform: 'translate(-50%, -50%)' });

  if (shape === 'ROUND') {
    const count = Math.min(seats, 8);
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2 + (count === 2 ? Math.PI / 2 : 0);
      return at(50 + 43 * Math.cos(angle), 50 + 43 * Math.sin(angle));
    });
  }

  if (shape === 'SQUARE') {
    const sides = [at(7, 50), at(93, 50), at(50, 7), at(50, 93)];
    return seats <= 2 ? sides.slice(0, 2) : sides;
  }

  const perSide = Math.max(1, Math.min(4, Math.ceil((seats - 2) / 2)));
  const along = Array.from({ length: perSide }, (_, i) => 8 + ((i + 0.5) / perSide) * 84);
  return [at(3.5, 50), at(96.5, 50), ...along.map((x) => at(x, 7)), ...along.map((x) => at(x, 93))];
}
