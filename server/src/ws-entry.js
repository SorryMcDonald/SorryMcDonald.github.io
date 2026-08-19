import { buildApp } from './index.js';

const app = await buildApp({ attachGateway: true });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
