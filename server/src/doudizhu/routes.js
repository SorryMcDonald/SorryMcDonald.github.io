import { DoudizhuMutationController } from './mutations.js';
import { DoudizhuService } from './service.js';

export function registerDoudizhuRoutes(app, options = {}) {
  const service = options.service ?? new DoudizhuService({ store: options.store ?? app.auth?.store });
  const persistence = options.persistence;
  const mutations = options.mutations ?? new DoudizhuMutationController({ service, persistence, mutationQueue: options.mutationQueue });
  const requireUser = async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); };
  const requireActiveMember = (room, userId) => {
    if (!room.players.some((player) => player.userId === userId && !player.left)) throw Object.assign(new Error('请先加入斗地主房间'), { statusCode: 403 });
  };
  app.decorate('doudizhu', service);
  app.decorate('doudizhuMutations', mutations);

  app.get('/api/doudizhu/rooms', { preHandler: requireUser }, async (request) => mutations.run(async () => {
    const currentRoom = service.activeRoomForUser(request.user.id);
    return {
      rooms: [...service.rooms.values()].filter((room) => room.status !== 'closed' && room.players.some((player) => !player.left)).map((room) => ({
        id: room.id, code: room.code, status: room.status, maxPlayers: room.maxPlayers, baseScore: room.baseScore,
        playerCount: room.players.filter((player) => !player.left).length,
        hostNickname: service.store.users.get(room.hostUserId)?.nickname ?? '等待房主',
        isMember: room.players.some((player) => player.userId === request.user.id && !player.left)
      })),
      currentRoom: currentRoom ? service.snapshot(currentRoom.id, request.user.id) : null
    };
  }));
  app.post('/api/doudizhu/rooms', { preHandler: requireUser }, async (request, reply) => {
    const { room, created } = await mutations.createOrResume(request.user.id, request.body ?? {});
    if (created) reply.code(201);
    return { created, room: service.snapshot(room.id, request.user.id) };
  });
  app.get('/api/doudizhu/rooms/:roomId', { preHandler: requireUser }, async (request) => {
    const result = await mutations.mutate(request.params.roomId, (room) => {
      requireActiveMember(room, request.user.id);
      return service.autoProgress(room.id);
    });
    return { room: service.snapshot(result.room.id, request.user.id) };
  });
  app.post('/api/doudizhu/rooms/:roomId/join', { preHandler: requireUser }, async (request) => {
    const result = await mutations.mutate(request.params.roomId, (room) => service.joinRoom(room.id, request.user.id));
    return { room: service.snapshot(result.room.id, request.user.id) };
  });
  app.post('/api/doudizhu/rooms/:roomId/actions', { preHandler: requireUser }, async (request) => {
    const body = request.body ?? {}; const roomId = request.params.roomId;
    const result = await mutations.mutate(roomId, (room) => {
      requireActiveMember(room, request.user.id);
      if (body.version !== undefined && Number(body.version) !== Number(room.version)) return room;
      if (body.action === 'ready') return service.setReady(room.id, request.user.id, body.ready ?? body.choice);
      if (body.action === 'start') return service.beginGame(room.id, request.user.id);
      if (body.action === 'bid') return service.bid(room.id, request.user.id, Boolean(body.choice));
      if (body.action === 'double') return service.double(room.id, request.user.id, body.value);
      if (body.action === 'play') return service.play(room.id, request.user.id, Array.isArray(body.cardIds) ? body.cardIds.map(String) : []);
      if (body.action === 'pass') return service.pass(room.id, request.user.id);
      throw Object.assign(new Error('未知斗地主动作'), { statusCode: 400 });
    });
    return { room: service.snapshot(result.room.id, request.user.id) };
  });
  app.post('/api/doudizhu/rooms/:roomId/leave', { preHandler: requireUser }, async (request) => {
    const result = await mutations.mutate(request.params.roomId, (room) => service.leaveRoom(room.id, request.user.id), { deleteWhenEmpty: true });
    return { ok: true, deleted: result.deleted };
  });
  return service;
}
