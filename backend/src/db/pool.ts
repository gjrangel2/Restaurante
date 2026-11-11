import pg from 'pg';
import { config } from '../config.js';

// numeric y bigint llegan como texto por defecto; aquí los montos caben de sobra en un number.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Cualquier cosa que sepa ejecutar SQL: el pool o un cliente dentro de una transacción. */
export type Db = Pick<pg.PoolClient, 'query'>;

export async function query<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const result = await db.query(text, params as any[]);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

/** Ejecuta fn dentro de una transacción; hace ROLLBACK si fn lanza. */
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
