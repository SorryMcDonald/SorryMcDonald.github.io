import { GameWorker } from './game/worker.js';
const worker = new GameWorker();
process.on('SIGTERM', () => { worker.stop(); process.exit(0); });
setInterval(() => {}, 60_000);
