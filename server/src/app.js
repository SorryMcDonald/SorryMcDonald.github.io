import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerRoomRoutes } from './rooms/routes.js';
import { registerLeaderboardRoutes } from './leaderboard/routes.js';
import { WebSocketGateway } from './ws/gateway.js';
import { registerTexasRoutes } from './texas/routes.js';
import { TexasLifecycleController } from './texas/lifecycle.js';
import { registerTournamentRoutes } from './tournaments/routes.js';
import { registerDoudizhuRoutes } from './doudizhu/routes.js';

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
  registerTexasRoutes(app, {
    service: options.texasService,
    store: options.store ?? app.auth.store,
    persistence: options.texasPersistence,
    mutationQueue: app.lifecycle.mutationQueue
  });
  registerDoudizhuRoutes(app, {
    service: options.doudizhuService,
    store: options.store ?? app.auth.store,
    persistence: options.doudizhuPersistence,
    mutationQueue: app.lifecycle.mutationQueue
  });

  const texasLifecycle = options.texasLifecycle ?? new TexasLifecycleController({
    service: app.texas,
    persistence: options.texasPersistence,
    mutationQueue: app.lifecycle.mutationQueue
  });
  app.decorate('texasLifecycle', texasLifecycle);
  // Keep the lifecycle and service timeout settings aligned.
  app.texas.autoTimeout = texasLifecycle.autoTimeout;
  app.rooms.autoTimeout = app.lifecycle.autoTimeout;
  for (const room of app.rooms.rooms.values()) room.autoTimeout = app.lifecycle.autoTimeout;

  registerTournamentRoutes(app, {
    service:options.tournamentService,
    store:options.store ?? app.auth.store,
    persistence:options.tournamentPersistence,
    roomPersistence:options.persistence,
    texasPersistence:options.texasPersistence,
    clock:options.tournamentClock
  });
  app.lifecycle.onRoomMutation = (roomId) => app.reconcileTournamentRoom('zhajinhua', roomId);
  app.texasLifecycle.onRoomMutation = (roomId) => app.reconcileTournamentRoom('texas', roomId);

  if (options.attachGateway) {
    const gateway = new WebSocketGateway({
      service: app.rooms,
      services: { zhajinhua:app.rooms, texas:app.texas },
      store: options.store ?? app.auth.store,
      findSession: app.auth.findSession,
      lifecycle: app.lifecycle,
      texasLifecycle
    });
    gateway.attach(app.server);
    app.decorate('gateway', gateway);
    app.lifecycle.setBroadcasters({
      room: (roomId, event) => gateway.broadcastRoom(roomId, event),
      global: (banner) => gateway.broadcastGlobal(banner),
      reclaim: (roomId) => gateway.closeRoom(roomId)
    });
    app.texasLifecycle.broadcastRoom = (roomId, event) => gateway.broadcastRoom(roomId, event, 'texas');
    app.texasLifecycle.reclaimRoomSockets = (roomId) => gateway.closeRoom(roomId, 'texas');
    app.addHook('onClose', async () => gateway.close());
  }

  app.lifecycle.restoreAll();
  app.addHook('onClose', async () => app.lifecycle.close());
  app.texasLifecycle.restoreAll();
  app.addHook('onClose', async () => app.texasLifecycle.close());

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
