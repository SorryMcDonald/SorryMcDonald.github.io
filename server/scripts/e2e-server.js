import { buildApp } from '../src/app.js';

const port = Number(process.env.E2E_PORT ?? 3199);
const app = await buildApp({ logger: false, attachGateway: true });
await app.listen({ host: '127.0.0.1', port });

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
