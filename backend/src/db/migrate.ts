import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool } from './pool.js';

/**
 * Migrador mínimo compatible con la convención de nombres de Flyway
 * (V1__esquema.sql, V2__semilla.sql…). Aplica en orden los archivos que aún
 * no figuran en schema_migrations, cada uno en su propia transacción. Si un
 * archivo ya aplicado cambió, se detiene con un mensaje claro (como Flyway).
 * Si más adelante el backend pasa a Spring Boot, los mismos archivos sirven
 * para Flyway sin tocarlos.
 */
const FILE_PATTERN = /^V(\d+)__(.+)\.sql$/;

async function waitForDatabase(retries = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.log(`[db] esperando a PostgreSQL (intento ${attempt}/${retries})…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function migrate(): Promise<void> {
  await waitForDatabase();

  const client = await pool.connect();
  try {
    // Evita que dos réplicas del backend migren a la vez.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     int PRIMARY KEY,
        description text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Map<number, string>(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );

    const files = (await fs.readdir(config.migrationsDir))
      .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
      .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
      .map((f) => ({ name: f.name, version: Number(f.match[1]), description: f.match[2].replace(/_/g, ' ') }))
      .sort((a, b) => a.version - b.version);

    for (const file of files) {
      const sql = await fs.readFile(path.join(config.migrationsDir, file.name), 'utf8');
      // Los saltos de línea se normalizan antes de calcular la huella: un checkout
      // en Windows (CRLF) no cuenta como cambio.
      const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

      const previous = applied.get(file.version);
      if (previous) {
        // Igual que Flyway: una migración ya aplicada que cambia detiene el arranque,
        // porque la base de datos ya no corresponde a lo que dicen los archivos.
        if (previous !== checksum) {
          throw new Error(
            `${file.name} cambió después de haberse aplicado a esta base de datos. ` +
              'Las migraciones aplicadas no se editan: crea una versión nueva (V4__…). ' +
              'En desarrollo, si puedes perder los datos, recrea la base con "docker compose down -v" y vuelve a arrancar.',
          );
        }
        continue;
      }

      console.log(`[db] aplicando ${file.name}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, description, checksum) VALUES ($1, $2, $3)', [
          file.version,
          file.description,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`La migración ${file.name} falló: ${(err as Error).message}`);
      }
    }
    console.log(`[db] esquema al día (${files.length} migraciones)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
