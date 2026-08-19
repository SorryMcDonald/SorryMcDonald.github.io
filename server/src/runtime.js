import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDbPool } from './db/pool.js';
import { RoomService } from './rooms/service.js';
import { createPersistence, hydrateStore } from './persistence/runtime-state.js';

export async function createProductionRuntime(options = {}) {
  const env = options.env ?? process.env;
  const runtimeConfig = loadConfig(env);
  if (!options.db && !runtimeConfig.databaseUrl) {
    throw new Error('DATABASE_URL is required for the production runtime');
  }

  const db = options.db ?? createDbPool({ connectionString: runtimeConfig.databaseUrl });
  await db.query('SELECT 1');
  const store = await hydrateStore(db);
  const roomService = new RoomService({ store });
  const persistence = createPersistence({ db, store, roomService });
  await persistence.hydrateRooms();
  const app = await buildApp({
    db,
    store,
    roomService,
    persistence,
    attachGateway: true,
    secureCookies: env.NODE_ENV === 'production',
    logger: runtimeConfig.logger
  });

  let closed = false;
  return {
    app,
    db,
    store,
    roomService,
    persistence,
    config: runtimeConfig,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await db.end?.();
    }
  };
}
