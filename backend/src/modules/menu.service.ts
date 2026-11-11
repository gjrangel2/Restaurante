import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { conflict, notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';

/**
 * Carta y banners. Cualquier cambio (CRUD del admin o "agotado" desde cocina)
 * termina en menuChanged(): los móviles de los clientes reciben menu:updated y
 * recargan la carta sin que nadie toque nada.
 */
export function menuChanged(restaurantId: string): void {
  emit(rooms.menu(restaurantId), 'menu:updated', { at: new Date().toISOString() });
}

const PRODUCT_COLUMNS = `
  p.id, p.category_id AS "categoryId", p.name, p.description, p.price, p.image_url AS "imageUrl",
  p.is_available AS "isAvailable", p.is_featured AS "isFeatured", p.prep_minutes AS "prepMinutes",
  p.tags, p.sort_order AS "sortOrder"`;

const PROMOTION_COLUMNS = `
  id, title, subtitle, image_url AS "imageUrl", product_id AS "productId",
  starts_at AS "startsAt", ends_at AS "endsAt", is_active AS "isActive"`;

/** Carta pública: categorías activas con sus platos, y banners vigentes o por empezar en las próximas 24 h. */
export async function getPublicMenu(restaurantId: string) {
  const [categories, products, promotions] = await Promise.all([
    query<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE restaurant_id = $1 AND is_active ORDER BY sort_order, name',
      [restaurantId],
    ),
    query<{ categoryId: string }>(
      `SELECT ${PRODUCT_COLUMNS} FROM products p
        WHERE p.restaurant_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.sort_order, p.name`,
      [restaurantId],
    ),
    // El cliente filtra con su reloj, así un banner programado aparece a su hora sin recargar.
    query(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions
        WHERE restaurant_id = $1 AND is_active AND ends_at > now() AND starts_at <= now() + interval '24 hours'
        ORDER BY starts_at`,
      [restaurantId],
    ),
  ]);

  return {
    categories: categories
      .map((category) => ({ ...category, products: products.filter((p) => p.categoryId === category.id) }))
      .filter((category) => category.products.length > 0),
    promotions,
  };
}

// ----------------------------------------------------------------------------
// Categorías (admin)
// ----------------------------------------------------------------------------
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export function listCategories(restaurantId: string) {
  return query(
    `SELECT c.id, c.name, c.sort_order AS "sortOrder", c.is_active AS "isActive",
            (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS "productCount"
       FROM categories c WHERE c.restaurant_id = $1 ORDER BY c.sort_order, c.name`,
    [restaurantId],
  );
}

export async function createCategory(restaurantId: string, input: CategoryInput) {
  const row = await queryOne(
    `INSERT INTO categories (restaurant_id, name, sort_order, is_active) VALUES ($1, $2, $3, $4)
     RETURNING id, name, sort_order AS "sortOrder", is_active AS "isActive"`,
    [restaurantId, input.name, input.sortOrder, input.isActive],
  );
  menuChanged(restaurantId);
  return row;
}

export async function updateCategory(restaurantId: string, id: string, input: CategoryInput) {
  const row = await queryOne(
    `UPDATE categories SET name = $3, sort_order = $4, is_active = $5 WHERE id = $2 AND restaurant_id = $1
     RETURNING id, name, sort_order AS "sortOrder", is_active AS "isActive"`,
    [restaurantId, id, input.name, input.sortOrder, input.isActive],
  );
  if (!row) throw notFound('Categoría no encontrada');
  menuChanged(restaurantId);
  return row;
}

export async function deleteCategory(restaurantId: string, id: string) {
  const inUse = await queryOne('SELECT 1 FROM products WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
  if (inUse) throw conflict('Mueve o elimina primero los platos de esta categoría', 'CATEGORY_IN_USE');
  // Si tuvo platos alguna vez (hoy eliminados), se desactiva en lugar de borrarse.
  const everUsed = await queryOne('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', [id]);
  const result = everUsed
    ? await query('UPDATE categories SET is_active = false WHERE id = $2 AND restaurant_id = $1 RETURNING id', [restaurantId, id])
    : await query('DELETE FROM categories WHERE id = $2 AND restaurant_id = $1 RETURNING id', [restaurantId, id]);
  if (result.length === 0) throw notFound('Categoría no encontrada');
  menuChanged(restaurantId);
}

// ----------------------------------------------------------------------------
// Platos (admin) y disponibilidad (admin + cocina)
// ----------------------------------------------------------------------------
export const productSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  price: z.number().min(0).max(100_000_000),
  imageUrl: z.string().trim().url().max(500).nullable().default(null),
  isAvailable: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  prepMinutes: z.number().int().min(0).max(240).default(15),
  tags: z.array(z.string().trim().min(1).max(30)).max(6).default([]),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type ProductInput = z.infer<typeof productSchema>;

export function listProducts(restaurantId: string) {
  return query(
    `SELECT ${PRODUCT_COLUMNS}, c.name AS "categoryName"
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.restaurant_id = $1 AND p.deleted_at IS NULL
      ORDER BY c.sort_order, p.sort_order, p.name`,
    [restaurantId],
  );
}

async function assertCategory(restaurantId: string, categoryId: string) {
  const category = await queryOne('SELECT 1 FROM categories WHERE id = $1 AND restaurant_id = $2', [categoryId, restaurantId]);
  if (!category) throw notFound('Categoría no encontrada');
}

export async function createProduct(restaurantId: string, input: ProductInput) {
  await assertCategory(restaurantId, input.categoryId);
  const row = await queryOne(
    `INSERT INTO products AS p (restaurant_id, category_id, name, description, price, image_url, is_available, is_featured, prep_minutes, tags, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${PRODUCT_COLUMNS}`,
    [restaurantId, input.categoryId, input.name, input.description, input.price, input.imageUrl, input.isAvailable, input.isFeatured, input.prepMinutes, input.tags, input.sortOrder],
  );
  menuChanged(restaurantId);
  return row;
}

export async function updateProduct(restaurantId: string, id: string, input: ProductInput) {
  await assertCategory(restaurantId, input.categoryId);
  const row = await queryOne(
    `UPDATE products AS p
        SET category_id = $3, name = $4, description = $5, price = $6, image_url = $7, is_available = $8,
            is_featured = $9, prep_minutes = $10, tags = $11, sort_order = $12
      WHERE p.id = $2 AND p.restaurant_id = $1 AND p.deleted_at IS NULL
      RETURNING ${PRODUCT_COLUMNS}`,
    [restaurantId, id, input.categoryId, input.name, input.description, input.price, input.imageUrl, input.isAvailable, input.isFeatured, input.prepMinutes, input.tags, input.sortOrder],
  );
  if (!row) throw notFound('Plato no encontrado');
  menuChanged(restaurantId);
  return row;
}

/** "86": marcar un plato como agotado o disponible. Lo usan cocina y gerencia. */
export async function setProductAvailability(restaurantId: string, id: string, isAvailable: boolean) {
  const row = await queryOne(
    `UPDATE products AS p SET is_available = $3
      WHERE p.id = $2 AND p.restaurant_id = $1 AND p.deleted_at IS NULL
      RETURNING ${PRODUCT_COLUMNS}`,
    [restaurantId, id, isAvailable],
  );
  if (!row) throw notFound('Plato no encontrado');
  menuChanged(restaurantId);
  return row;
}

/** Borrado lógico: las comandas y facturas históricas siguen apuntando al plato. */
export async function deleteProduct(restaurantId: string, id: string) {
  const rows = await query(
    'UPDATE products SET deleted_at = now(), is_available = false WHERE id = $2 AND restaurant_id = $1 AND deleted_at IS NULL RETURNING id',
    [restaurantId, id],
  );
  if (rows.length === 0) throw notFound('Plato no encontrado');
  await query('DELETE FROM cart_items WHERE product_id = $1', [id]);
  menuChanged(restaurantId);
}

// ----------------------------------------------------------------------------
// Banners promocionales (admin)
// ----------------------------------------------------------------------------
export const promotionSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(140).default(''),
    imageUrl: z.string().trim().url().max(500).nullable().default(null),
    productId: z.string().uuid().nullable().default(null),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    isActive: z.boolean().default(true),
  })
  .refine((p) => p.endsAt > p.startsAt, { message: 'La fecha de fin debe ser posterior a la de inicio', path: ['endsAt'] });
export type PromotionInput = z.infer<typeof promotionSchema>;

export function listPromotions(restaurantId: string) {
  return query(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE restaurant_id = $1 ORDER BY starts_at DESC`, [restaurantId]);
}

export async function createPromotion(restaurantId: string, input: PromotionInput) {
  const row = await queryOne(
    `INSERT INTO promotions (restaurant_id, title, subtitle, image_url, product_id, starts_at, ends_at, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PROMOTION_COLUMNS}`,
    [restaurantId, input.title, input.subtitle, input.imageUrl, input.productId, input.startsAt, input.endsAt, input.isActive],
  );
  menuChanged(restaurantId);
  return row;
}

export async function updatePromotion(restaurantId: string, id: string, input: PromotionInput) {
  const row = await queryOne(
    `UPDATE promotions SET title = $3, subtitle = $4, image_url = $5, product_id = $6, starts_at = $7, ends_at = $8, is_active = $9
      WHERE id = $2 AND restaurant_id = $1 RETURNING ${PROMOTION_COLUMNS}`,
    [restaurantId, id, input.title, input.subtitle, input.imageUrl, input.productId, input.startsAt, input.endsAt, input.isActive],
  );
  if (!row) throw notFound('Banner no encontrado');
  menuChanged(restaurantId);
  return row;
}

export async function deletePromotion(restaurantId: string, id: string) {
  const rows = await query('DELETE FROM promotions WHERE id = $2 AND restaurant_id = $1 RETURNING id', [restaurantId, id]);
  if (rows.length === 0) throw notFound('Banner no encontrado');
  menuChanged(restaurantId);
}
