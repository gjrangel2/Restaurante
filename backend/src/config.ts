import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://frictionless:frictionless@localhost:5432/frictionless',
  // Firma los tokens del personal y los tokens de sesión de mesa. Cámbialo en producción.
  jwtSecret: env.JWT_SECRET ?? 'solo-para-desarrollo-cambia-este-secreto',
  staffTokenTtl: '12h',
  guestTokenTtl: '8h',
  // Mientras no haya resolución por subdominio, las rutas públicas (/mesa/12) usan este restaurante.
  defaultRestaurantSlug: env.DEFAULT_RESTAURANT_SLUG ?? 'fogon',
  migrationsDir: env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), '../db/migrations'),
  runMigrations: (env.RUN_MIGRATIONS ?? 'true') !== 'false',
  corsOrigin: env.CORS_ORIGIN ?? '*',
} as const;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET no está definido: se usa el secreto de desarrollo. Defínelo antes de salir a producción.');
}
