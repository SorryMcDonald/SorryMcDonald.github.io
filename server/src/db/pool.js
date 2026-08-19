import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/** Create a pool without opening a connection until the first query. */
export function createDbPool(options = {}) {
  const connectionString = options.connectionString ?? options.databaseUrl ?? config.databaseUrl;
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...(options.ssl ? { ssl: options.ssl } : {})
  });
}

// In tests DATABASE_URL is normally absent, so importing the module has no side effects.
export const pool = createDbPool();

export async function closeDbPool(db = pool) {
  if (db && typeof db.end === 'function') await db.end();
}
