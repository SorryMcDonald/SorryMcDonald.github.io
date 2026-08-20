import { mutationQueueFor } from '../persistence/mutation-queue.js';
import { DoudizhuService } from './service.js';

export function registerDoudizhuRoutes(app, options = {}) {
  const service = options.service ?? new DoudizhuService({ store: options.store ?? app.auth?.store });
  const persistence = options.persistence;
  const queue = options.mutationQueue ?? mutationQueueFor(service.store);
  const requireUser = async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); };
  app.decorate('doudizhu', service);
  const mutate = (roomId, command) => queue.run(async () => { const room = service.room(roomId); command(room); await persistence?.flushRoom?.(room.id); return room; });

  app.get('/api/doudizhu/rooms', { preHandler: requireUser }, async () => ({ rooms: [...service.rooms.values()].filter((room) => room.status !== 'closed' && room.players.some((player) => !player.left)).map((room) => ({ id: room.id, code: room.code, status: room.status, maxPlayers: room.maxPlayers, baseScore: room.baseScore, playerCount: room.players.filter((player) => !player.left).length, hostNickname: service.store.users.get(room.hostUserId)?.nickname ?? '等待房主' })) }));
  app.post('/api/doudizhu/rooms', { preHandler: requireUser }, async (request) => queue.run(async () => { const room = service.createRoom(request.user.id, request.body ?? {}); await persistence?.flushRoom?.(room.id); return { room: service.snapshot(room.id, request.user.id) }; }));
  app.get('/api/doudizhu/rooms/:roomId', { preHandler: requireUser }, async (request) => queue.run(async () => { const room = service.autoProgress(request.params.roomId); await persistence?.flushRoom?.(room.id); return { room: service.snapshot(room.id, request.user.id) }; }));
  app.post('/api/doudizhu/rooms/:roomId/join', { preHandler: requireUser }, async (request) => queue.run(async () => { const room = service.joinRoom(request.params.roomId, request.user.id); await persistence?.flushRoom?.(room.id); return { room: service.snapshot(room.id, request.user.id) }; }));
  app.post('/api/doudizhu/rooms/:roomId/actions', { preHandler: requireUser }, async (request) => queue.run(async () => {
    const body = request.body ?? {}; const roomId = request.params.roomId;
    const room = service.room(roomId); if (body.version !== undefined && Number(body.version) !== Number(room.version)) return { room: service.snapshot(roomId, request.user.id) };
    if (body.action === 'ready') service.setReady(roomId, request.user.id, body.ready ?? body.choice);
    else if (body.action === 'start') service.beginGame(roomId, request.user.id);
    else if (body.action === 'bid') service.bid(roomId, request.user.id, Boolean(body.choice));
    else if (body.action === 'double') service.double(roomId, request.user.id, body.value);
    else if (body.action === 'play') service.play(roomId, request.user.id, Array.isArray(body.cardIds) ? body.cardIds.map(String) : []);
    else if (body.action === 'pass') service.pass(roomId, request.user.id);
    else throw Object.assign(new Error('未知斗地主动作'), { statusCode: 400 });
    await persistence?.flushRoom?.(roomId); return { room: service.snapshot(roomId, request.user.id) };
  }));
  app.post('/api/doudizhu/rooms/:roomId/leave', { preHandler: requireUser }, async (request) => queue.run(async () => { const room = service.leaveRoom(request.params.roomId, request.user.id); await persistence?.flushRoom?.(room.id); return { ok: true }; }));
  return service;
}
