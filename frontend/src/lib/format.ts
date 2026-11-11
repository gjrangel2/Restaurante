import { useEffect, useState } from 'react';

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** $ 32.000 para COP (sin decimales); respeta los decimales de otras monedas. */
export function money(value: number, currency = 'COP'): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(value);
}

/** Cifras grandes en compacto para las tarjetas del dashboard: $ 1,2 M */
export function moneyCompact(value: number, currency = 'COP'): string {
  if (Math.abs(value) < 1_000_000) return money(value, currency);
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export const quantity = (value: number): string => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(value);

/** Minutos transcurridos desde una fecha ISO. */
export const minutesSince = (iso: string, now = Date.now()): number => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/** "ahora", "12 min", "1 h 05" */
export function elapsed(iso: string, now = Date.now()): string {
  const minutes = minutesSince(iso, now);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });

/** Reloj que se actualiza solo: los "hace 12 min" del mapa y de cocina avanzan sin recargar. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
