import type { GuestClaims, StaffClaims } from '../auth/tokens.js';
import { pool, query, queryOne, tx, type Db } from '../db/pool.js';
import { conflict, notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';

export type TableStatus = 'FREE' | 'OCCUPIED' | 'WAITING_ORDER' | 'SERVED' | 'CALLING';

export interface TableDto {
  id: string;
  number: number;
  seats: number;
  zone: string;
  shape: 'ROUND' | 'SQUARE' | 'RECT';
  posX: number;
  posY: number;
  status: TableStatus;
  statusChangedAt: string;
  session: null | {
    id: string;
    openedAt: string;
    guests: number;
    pendingOrders: number; // comandas que esperan confirmación del camarero
    readyOrders: number; // comandas listas en cocina, por llevar a la mesa
    total: number;
    call: null | { id: string; type: 'WAITER' | 'BILL'; createdAt: string; guestAlias: string | null };
    // Comensales que se unieron cuando la mesa ya había pedido y el camarero aún no ha visto.
    lateGuests: Array<{ id: string; alias: string; color: string; joinedAt: string }>;
    payingOnline: boolean; // un comensal está en la pasarela pagando la cuenta
  };
}

const TABLE_SELECT = `
  SELECT t.id, t.number, t.seats, t.zone, t.shape, t.pos_x AS "posX", t.pos_y AS "posY",
         t.status, t.status_changed_at AS "statusChangedAt",
         CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object(
           'id', s.id,
           'openedAt', s.opened_at,
           'guests', (SELECT count(*) FROM session_guests g WHERE g.session_id = s.id),
           'pendingOrders', (SELECT count(*) FROM orders o WHERE o.session_id = s.id AND o.status = 'PENDING'),
           'readyOrders', (SELECT count(*) FROM orders o WHERE o.session_id = s.id AND o.status = 'READY'),
           'total', (SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0)
                       FROM orders o JOIN order_items oi ON oi.order_id = o.id
                      WHERE o.session_id = s.id AND o.status <> 'CANCELLED' AND oi.status <> 'CANCELLED'),
           'call', (SELECT json_build_object('id', c.id, 'type', c.type, 'createdAt', c.created_at, 'guestAlias', c.guest_alias)
                      FROM waiter_calls c
                     WHERE c.session_id = s.id AND c.attended_at IS NULL
                     ORDER BY (c.type = 'BILL') DESC, c.created_at
                     LIMIT 1),
           'lateGuests', COALESCE((SELECT json_agg(json_build_object('id', g.id, 'alias', g.alias, 'color', g.color, 'joinedAt', g.joined_at)
                                                   ORDER BY g.number)
                                     FROM session_guests g
                                    WHERE g.session_id = s.id AND g.joined_late AND g.late_ack_at IS NULL), '[]'::json),
           'payingOnline', EXISTS (SELECT 1 FROM payment_intents pi
                                    WHERE pi.session_id = s.id AND pi.status = 'PENDING' AND pi.expires_at > now())
         ) END AS session
    FROM restaurant_tables t
    LEFT JOIN table_sessions s ON s.table_id = t.id AND s.closed_at IS NULL`;

export function listTables(restaurantId: string): Promise<TableDto[]> {
  return query<TableDto>(`${TABLE_SELECT} WHERE t.restaurant_id = $1 AND t.is_active ORDER BY t.number`, [restaurantId]);
}

export async function getTable(restaurantId: string, tableId: string, db: Db = pool): Promise<TableDto> {
  const table = await queryOne<TableDto>(`${TABLE_SELECT} WHERE t.restaurant_id = $1 AND t.id = $2`, [restaurantId, tableId], db);
  if (!table) throw notFound('Mesa no encontrada');
  return table;
}

/**
 * Fuente única de verdad del color de una mesa. El estado no se "empuja" a
 * mano desde cada endpoint: se DERIVA de lo que hay en la base de datos y se
 * guarda en restaurant_tables.status como caché para pintar el mapa rápido.
 *
 *   sin sesión abierta ............................. FREE           (gris)
 *   llamado o cuenta sin atender ................... CALLING        (rojo parpadeante)
 *   alguna comanda viva (por confirmar o en cocina)  WAITING_ORDER  (naranja)
 *   todo lo pedido ya está servido ................. SERVED         (verde)
 *   sesión abierta y aún sin pedir ................. OCCUPIED       (azul)
 *
 * Llamar siempre dentro de la transacción que provocó el cambio.
 */
export async function refreshTableStatus(db: Db, tableId: string): Promise<void> {
  await db.query(
    `WITH s AS (
       SELECT id FROM table_sessions WHERE table_id = $1 AND closed_at IS NULL
     ), calc AS (
       SELECT (CASE
         WHEN NOT EXISTS (SELECT 1 FROM s) THEN 'FREE'
         WHEN EXISTS (SELECT 1 FROM waiter_calls c JOIN s ON s.id = c.session_id WHERE c.attended_at IS NULL) THEN 'CALLING'
         WHEN EXISTS (SELECT 1 FROM orders o JOIN s ON s.id = o.session_id
                       WHERE o.status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY')) THEN 'WAITING_ORDER'
         WHEN EXISTS (SELECT 1 FROM orders o JOIN s ON s.id = o.session_id WHERE o.status = 'SERVED') THEN 'SERVED'
         ELSE 'OCCUPIED'
       END)::table_status AS status
     )
     UPDATE restaurant_tables t
        SET status = calc.status,
            status_changed_at = CASE WHEN t.status = calc.status THEN t.status_changed_at ELSE now() END
       FROM calc
      WHERE t.id = $1`,
    [tableId],
  );
}

/** Envía a sala el estado actual de la mesa (después del COMMIT). */
export async function publishTable(restaurantId: string, tableId: string): Promise<TableDto> {
  const table = await getTable(restaurantId, tableId);
  emit(rooms.staff(restaurantId), 'table:updated', table);
  return table;
}

/**
 * El camarero abre la mesa: nace la sesión y, con ella, la posibilidad de
 * pedir desde el QR. Los clientes que estaban en la pantalla de espera
 * reciben table:opened y entran sin recargar.
 */
export async function openTable(staff: StaffClaims, tableId: string): Promise<TableDto> {
  await tx(async (db) => {
    const table = await queryOne(
      'SELECT id FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2 AND is_active FOR UPDATE',
      [tableId, staff.rid],
      db,
    );
    if (!table) throw notFound('Mesa no encontrada');

    const open = await queryOne('SELECT id FROM table_sessions WHERE table_id = $1 AND closed_at IS NULL', [tableId], db);
    if (open) throw conflict('La mesa ya está abierta', 'TABLE_ALREADY_OPEN');

    await db.query('INSERT INTO table_sessions (restaurant_id, table_id, opened_by) VALUES ($1, $2, $3)', [staff.rid, tableId, staff.sub]);
    await refreshTableStatus(db, tableId);
  });

  emit(rooms.lobby(tableId), 'table:opened');
  return publishTable(staff.rid, tableId);
}

/**
 * Cierra una mesa que no llegó a consumir (se abrió por error o los clientes
 * se fueron). Si hay comandas vivas, la base de datos lo rechaza: esa mesa
 * solo se cierra cobrando.
 */
export async function cancelOpenTable(staff: StaffClaims, tableId: string): Promise<TableDto> {
  const sessionId = await tx(async (db) => {
    const session = await queryOne<{ id: string }>(
      'SELECT id FROM table_sessions WHERE table_id = $1 AND restaurant_id = $2 AND closed_at IS NULL FOR UPDATE',
      [tableId, staff.rid],
      db,
    );
    if (!session) throw conflict('La mesa no está abierta', 'TABLE_NOT_OPEN');

    const live = await queryOne(`SELECT 1 FROM orders WHERE session_id = $1 AND status <> 'CANCELLED' LIMIT 1`, [session.id], db);
    if (live) throw conflict('Esta mesa ya tiene comandas: se cierra cobrando la cuenta', 'TABLE_HAS_ORDERS');

    await db.query('DELETE FROM cart_items WHERE session_id = $1', [session.id]);
    await db.query('UPDATE waiter_calls SET attended_at = now(), attended_by = $2 WHERE session_id = $1 AND attended_at IS NULL', [session.id, staff.sub]);
    await db.query(`UPDATE table_sessions SET closed_at = now(), closed_by = $2, close_reason = 'CANCELLED' WHERE id = $1`, [session.id, staff.sub]);
    await refreshTableStatus(db, tableId);
    return session.id;
  });

  emit(rooms.session(sessionId), 'session:closed', { reason: 'CANCELLED' });
  return publishTable(staff.rid, tableId);
}

/** El cliente llama al camarero o pide la cuenta: la mesa pasa a rojo. */
export async function createCall(guest: GuestClaims, type: 'WAITER' | 'BILL'): Promise<void> {
  const created = await tx(async (db) => {
    const existing = await queryOne(
      'SELECT 1 FROM waiter_calls WHERE session_id = $1 AND type = $2 AND attended_at IS NULL',
      [guest.sid, type],
      db,
    );
    if (existing) return false; // ya hay un llamado igual en curso: no se duplica

    await db.query(
      'INSERT INTO waiter_calls (restaurant_id, table_id, session_id, guest_alias, type) VALUES ($1, $2, $3, $4, $5)',
      [guest.rid, guest.tid, guest.sid, guest.alias, type],
    );
    await refreshTableStatus(db, guest.tid);
    return true;
  });

  if (!created) return;
  const table = await publishTable(guest.rid, guest.tid);
  emit(rooms.staff(guest.rid), 'call:created', { tableId: table.id, tableNumber: table.number, type, guestAlias: guest.alias });
  emit(rooms.session(guest.sid), 'call:created', { type, guestAlias: guest.alias });
}

/** El camarero atiende todos los llamados abiertos de la mesa. */
export async function attendCalls(staff: StaffClaims, tableId: string): Promise<TableDto> {
  const sessionIds = await tx(async (db) => {
    const rows = await query<{ session_id: string }>(
      `UPDATE waiter_calls SET attended_at = now(), attended_by = $3
        WHERE table_id = $1 AND restaurant_id = $2 AND attended_at IS NULL
        RETURNING session_id`,
      [tableId, staff.rid, staff.sub],
      db,
    );
    await refreshTableStatus(db, tableId);
    return [...new Set(rows.map((r) => r.session_id))];
  });

  for (const sessionId of sessionIds) emit(rooms.session(sessionId), 'call:attended', { by: staff.name });
  return publishTable(staff.rid, tableId);
}

/** Marca como vistos los avisos de comensales tardíos de la mesa (dentro de una transacción). */
export async function acknowledgeLateGuests(db: Db, tableId: string, staffId: string): Promise<void> {
  await db.query(
    `UPDATE session_guests g SET late_ack_at = now(), late_ack_by = $2
       FROM table_sessions s
      WHERE s.id = g.session_id AND s.table_id = $1 AND s.closed_at IS NULL AND g.joined_late AND g.late_ack_at IS NULL`,
    [tableId, staffId],
  );
}

/** El camarero toca "Entendido" en el aviso de comensal tardío. */
export async function ackLateGuests(staff: StaffClaims, tableId: string): Promise<TableDto> {
  await getTable(staff.rid, tableId); // verifica que la mesa sea de este restaurante
  await acknowledgeLateGuests(pool, tableId, staff.sub);
  return publishTable(staff.rid, tableId);
}
