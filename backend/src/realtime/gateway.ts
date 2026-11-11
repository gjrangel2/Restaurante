import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { isSessionOpen } from '../auth/middleware.js';
import { verifyToken, type Claims, type GuestClaims } from '../auth/tokens.js';
import { config } from '../config.js';
import { queryOne } from '../db/pool.js';
import { HttpError, parse } from '../http.js';
import { addToCart, getCart, setCartQuantity } from '../modules/cart.service.js';
import { publishGuests } from '../modules/guests.service.js';
import { getPublicRestaurant } from '../modules/restaurant.js';
import { rooms, setIo } from './bus.js';

type Ack = (response: { ok: true } | { ok: false; error: { code: string; message: string } }) => void;

const addSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(20).default(1),
  notes: z.string().trim().max(200).default(''),
});
const setQuantitySchema = z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(0).max(50) });

/**
 * Tres formas de conectarse:
 *   · Personal  → auth.token = JWT del login. Entra a las salas de su rol.
 *   · Cliente   → auth.token = token de sesión de mesa. Entra a la sala de su
 *                 mesa y puede editar el carrito compartido.
 *   · En espera → auth.lobbyTable = número de mesa. Sin token ni permisos:
 *                 solo escucha el aviso de que el camarero abrió la mesa.
 */
export function initRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') },
  });
  setIo(io);

  io.use(async (socket, next) => {
    try {
      const { token, lobbyTable } = socket.handshake.auth as { token?: string; lobbyTable?: number };

      if (token) {
        const claims = verifyToken(token);
        if (!claims) return next(new Error('UNAUTHORIZED'));
        if (claims.kind === 'guest' && !(await isSessionOpen(claims.sid))) return next(new Error('SESSION_CLOSED'));
        socket.data.claims = claims;
        return next();
      }

      if (lobbyTable !== undefined) {
        const restaurant = await getPublicRestaurant();
        const table = await queryOne<{ id: string }>(
          'SELECT id FROM restaurant_tables WHERE restaurant_id = $1 AND number = $2 AND is_active',
          [restaurant.id, Number(lobbyTable) || 0],
        );
        if (!table) return next(new Error('TABLE_NOT_FOUND'));
        socket.data.lobbyTableId = table.id;
        return next();
      }

      next(new Error('UNAUTHORIZED'));
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    const claims = socket.data.claims as Claims | undefined;

    if (!claims) {
      void socket.join(rooms.lobby(socket.data.lobbyTableId));
      return;
    }

    void socket.join(rooms.menu(claims.rid));

    if (claims.kind === 'staff') {
      if (claims.role !== 'KITCHEN') void socket.join(rooms.staff(claims.rid));
      if (claims.role !== 'WAITER') void socket.join(rooms.kitchen(claims.rid));
      return;
    }

    registerGuest(socket, claims);
  });

  return io;
}

function registerGuest(socket: Socket, guest: GuestClaims): void {
  void socket.join(rooms.session(guest.sid));
  void publishGuests(guest.sid);
  socket.on('disconnect', () => void publishGuests(guest.sid));

  // Freno simple contra ráfagas: máx. 30 cambios de carrito cada 10 s por dispositivo.
  let windowStart = Date.now();
  let count = 0;

  /** Envuelve cada evento del carrito: límite de ritmo, sesión abierta, validación y respuesta (ack). */
  const handle = (handler: (payload: unknown) => Promise<void>) => async (payload: unknown, ack?: Ack) => {
    try {
      if (Date.now() - windowStart > 10_000) {
        windowStart = Date.now();
        count = 0;
      }
      if (++count > 30) throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Vas muy rápido. Espera unos segundos.');
      // El token pudo ser válido al conectar y la mesa cerrarse después.
      if (!(await isSessionOpen(guest.sid))) throw new HttpError(410, 'SESSION_CLOSED', 'La mesa está cerrada');
      await handler(payload);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      const error =
        err instanceof HttpError ? { code: err.code, message: err.message } : { code: 'INTERNAL', message: 'No se pudo actualizar el pedido' };
      if (!(err instanceof HttpError)) console.error('[ws] error en evento de carrito:', err);
      if (typeof ack === 'function') ack({ ok: false, error });
    }
  };

  // Los servicios difunden cart:updated a toda la mesa tras cada cambio.
  socket.on(
    'cart:add',
    handle(async (payload) => {
      const { productId, quantity, notes } = parse(addSchema, payload);
      await addToCart(guest, productId, quantity, notes);
    }),
  );

  socket.on(
    'cart:setQuantity',
    handle(async (payload) => {
      const { itemId, quantity } = parse(setQuantitySchema, payload);
      await setCartQuantity(guest, itemId, quantity);
    }),
  );

  // Al (re)conectar, el cliente pide el carrito actual solo para él.
  socket.on(
    'cart:sync',
    handle(async () => {
      socket.emit('cart:updated', { cart: await getCart(guest.sid) });
    }),
  );
}
