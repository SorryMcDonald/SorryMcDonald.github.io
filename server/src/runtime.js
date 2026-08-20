import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDbPool } from './db/pool.js';
import { RoomService } from './rooms/service.js';
import { createPersistence, hydrateStore } from './persistence/runtime-state.js';
import { TexasService } from './texas/service.js';
import { createTexasPersistence } from './texas/persistence.js';
import { TournamentService } from './tournaments/service.js';
import { createTournamentPersistence } from './tournaments/persistence.js';
import { DoudizhuService } from './doudizhu/service.js';
import { createDoudizhuPersistence } from './doudizhu/persistence.js';

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
  const texasService = new TexasService({ store });
  const texasPersistence = createTexasPersistence({ db, service:texasService });
  await texasPersistence.hydrateRooms();
  const tournamentService = new TournamentService({ store, roomService, texasService });
  const tournamentPersistence = createTournamentPersistence({ db, service:tournamentService });
  await tournamentPersistence.hydrate();
  const doudizhuService = new DoudizhuService({ store });
  const doudizhuPersistence = createDoudizhuPersistence({ db, service:doudizhuService });
  await doudizhuPersistence.hydrateRooms();
  const app = await buildApp({
    db,
    store,
    roomService,
    persistence,
    texasService,
    texasPersistence,
    tournamentService,
    tournamentPersistence,
    doudizhuService,
    doudizhuPersistence,
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
    texasService,
    texasPersistence,
    tournamentService,
    tournamentPersistence,
    doudizhuService,
    doudizhuPersistence,
    config: runtimeConfig,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await db.end?.();
    }
  };
}
