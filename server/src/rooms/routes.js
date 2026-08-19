import { RoomService } from './service.js';
import { RoomLifecycleController } from './lifecycle.js';

export function registerRoomRoutes(app, options = {}) {
  const service = options.service ?? new RoomService({ store: options.store ?? app.auth?.store });
  const persistence = options.persistence;
  const lifecycle = options.lifecycle ?? new RoomLifecycleController({ service, persistence });
  app.decorate('rooms', service);
  app.decorate('lifecycle', lifecycle);
  const requireUser = async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); };
  app.get('/api/rooms', { preHandler: requireUser }, async () => ({ rooms: service.listRooms() }));
  app.post('/api/rooms', { preHandler: requireUser }, async (request) => { const room = service.createRoom(request.user.id, request.body ?? {}); await persistence?.flushRoom(room.id); return { room: service.snapshot(room.id, request.user.id) }; });
  app.post('/api/rooms/:roomId/join', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.joinRoom(request.params.roomId, request.user.id, request.body?.seat)); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.get('/api/rooms/:roomId', { preHandler: requireUser }, async (request) => ({ room: service.snapshot(request.params.roomId, request.user.id) }));
  app.post('/api/rooms/:roomId/actions', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.action(request.params.roomId, request.user.id, request.body ?? {})); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/start-next', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.startNextRound(request.params.roomId, request.user.id)); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/leave', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.leaveRoom(request.params.roomId, request.user.id)); return { ok: true }; });
  app.post('/api/rooms/:roomId/spectate', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.setSpectating(request.params.roomId, request.user.id, request.body?.enabled ?? true)); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.post('/api/rooms/:roomId/observe', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.setAllowSpectators(request.params.roomId, request.user.id, request.body?.enabled)); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  return service;
}
