import { createProductionRuntime } from './runtime.js';

const runtime = await createProductionRuntime();
let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.close();
  } catch (error) {
    console.error('Runtime shutdown failed', error);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await runtime.app.listen({ host: runtime.config.host, port: runtime.config.port });
