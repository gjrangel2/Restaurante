import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../../lib/api';
import { money } from '../../lib/format';
import { useSocket, useSocketEvent } from '../../lib/socket';
import type { Guest, JoinResponse, RestaurantInfo } from '../../lib/types';
import { CustomerMenu } from './CustomerMenu';

type Phase =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; restaurant: RestaurantInfo } // mesa cerrada: pantalla de espera
  | { kind: 'open'; restaurant: RestaurantInfo; token: string; guest: Guest }
  | { kind: 'thanks'; restaurant: RestaurantInfo; invoiceNumber?: string; grandTotal?: number };

/**
 * Entrada del QR estático: /mesa/:number
 *
 * El QR nunca cambia; lo que decide si se puede pedir es el estado de la mesa:
 *   · Cerrada → pantalla de espera. El cliente no recibe token y no puede
 *     hacer nada. La pantalla escucha en vivo y entra sola cuando el camarero
 *     abre la mesa.
 *   · Abierta → recibe un token ligado a ESA sesión y ve la carta.
 *   · Pago validado → el token muere y aparece la despedida.
 */
export function CustomerApp() {
  const { number } = useParams();
  const tableNumber = Number(number);
  const storageKey = `fo.guest.${tableNumber}`;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const requestJoin = useCallback(async () => {
    if (!Number.isInteger(tableNumber) || tableNumber <= 0) {
      setPhase({ kind: 'not-found' });
      return;
    }
    try {
      // Si ya estaba sentado en esta sesión (recargó la página), conserva su identidad.
      const previous = readToken(storageKey);
      const result = await api.post<JoinResponse>(`/public/tables/${tableNumber}/join`, previous ? { token: previous } : {});
      if (result.state === 'OPEN') {
        writeToken(storageKey, result.token);
        setPhase({ kind: 'open', restaurant: result.restaurant, token: result.token, guest: result.guest });
      } else {
        writeToken(storageKey, null);
        setPhase((current) => (current.kind === 'thanks' ? current : { kind: 'closed', restaurant: result.restaurant }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setPhase({ kind: 'not-found' });
      else setPhase((current) => (current.kind === 'closed' ? current : { kind: 'error', message: errorMessage(err) }));
    }
  }, [tableNumber, storageKey]);

  // Dos llamadas simultáneas crearían dos comensales para la misma persona
  // (pasa, por ejemplo, con el doble montaje de React en desarrollo): si ya
  // hay una entrada en curso, se reutiliza.
  const joining = useRef<Promise<void> | null>(null);
  const join = useCallback(() => {
    joining.current ??= requestJoin().finally(() => {
      joining.current = null;
    });
    return joining.current;
  }, [requestJoin]);

  useEffect(() => {
    void join();
  }, [join]);

  // En espera: aviso en vivo de que la mesa se abrió, con sondeo de respaldo cada 20 s.
  const waiting = phase.kind === 'closed';
  const { socket: lobby } = useSocket(waiting ? { lobbyTable: tableNumber } : null);
  useSocketEvent(lobby, 'table:opened', () => void join());
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void join(), 20_000);
    return () => clearInterval(id);
  }, [waiting, join]);

  const onSessionClosed = useCallback(
    (info: { reason: 'PAID' | 'CANCELLED'; invoiceNumber?: string; grandTotal?: number }) => {
      writeToken(storageKey, null);
      setPhase((current) => {
        if (current.kind !== 'open') return current;
        return info.reason === 'PAID'
          ? { kind: 'thanks', restaurant: current.restaurant, invoiceNumber: info.invoiceNumber, grandTotal: info.grandTotal }
          : { kind: 'closed', restaurant: current.restaurant };
      });
    },
    [storageKey],
  );

  switch (phase.kind) {
    case 'open':
      return <CustomerMenu key={phase.token} token={phase.token} me={phase.guest} tableNumber={tableNumber} restaurant={phase.restaurant} onSessionClosed={onSessionClosed} />;

    case 'closed':
      return (
        <FullScreen restaurant={phase.restaurant.name}>
          <TableMarker number={tableNumber} />
          <h1 className="mt-8 font-display text-3xl font-bold leading-tight">Tu camarero está por abrir la mesa</h1>
          <p className="mt-3 text-white/75">En cuanto la abra, la carta aparece aquí sola. No hace falta recargar.</p>
          <div className="mt-8 flex gap-2" role="status" aria-label="Esperando a que abran la mesa">
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="h-2.5 w-2.5 animate-blink rounded-full bg-maiz" style={{ animationDelay: `${dot * 0.25}s` }} />
            ))}
          </div>
        </FullScreen>
      );

    case 'thanks':
      return (
        <FullScreen restaurant={phase.restaurant.name}>
          <TableMarker number={tableNumber} />
          <h1 className="mt-8 font-display text-4xl font-bold leading-tight">Gracias por venir</h1>
          <p className="mt-3 text-white/75">
            {phase.grandTotal !== undefined ? `Pago recibido: ${money(phase.grandTotal, phase.restaurant.currency)}.` : 'Pago recibido.'}
            {phase.invoiceNumber && ` Factura ${phase.invoiceNumber}.`}
          </p>
          <p className="mt-6 text-sm text-white/60">La mesa quedó cerrada. Esperamos verte pronto.</p>
        </FullScreen>
      );

    case 'not-found':
      return (
        <FullScreen>
          <h1 className="font-display text-3xl font-bold leading-tight">Esta mesa no existe</h1>
          <p className="mt-3 text-white/75">Vuelve a escanear el código QR de tu mesa o pide ayuda a tu camarero.</p>
        </FullScreen>
      );

    case 'error':
      return (
        <FullScreen>
          <h1 className="font-display text-3xl font-bold leading-tight">No pudimos cargar la carta</h1>
          <p className="mt-3 text-white/75">{phase.message}</p>
          <button type="button" onClick={() => void join()} className="mt-6 rounded-full bg-maiz px-6 py-3 font-semibold text-tinta">
            Reintentar
          </button>
        </FullScreen>
      );

    default:
      return (
        <FullScreen>
          <div className="h-24 w-24 animate-pulse rounded-3xl bg-white/15" aria-label="Cargando" role="status" />
        </FullScreen>
      );
  }
}

function FullScreen({ restaurant, children }: { restaurant?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-hoja px-7 pb-10 pt-8 text-white">
      {restaurant && <p className="font-display text-xl font-bold">{restaurant}</p>}
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">{children}</div>
    </main>
  );
}

/** El número de mesa como el marcador que hay sobre la mesa real. */
function TableMarker({ number }: { number: number }) {
  return (
    <div className="grid h-28 w-28 place-items-center rounded-[28px] bg-maiz text-tinta">
      <div className="text-center leading-none">
        <span className="block text-sm font-semibold">Mesa</span>
        <span className="font-display text-6xl font-extrabold">{number}</span>
      </div>
    </div>
  );
}

// El token se guarda por mesa para sobrevivir a una recarga. Si el navegador
// bloquea localStorage (modo privado estricto), la app funciona igual: solo
// se pierde la identidad al recargar.
function readToken(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeToken(key: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
  } catch {
    // sin almacenamiento disponible
  }
}
