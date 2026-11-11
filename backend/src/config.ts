import path from 'node:path';

const env = process.env;
const clean = (value: string | undefined) => (value && value.trim() !== '' ? value.trim() : undefined);

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://frictionless:frictionless@localhost:5432/frictionless',
  // Firma los tokens del personal y los tokens de sesión de mesa. Cámbialo en producción.
  jwtSecret: env.JWT_SECRET ?? 'solo-para-desarrollo-cambia-este-secreto',
  staffTokenTtl: '12h',
  guestTokenTtl: '8h',
  // Mientras no haya resolución por subdominio, las rutas públicas (/mesa/12, /domicilios) usan este restaurante.
  defaultRestaurantSlug: env.DEFAULT_RESTAURANT_SLUG ?? 'fogon',
  migrationsDir: env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), '../db/migrations'),
  runMigrations: (env.RUN_MIGRATIONS ?? 'true') !== 'false',
  corsOrigin: env.CORS_ORIGIN ?? '*',

  /**
   * Dirección pública con la que los clientes y las pasarelas llegan a la app
   * (https://pedidos.turestaurante.com). Sin ella, se usa la dirección con la
   * que se abrió la página, lo que basta para probar en local; los webhooks
   * de las pasarelas sí necesitan una dirección pública HTTPS.
   */
  publicBaseUrl: clean(env.PUBLIC_BASE_URL)?.replace(/\/+$/, ''),

  // Mapa: cualquier servidor de teselas compatible con Leaflet.
  map: {
    tileUrl: clean(env.MAP_TILE_URL) ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: clean(env.MAP_ATTRIBUTION) ?? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },

  /**
   * Pasarelas de pago. Cada una funciona "en vivo" solo si sus credenciales
   * están configuradas; si no, el cliente pasa por la pasarela de pruebas
   * (no se cobra dinero real). PAYMENTS_FORCE_TEST=true fuerza las pruebas
   * aunque haya credenciales.
   */
  payments: {
    forceTest: env.PAYMENTS_FORCE_TEST === 'true',
    intentTtlMinutes: 15,
    wompi: {
      publicKey: clean(env.WOMPI_PUBLIC_KEY),
      integritySecret: clean(env.WOMPI_INTEGRITY_SECRET),
      eventsSecret: clean(env.WOMPI_EVENTS_SECRET),
    },
    mercadoPago: {
      accessToken: clean(env.MP_ACCESS_TOKEN),
      webhookSecret: clean(env.MP_WEBHOOK_SECRET),
    },
    // PSE se cobra a través de una de las dos pasarelas.
    pseProvider: (env.PSE_PROVIDER ?? 'WOMPI').toUpperCase() === 'MERCADOPAGO' ? ('MERCADOPAGO' as const) : ('WOMPI' as const),
  },
} as const;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET no está definido: se usa el secreto de desarrollo. Defínelo antes de salir a producción.');
}
