import { RoomService } from './service.js';

function broadcastRoomChanges(app, service, roomId, afterEventId) {
  const gateway = app.gateway;
  if (!gateway) return;
  const room = service.room(roomId);
  for (const event of room.events.filter((entry) => entry.id > afterEventId)) gateway.broadcastRoom(room.id, event);
}

function broadcastNewBanners(app, store, afterCount) {
  const gateway = app.gateway;
  if (!gateway) return;
  for (const banner of (store?.banners ?? []).slice(afterCount)) gateway.broadcastGlobal(banner);
}

export function registerRoomRoutes(app, options = {}) {
  const service = options.service ?? new RoomService({ store: options.store ?? app.auth?.store });
  const persistence = options.persistence;
  app.decorate('rooms', service);
  const requireUser = async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); };
  app.get('/api/rooms', { preHandler: requireUser }, async () => ({ rooms: service.listRooms() }));
  app.post('/api/rooms', { preHandler: requireUser }, async (request) => { const room = service.createRoom(request.user.id, request.body ?? {}); await persistence?.flushRoom(room.id); return { room: service.snapshot(room.id, request.user.id) }; });
  app.post('/api/rooms/:roomId/join', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; service.joinRoom(request.params.roomId, request.user.id, request.body?.seat); await persistence?.flushRoom(room.id); broadcastRoomChanges(app, service, room.id, afterEventId); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.get('/api/rooms/:roomId', { preHandler: requireUser }, async (request) => ({ room: service.snapshot(request.params.roomId, request.user.id) }));
  app.post('/api/rooms/:roomId/actions', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; const afterBannerCount = service.store?.banners?.length ?? 0; service.action(request.params.roomId, request.user.id, request.body ?? {}); await persistence?.flushRoom(room.id, afterBannerCount); broadcastRoomChanges(app, service, room.id, afterEventId); broadcastNewBanners(app, service.store, afterBannerCount); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/start-next', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; service.startNextRound(request.params.roomId, request.user.id); await persistence?.flushRoom(room.id); broadcastRoomChanges(app, service, room.id, afterEventId); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/leave', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; service.leaveRoom(request.params.roomId, request.user.id); await persistence?.flushRoom(room.id); broadcastRoomChanges(app, service, room.id, afterEventId); return { ok: true }; });
  app.post('/api/rooms/:roomId/spectate', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; service.setSpectating(request.params.roomId, request.user.id, request.body?.enabled ?? true); await persistence?.flushRoom(room.id); broadcastRoomChanges(app, service, room.id, afterEventId); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/observe', { preHandler: requireUser }, async (request) => { const room = service.room(request.params.roomId); const afterEventId = room.eventSeq; service.setAllowSpectators(request.params.roomId, request.user.id, request.body?.enabled); await persistence?.flushRoom(room.id); broadcastRoomChanges(app, service, room.id, afterEventId); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  return service;
}
