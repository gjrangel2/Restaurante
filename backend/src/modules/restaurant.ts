import { config } from '../config.js';
import { queryOne } from '../db/pool.js';
import { notFound } from '../http.js';

export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  timezone: string;
  currency: string;
  taxName: string;
  taxRate: number;
  pricesIncludeTax: boolean;
  suggestedTipRate: number;
  invoicePrefix: string;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryMinOrder: number;
  deliveryPrepMinutes: number;
}

const SELECT = `
  SELECT id, slug, name, legal_name AS "legalName", tax_id AS "taxId", timezone, currency,
         tax_name AS "taxName", tax_rate AS "taxRate", prices_include_tax AS "pricesIncludeTax",
         suggested_tip_rate AS "suggestedTipRate", invoice_prefix AS "invoicePrefix",
         address, phone, lat, lng, delivery_enabled AS "deliveryEnabled", pickup_enabled AS "pickupEnabled",
         delivery_min_order AS "deliveryMinOrder", delivery_prep_minutes AS "deliveryPrepMinutes"
    FROM restaurants`;

export async function getRestaurant(id: string): Promise<Restaurant> {
  const restaurant = await queryOne<Restaurant>(`${SELECT} WHERE id = $1`, [id]);
  if (!restaurant) throw notFound('Restaurante no encontrado');
  return restaurant;
}

/**
 * Resolución de tenant para las rutas públicas. Hoy: un restaurante por
 * despliegue (DEFAULT_RESTAURANT_SLUG). En el SaaS multi-restaurante, este es
 * el único punto que cambia: resolver por subdominio (fogon.tudominio.com).
 * Lo usan la mesa (/mesa/12), los domicilios (/domicilios) y los webhooks de pago.
 */
export async function getPublicRestaurant(): Promise<Restaurant> {
  const restaurant = await queryOne<Restaurant>(`${SELECT} WHERE slug = $1`, [config.defaultRestaurantSlug]);
  if (!restaurant) throw notFound(`No existe el restaurante "${config.defaultRestaurantSlug}"`);
  return restaurant;
}

/** Lo que la app del cliente necesita saber del restaurante. */
export function publicRestaurant(r: Restaurant) {
  return {
    name: r.name,
    currency: r.currency,
    taxName: r.taxName,
    taxRate: r.taxRate,
    pricesIncludeTax: r.pricesIncludeTax,
    suggestedTipRate: r.suggestedTipRate,
  };
}
