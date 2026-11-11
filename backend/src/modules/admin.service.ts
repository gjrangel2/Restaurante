import { query, queryOne } from '../db/pool.js';
import { getRestaurant } from './restaurant.js';

/**
 * KPIs del dashboard. "Ventas" = consumo facturado con impuesto y sin propina
 * (la propina no es ingreso del restaurante). Todos los cortes de día usan la
 * zona horaria del restaurante, no la del servidor.
 */
export async function getKpis(restaurantId: string, days = 7) {
  const restaurant = await getRestaurant(restaurantId);
  const tz = restaurant.timezone;

  const [today, daily, products, floor] = await Promise.all([
    queryOne<{ salesToday: number; ticketsToday: number; salesYesterday: number; ticketsYesterday: number; salesYesterdaySameTime: number }>(
      `WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS today_start)
       SELECT COALESCE(SUM(i.grand_total - i.tip_total) FILTER (WHERE i.issued_at >= b.today_start), 0) AS "salesToday",
              count(*) FILTER (WHERE i.issued_at >= b.today_start)                                       AS "ticketsToday",
              COALESCE(SUM(i.grand_total - i.tip_total) FILTER (WHERE i.issued_at < b.today_start), 0)  AS "salesYesterday",
              count(*) FILTER (WHERE i.issued_at < b.today_start)                                        AS "ticketsYesterday",
              -- Para comparar un día a medias con justicia: lo vendido ayer hasta esta misma hora.
              COALESCE(SUM(i.grand_total - i.tip_total) FILTER (WHERE i.issued_at <= now() - interval '1 day'), 0) AS "salesYesterdaySameTime"
         FROM b
         LEFT JOIN invoices i ON i.restaurant_id = $1 AND i.status = 'ISSUED'
                             AND i.issued_at >= b.today_start - interval '1 day'`,
      [restaurantId, tz],
    ),
    query<{ day: string; sales: number; tickets: number }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(i.grand_total - i.tip_total), 0) AS sales,
              count(i.id) AS tickets
         FROM generate_series(date_trunc('day', now() AT TIME ZONE $2) - make_interval(days => $3 - 1),
                              date_trunc('day', now() AT TIME ZONE $2), interval '1 day') AS d(day)
         LEFT JOIN invoices i ON i.restaurant_id = $1 AND i.status = 'ISSUED'
                             AND i.issued_at >= d.day AT TIME ZONE $2
                             AND i.issued_at <  (d.day + interval '1 day') AT TIME ZONE $2
        GROUP BY d.day ORDER BY d.day`,
      [restaurantId, tz, days],
    ),
    // Unidades vendidas por plato en el periodo (incluye los que no vendieron nada).
    query<{ id: string; name: string; category: string; imageUrl: string | null; units: number; revenue: number }>(
      `SELECT p.id, p.name, c.name AS category, p.image_url AS "imageUrl",
              COALESCE(SUM(s.quantity), 0) AS units,
              COALESCE(SUM(s.quantity * s.unit_price), 0) AS revenue
         FROM products p
         JOIN categories c ON c.id = p.category_id
         LEFT JOIN (
           SELECT oi.product_id, oi.quantity, oi.unit_price
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.restaurant_id = $1 AND o.status <> 'CANCELLED' AND oi.status <> 'CANCELLED'
              AND o.created_at >= (date_trunc('day', now() AT TIME ZONE $2) - make_interval(days => $3 - 1)) AT TIME ZONE $2
         ) s ON s.product_id = p.id
        WHERE p.restaurant_id = $1 AND p.deleted_at IS NULL
        GROUP BY p.id, c.name
        ORDER BY units DESC, revenue DESC, p.name`,
      [restaurantId, tz, days],
    ),
    queryOne<{ openTables: number; totalTables: number; openAmount: number }>(
      `SELECT count(*) FILTER (WHERE t.status <> 'FREE') AS "openTables",
              count(*) AS "totalTables",
              COALESCE((SELECT SUM(oi.unit_price * oi.quantity)
                          FROM table_sessions s
                          JOIN orders o ON o.session_id = s.id AND o.status <> 'CANCELLED'
                          JOIN order_items oi ON oi.order_id = o.id AND oi.status <> 'CANCELLED'
                         WHERE s.restaurant_id = $1 AND s.closed_at IS NULL), 0) AS "openAmount"
         FROM restaurant_tables t WHERE t.restaurant_id = $1 AND t.is_active`,
      [restaurantId],
    ),
  ]);

  const t = today!;
  return {
    currency: restaurant.currency,
    periodDays: days,
    salesToday: t.salesToday,
    ticketsToday: t.ticketsToday,
    avgTicketToday: t.ticketsToday > 0 ? t.salesToday / t.ticketsToday : 0,
    salesYesterday: t.salesYesterday,
    salesYesterdaySameTime: t.salesYesterdaySameTime,
    avgTicketYesterday: t.ticketsYesterday > 0 ? t.salesYesterday / t.ticketsYesterday : 0,
    openTables: floor!.openTables,
    totalTables: floor!.totalTables,
    openAmount: floor!.openAmount, // consumo de las mesas abiertas, aún sin cobrar
    daily,
    topProducts: products.slice(0, 5),
    bottomProducts: products.slice(-5).reverse(),
  };
}
