import { loadConfig } from './config.js';
import { createDbPool } from './db/pool.js';
import { GameWorker } from './game/worker.js';
import { cleanupTexasRooms } from './texas/cleanup.js';

const config = loadConfig();
const gameWorker = new GameWorker();
const db = config.databaseUrl ? createDbPool({ connectionString:config.databaseUrl }) : null;
const intervalMs = Math.max(60_000, Number(process.env.ROOM_CLEANUP_INTERVAL_MS) || 300_000);
const retentionHours = Math.max(24, Number(process.env.CLOSED_ROOM_RETENTION_HOURS) || 720);
let running = false;

async function runCleanup() {
  if (running || !db) return;
  running = true;
  try {
    const result = await cleanupTexasRooms(db,{ closedRetentionHours:retentionHours });
    if (result.closed || result.pruned) console.info('Texas room cleanup completed',result);
  } catch (error) {
    console.error('Texas room cleanup failed',error);
  } finally {
    running = false;
  }
}

if (db) await db.query('SELECT 1');
await runCleanup();
const timer = setInterval(runCleanup,intervalMs);
const shutdown = async() => { clearInterval(timer); gameWorker.stop(); await db?.end(); process.exit(0); };
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);
