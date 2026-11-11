import { signGuestToken, verifyToken } from '../auth/tokens.js';
import { query, queryOne, tx } from '../db/pool.js';
import { conflict, notFound } from '../http.js';
import { emit, getIo, rooms } from '../realtime/bus.js';
import { getPublicRestaurant, publicRestaurant } from './restaurant.js';
import { publishTable } from './tables.service.js';

/**
 * Los clientes son anónimos, pero en un carrito compartido hace falta saber
 * "quién pidió qué". Cada comensal recibe un número por orden de llegada a la
 * mesa (Cliente #1, Cliente #2…) y un color para reconocerlo de un vistazo.
 */
const GUEST_COLORS = [
  '#1D4ED8', '#BE123C', '#15803D', '#B45309', '#6D28D9', '#0F766E',
  '#C2410C', '#A21CAF', '#4D7C0F', '#0369A1', '#B91C1C', '#7E22CE',
];

export const guestAlias = (number: number): string => `Cliente #${number}`;
const guestColor = (number: number): string => GUEST_COLORS[(number - 1) % GUEST_COLORS.length];

export interface GuestDto {
  id: string;
  number: number;
  alias: string;
  color: string;
  online?: boolean;
}

interface TableRow {
  id: string;
  number: number;
  zone: string;
  seats: number;
  session_id: string | null;
}

/**
 * Puerta de entrada del QR estático (/mesa/:number).
 *
 *   Mesa sin sesión abierta → { state: 'CLOSED' }: el cliente ve la pantalla de
 *   espera y no recibe ningún token. No hay nada que pueda reutilizar.
 *
 *   Mesa abierta por un camarero → { state: 'OPEN', token }: token firmado y
 *   ligado a ESA sesión. Si el cliente ya traía un token de la misma sesión
 *   (recargó la página), conserva su identidad.
 */
export async function joinTable(tableNumber: number, previousToken?: string) {
  const restaurant = await getPublicRestaurant();
  const table = await queryOne<TableRow>(
    `SELECT t.id, t.number, t.zone, t.seats, s.id AS session_id
       FROM restaurant_tables t
       LEFT JOIN table_sessions s ON s.table_id = t.id AND s.closed_at IS NULL
      WHERE t.restaurant_id = $1 AND t.number = $2 AND t.is_active`,
    [restaurant.id, tableNumber],
  );
  if (!table) throw notFound('Esta mesa no existe. Revisa el código QR.');

  const base = {
    restaurant: publicRestaurant(restaurant),
    table: { id: table.id, number: table.number, zone: table.zone },
  };
  if (!table.session_id) return { state: 'CLOSED' as const, ...base };

  // ¿Vuelve alguien que ya estaba sentado en esta misma sesión?
  const previous = previousToken ? verifyToken(previousToken) : null;
  if (previous?.kind === 'guest' && previous.sid === table.session_id) {
    const guest = await queryOne<GuestDto>('SELECT id, number, alias, color FROM session_guests WHERE id = $1 AND session_id = $2', [
      previous.sub,
      table.session_id,
    ]);
    if (guest) return { state: 'OPEN' as const, ...base, token: previousToken!, guest };
  }

  const sessionId = table.session_id;
  const guest = await tx(async (db) => {
    // Bloquea la sesión para repartir los números sin choques y revalidar que siga abierta.
    const session = await queryOne('SELECT id FROM table_sessions WHERE id = $1 AND closed_at IS NULL FOR UPDATE', [sessionId], db);
    if (!session) return null;

    const seats = await queryOne<{ taken: number; next: number }>(
      'SELECT count(*) AS taken, COALESCE(MAX(number), 0) + 1 AS next FROM session_guests WHERE session_id = $1',
      [sessionId],
      db,
    );
    // Tope de comensales por sesión: frena a quien intente inundar la mesa desde el QR.
    if (seats!.taken >= Math.max(table.seats * 2, 8)) {
      throw conflict('Esta mesa ya tiene demasiados dispositivos conectados. Pide ayuda a tu camarero.', 'TABLE_FULL');
    }

    const number = seats!.next;
    // ¿Llega tarde? Si la mesa ya tiene comandas, el camarero debe enterarse para actualizar el pedido.
    const late = Boolean(await queryOne(`SELECT 1 FROM orders WHERE session_id = $1 AND status <> 'CANCELLED' LIMIT 1`, [sessionId], db));
    return queryOne<GuestDto & { joinedLate: boolean }>(
      `INSERT INTO session_guests (session_id, number, alias, color, joined_late) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, number, alias, color, joined_late AS "joinedLate"`,
      [sessionId, number, guestAlias(number), guestColor(number), late],
      db,
    );
  });
  if (!guest) return { state: 'CLOSED' as const, ...base };

  const token = signGuestToken({
    sub: guest.id,
    sid: sessionId,
    tid: table.id,
    rid: restaurant.id,
    number: guest.number,
    alias: guest.alias,
    color: guest.color,
  });

  await publishTable(restaurant.id, table.id); // el mapa muestra un comensal más
  await publishGuests(sessionId);
  const { joinedLate, ...guestDto } = guest;
  if (joinedLate) {
    emit(rooms.staff(restaurant.id), 'guest:late', { tableId: table.id, tableNumber: table.number, alias: guest.alias, color: guest.color });
  }
  return { state: 'OPEN' as const, ...base, token, guest: guestDto, joinedLate };
}

/** Comensales de la sesión, marcando quién tiene la app abierta ahora mismo. */
export async function listGuests(sessionId: string): Promise<GuestDto[]> {
  const guests = await query<GuestDto>('SELECT id, number, alias, color FROM session_guests WHERE session_id = $1 ORDER BY number', [sessionId]);
  let online = new Set<string>();
  try {
    const sockets = await getIo().in(rooms.session(sessionId)).fetchSockets();
    online = new Set(sockets.map((s) => s.data.claims?.sub as string));
  } catch {
    // sin Socket.IO (p. ej. en pruebas) nadie figura conectado
  }
  return guests.map((g) => ({ ...g, online: online.has(g.id) }));
}

export async function publishGuests(sessionId: string): Promise<void> {
  emit(rooms.session(sessionId), 'guests:updated', await listGuests(sessionId));
}
