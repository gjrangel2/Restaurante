import type { GuestClaims } from '../auth/tokens.js';
import { pool, query, queryOne, type Db } from '../db/pool.js';
import { conflict, notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';

/**
 * Carrito colaborativo. Vive en la base de datos y pertenece a la sesión de
 * mesa: todos los comensales ven y editan el mismo. Tras cada cambio se
 * difunde el carrito COMPLETO (no un parche): con pocos ítems por mesa es
 * barato, y un cliente que se reconecta queda al día con un solo mensaje.
 */
export interface CartLine {
  id: string;
  productId: string;
  name: string;
  unitPrice: number;
  imageUrl: string | null;
  quantity: number;
  notes: string;
  isAvailable: boolean;
  guest: { id: string; number: number; alias: string; color: string };
}

export interface CartSnapshot {
  items: CartLine[];
  totalQuantity: number;
  subtotal: number;
}

/** Quién hizo el último cambio, para el aviso "Cliente #2 agregó Pizza pepperoni". */
export interface CartChange {
  by: { id: string; alias: string };
  action: 'added' | 'updated' | 'removed' | 'ordered';
  productName?: string;
}

export async function getCart(sessionId: string, db: Db = pool): Promise<CartSnapshot> {
  const items = await query<CartLine>(
    `SELECT ci.id, ci.product_id AS "productId", p.name, p.price AS "unitPrice", p.image_url AS "imageUrl",
            ci.quantity, ci.notes, (p.is_available AND p.deleted_at IS NULL) AS "isAvailable",
            json_build_object('id', g.id, 'number', g.number, 'alias', g.alias, 'color', g.color) AS guest
       FROM cart_items ci
       JOIN products p       ON p.id = ci.product_id
       JOIN session_guests g ON g.id = ci.guest_id
      WHERE ci.session_id = $1
      ORDER BY ci.created_at, ci.id`,
    [sessionId],
    db,
  );
  return {
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
  };
}

export async function publishCart(sessionId: string, change?: CartChange): Promise<CartSnapshot> {
  const cart = await getCart(sessionId);
  emit(rooms.session(sessionId), 'cart:updated', { cart, change });
  return cart;
}

const who = (guest: GuestClaims) => ({ id: guest.sub, alias: guest.alias });

export async function addToCart(guest: GuestClaims, productId: string, quantity: number, notes: string): Promise<CartSnapshot> {
  const product = await queryOne<{ name: string; is_available: boolean }>(
    'SELECT name, is_available FROM products WHERE id = $1 AND restaurant_id = $2 AND deleted_at IS NULL',
    [productId, guest.rid],
  );
  if (!product) throw notFound('Ese plato ya no está en la carta');
  if (!product.is_available) throw conflict(`${product.name} se agotó`, 'PRODUCT_UNAVAILABLE');

  // Mismo plato, misma persona, misma nota → se suma a la línea existente.
  await pool.query(
    `INSERT INTO cart_items (session_id, guest_id, product_id, quantity, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, guest_id, product_id, notes)
     DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 50)`,
    [guest.sid, guest.sub, productId, quantity, notes],
  );
  return publishCart(guest.sid, { by: who(guest), action: 'added', productName: product.name });
}

/** Cambia la cantidad de una línea; 0 la elimina. Cualquier comensal de la mesa puede hacerlo. */
export async function setCartQuantity(guest: GuestClaims, itemId: string, quantity: number): Promise<CartSnapshot> {
  const line = await queryOne<{ name: string }>(
    `SELECT p.name FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = $1 AND ci.session_id = $2`,
    [itemId, guest.sid],
  );
  if (!line) return publishCart(guest.sid); // alguien más la quitó primero: solo se resincroniza

  if (quantity <= 0) {
    await pool.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2', [itemId, guest.sid]);
    return publishCart(guest.sid, { by: who(guest), action: 'removed', productName: line.name });
  }
  await pool.query('UPDATE cart_items SET quantity = $3 WHERE id = $1 AND session_id = $2', [itemId, guest.sid, Math.min(quantity, 50)]);
  return publishCart(guest.sid, { by: who(guest), action: 'updated', productName: line.name });
}
