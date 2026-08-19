import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerRoomRoutes } from './rooms/routes.js';
import { registerLeaderboardRoutes } from './leaderboard/routes.js';
import { WebSocketGateway } from './ws/gateway.js';

export async function buildApp(options = {}) {
  const app = Fastify({ logger: options.logger ?? config.logger });

  if (options.serveStatic !== false) {
    app.register(fastifyStatic, { root: fileURLToPath(new URL('../../public', import.meta.url)), prefix: '/' });
  }

  if (options.db) app.decorate('db', options.db);

  registerAuthRoutes(app, { db: options.db, store: options.store, secureCookies: options.secureCookies });
  registerRoomRoutes(app, {
    service: options.roomService,
    store: options.store ?? app.auth.store,
    persistence: options.persistence
  });
  registerLeaderboardRoutes(app, {
    store: options.store ?? app.auth.store,
    persistence: options.persistence
  });

  if (options.attachGateway) {
    const gateway = new WebSocketGateway({
      service: app.rooms,
      store: options.store ?? app.auth.store,
      findSession: app.auth.findSession
    });
    gateway.attach(app.server);
    app.decorate('gateway', gateway);
  }

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
