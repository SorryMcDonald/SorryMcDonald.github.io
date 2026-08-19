import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { createProductionRuntime } from './runtime.js';

export { buildApp } from './app.js';

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  const runtime = await createProductionRuntime();
  const shutdown = async () => { await runtime.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await runtime.app.listen({ host: runtime.config.host, port: runtime.config.port });
}
