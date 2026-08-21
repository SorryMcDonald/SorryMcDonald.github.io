import { RoomService } from './service.js';
import { RoomLifecycleController } from './lifecycle.js';

export function registerRoomRoutes(app, options = {}) {
  const service = options.service ?? new RoomService({ store: options.store ?? app.auth?.store });
  const persistence = options.persistence;
  const lifecycle = options.lifecycle ?? new RoomLifecycleController({
    service,
    persistence,
    onError: (error) => app.log.error({ err: error }, 'room lifecycle timer failed')
  });
  app.decorate('rooms', service);
  app.decorate('lifecycle', lifecycle);
  const requireUser = async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); };
  app.get('/api/rooms', { preHandler: requireUser }, async () => ({ rooms: service.listRooms() }));
  app.post('/api/rooms', { preHandler: requireUser }, async (request) => {
    const room = service.createRoom(request.user.id, request.body ?? {});
    try {
      await lifecycle.mutate(room.id, () => room, { affectedUserIds: [request.user.id] });
    } catch (error) {
      service.reclaimRoom(room.id);
      throw error;
    }
    return { room: service.snapshot(room.id, request.user.id) };
  });
  app.post('/api/rooms/:roomId/join', { preHandler: requireUser }, async (request) => { await lifecycle.mutate(request.params.roomId, () => service.joinRoom(request.params.roomId, request.user.id, request.body?.seat), { affectedUserIds: [request.user.id] }); return { room: service.snapshot(request.params.roomId, request.user.id) }; });
  app.get('/api/rooms/:roomId', { preHandler: requireUser }, async (request) => {
    const room = service.room(request.params.roomId);
    const seated = [...room.players.values()].some((player) => player.userId === request.user.id && !player.left);
    const spectator = room.spectators.has(request.user.id);
    if (!seated && !spectator) throw Object.assign(new Error('请先加入房间或申请观战'), { statusCode: 403 });
    return { room: service.snapshot(room.id, request.user.id) };
  });
  app.post('/api/rooms/:roomId/actions', { preHandler: requireUser }, async (request) => {
    const action = { ...(request.body ?? {}) };
    delete action.now;
    await lifecycle.mutate(request.params.roomId, () => service.action(request.params.roomId, request.user.id, {
      ...action,
      now: lifecycle.clock?.now?.() ?? Date.now()
    }), { affectedUserIds: [request.user.id] });
    await app.reconcileTournamentRoom?.('zhajinhua', request.params.roomId);
    return { room: service.snapshot(request.params.roomId, request.user.id) };
  });
  app.post('/api/rooms/:roomId/messages', { preHandler: requireUser }, async (request, reply) => {
    const message = await lifecycle.mutate(request.params.roomId, () => (
      service.addMessage(request.params.roomId, request.user.id, request.body?.text, {
        now: lifecycle.clock?.now?.() ?? Date.now()
      })
    ));
    if (!message) return reply.code(404).send({ error: '房间不存在' });
    return { message: { ...message } };
  });
  app.post('/api/rooms/:roomId/start-next', { preHandler: requireUser }, async (request) => {
    app.tournaments?.assertRoomStartAllowed('zhajinhua', request.params.roomId);
    await lifecycle.mutate(request.params.roomId, () => service.startNextRound(request.params.roomId, request.user.id, {
      now: lifecycle.clock?.now?.() ?? Date.now()
    }));
    await app.reconcileTournamentRoom?.('zhajinhua', request.params.roomId);
    return { room: service.snapshot(request.params.roomId, request.user.id) };
  });
  app.post('/api/rooms/:roomId/leave', { preHandler: requireUser }, async (request) => {
    await lifecycle.mutate(request.params.roomId, () => service.leaveRoom(request.params.roomId, request.user.id, {
      now: lifecycle.clock?.now?.() ?? Date.now()
    }));
    await app.reconcileTournamentRoom?.('zhajinhua', request.params.roomId);
    return { ok: true };
  });
  app.post('/api/rooms/:roomId/spectate', { preHandler: requireUser }, async (request, reply) => {
    const enabled = request.body?.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled 必须是布尔值' });
    let target;
    try {
      target = service.room(request.params.roomId);
    } catch (error) {
      if (error?.statusCode === 404) return reply.code(404).send({ error: '房间不存在' });
      throw error;
    }
    const room = await lifecycle.mutate(target.id, () => service.setSpectating(target.id, request.user.id, enabled ?? true));
    if (!room || !service.rooms.has(room.id)) return { ok: true, reclaimed: true };
    return { room: service.snapshot(room.id, request.user.id) };
  });
  app.post('/api/rooms/:roomId/observe', { preHandler: requireUser }, async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled 必须是布尔值' });
    await lifecycle.mutate(request.params.roomId, () => service.setAllowSpectators(request.params.roomId, request.user.id, request.body.enabled));
    return { room: service.snapshot(request.params.roomId, request.user.id) };
  });
  return service;
}
