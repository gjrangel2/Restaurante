import type { StaffClaims } from '../auth/tokens.js';
import { query, queryOne, tx } from '../db/pool.js';
import { notFound } from '../http.js';
import { emit, rooms } from '../realtime/bus.js';

export interface InventoryItemDto {
  id: string;
  name: string;
  unit: 'g' | 'ml' | 'und';
  stock: number;
  reorderLevel: number;
  avgDailyUsage: number; // rotación: consumo medio diario de los últimos 7 días
  daysOfCover: number | null; // para cuántos días alcanza a ese ritmo
  alertLevel: 'RED' | 'YELLOW' | 'OK';
  affectedProducts: string[]; // platos que dependen de este insumo
}

/** Inventario completo, con lo urgente primero. La lógica de alerta vive en la vista v_inventory_status. */
export function listInventory(restaurantId: string): Promise<InventoryItemDto[]> {
  return query<InventoryItemDto>(
    `SELECT v.id, v.name, v.unit, v.stock, v.reorder_level AS "reorderLevel",
            v.avg_daily_usage AS "avgDailyUsage", v.days_of_cover AS "daysOfCover", v.alert_level AS "alertLevel",
            COALESCE((SELECT array_agg(p.name ORDER BY p.name)
                        FROM product_ingredients pi JOIN products p ON p.id = pi.product_id
                       WHERE pi.inventory_item_id = v.id AND p.deleted_at IS NULL), '{}') AS "affectedProducts"
       FROM v_inventory_status v
      WHERE v.restaurant_id = $1
      ORDER BY CASE v.alert_level WHEN 'RED' THEN 0 WHEN 'YELLOW' THEN 1 ELSE 2 END, v.days_of_cover NULLS LAST, v.name`,
    [restaurantId],
  );
}

export async function listAlerts(restaurantId: string): Promise<InventoryItemDto[]> {
  return (await listInventory(restaurantId)).filter((item) => item.alertLevel !== 'OK');
}

/** Tras cada venta, cocina y gerencia reciben la lista de insumos en amarillo o rojo. */
export async function publishInventoryAlerts(restaurantId: string): Promise<void> {
  const alerts = await listAlerts(restaurantId);
  emit([rooms.kitchen(restaurantId), rooms.staff(restaurantId)], 'inventory:alert', alerts);
}

/** Entrada de mercancía (o ajuste): mueve el stock y deja el movimiento en el kardex. */
export async function restock(staff: StaffClaims, itemId: string, quantity: number, note?: string): Promise<void> {
  await tx(async (db) => {
    const item = await queryOne('SELECT id FROM inventory_items WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [itemId, staff.rid], db);
    if (!item) throw notFound('Insumo no encontrado');

    await db.query('UPDATE inventory_items SET stock = stock + $2 WHERE id = $1', [itemId, quantity]);
    await db.query(
      `INSERT INTO inventory_movements (restaurant_id, inventory_item_id, type, quantity, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [staff.rid, itemId, quantity > 0 ? 'PURCHASE' : 'ADJUSTMENT', quantity, note ?? null, staff.sub],
    );
  });
  await publishInventoryAlerts(staff.rid);
}
