import { useState } from 'react';
import { money, moneyCompact } from '../../lib/format';
import type { Kpis } from '../../lib/types';

const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'short' }).replace('.', '');
const fullDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Ventas por día. Una sola serie, así que no lleva leyenda: el título dice qué es.
 * Barras finas ancladas a la base, rejilla discreta, valor directo solo en el
 * día de hoy, detalle al pasar el cursor o enfocar, y vista de tabla alterna.
 */
export function SalesChart({ daily, currency }: { daily: Kpis['daily']; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const max = Math.max(1, ...daily.map((d) => d.sales));
  const niceMax = niceCeil(max);
  const ticks = [0, 0.5, 1].map((t) => t * niceMax);
  const todayIndex = daily.length - 1;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Ventas de los últimos {daily.length} días</h2>
        <button type="button" onClick={() => setAsTable((v) => !v)} className="text-sm font-medium text-ink-soft underline-offset-2 hover:underline" aria-pressed={asTable}>
          {asTable ? 'Ver gráfico' : 'Ver tabla'}
        </button>
      </div>

      {asTable ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-faint">
              <th className="py-2 font-medium">Día</th>
              <th className="py-2 text-right font-medium">Cuentas</th>
              <th className="py-2 text-right font-medium">Ventas</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.day} className="border-b border-line last:border-0">
                <td className="py-2 capitalize">{fullDate(d.day)}</td>
                <td className="py-2 text-right tabular-nums">{d.tickets}</td>
                <td className="py-2 text-right tabular-nums">{money(d.sales, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex gap-3">
          {/* Eje Y */}
          <div className="relative h-48 w-14 shrink-0 text-right text-xs tabular-nums text-ink-faint" aria-hidden>
            {ticks.map((tick) => (
              <span key={tick} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(tick / niceMax) * 100}%` }}>
                {tick === 0 ? '0' : moneyCompact(tick, currency)}
              </span>
            ))}
          </div>

          <div className="relative min-w-0 flex-1">
            {/* Rejilla */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-48" aria-hidden>
              {ticks.map((tick) => (
                <span key={tick} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${(tick / niceMax) * 100}%` }} />
              ))}
            </div>

            <ul className="relative flex h-48 items-end" aria-label="Ventas por día">
              {daily.map((d, i) => {
                const height = (d.sales / niceMax) * 100;
                const active = hover === i;
                return (
                  <li
                    key={d.day}
                    className="relative flex h-full flex-1 items-end justify-center outline-none"
                    tabIndex={0}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    aria-label={`${fullDate(d.day)}: ${money(d.sales, currency)} en ${d.tickets} cuentas`}
                  >
                    {/* Banda de fondo: zona de contacto más grande que la barra */}
                    {active && <span className="absolute inset-x-1 inset-y-0 rounded-lg bg-sunken" aria-hidden />}
                    {i === todayIndex && d.sales > 0 && !active && (
                      <span className="absolute text-xs font-semibold tabular-nums text-ink" style={{ bottom: `calc(${height}% + 6px)` }}>
                        {moneyCompact(d.sales, currency)}
                      </span>
                    )}
                    <span
                      className={`relative w-6 max-w-[60%] rounded-t bg-series transition-opacity ${hover !== null && !active ? 'opacity-50' : ''}`}
                      style={{ height: `${Math.max(height, d.sales > 0 ? 1.5 : 0)}%` }}
                    />
                    {active && (
                      <div className="pointer-events-none absolute bottom-full z-10 mb-1 w-max rounded-xl border border-line bg-surface px-3 py-2 text-left text-xs shadow-lift" role="tooltip">
                        <p className="font-semibold capitalize text-ink">{fullDate(d.day)}</p>
                        <p className="tabular-nums text-ink-soft">
                          {money(d.sales, currency)} en {d.tickets} cuentas
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Eje X */}
            <ul className="mt-2 flex text-center text-xs text-ink-faint" aria-hidden>
              {daily.map((d, i) => (
                <li key={d.day} className={`flex-1 capitalize ${i === todayIndex ? 'font-semibold text-ink' : ''}`}>
                  {i === todayIndex ? 'Hoy' : weekday(d.day)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** Redondea hacia arriba a un tope "limpio" para el eje (1, 2, 3, 4, 5, 6, 8 o 10 × 10ⁿ). */
function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 2, 3, 4, 5, 6, 8, 10].find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}
