import { TournamentService } from './service.js';

function snapshotUsers(store) {
  return new Map([...store.users].map(([id, user]) => [id, structuredClone(user)]));
}

function restoreUsers(store, before) {
  for (const [id, user] of before) store.users.set(id, user);
}

export function registerTournamentRoutes(app, options = {}) {
  const service = options.service ?? new TournamentService({
    store:options.store ?? app.auth.store,
    roomService:app.rooms,
    texasService:app.texas,
    clock:options.clock,
    persistence:options.persistence
  });
  const persistence = options.persistence;
  const roomPersistence = options.roomPersistence;
  const texasPersistence = options.texasPersistence;
  const queue = app.lifecycle.mutationQueue;
  const requireUser = async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error:'需要登录' });
  };

  app.decorate('tournaments', service);

  async function persistGameRoom(game, roomId, previousVersion = null, eventStart = 0) {
    if (game === 'texas') {
      const room = app.texas.room(roomId);
      await texasPersistence?.flushRoom(room.id, previousVersion ?? room.version - 1, eventStart);
      app.texasLifecycle?.scheduleTurn(room);
      return;
    }
    await roomPersistence?.flushRoom(roomId);
    const room = app.rooms.room(roomId);
    app.lifecycle?.scheduleTurn?.(room);
  }

  app.decorate('reconcileTournamentRoom', async (game, roomId) => queue.run(async () => {
    const found = service.findTrackByRoom(game, roomId);
    if (!found) return null;
    const gameService = service.gameService(game);
    const eventStarts = new Map([...gameService.rooms.values()].map((room) => [room.id, room.eventSeq]));
    const result = service.reconcileRoom(game, roomId);
    for (const affectedRoomId of result.affectedRoomIds) {
      await persistGameRoom(game, affectedRoomId);
      const room = gameService.room(affectedRoomId);
      for (const event of room.events.filter((entry) => entry.id > Number(eventStarts.get(affectedRoomId) ?? 0))) {
        app.gateway?.broadcastRoom(affectedRoomId, event, game);
      }
    }
    await persistence?.flushEdition(found.edition.id);
    return result;
  }));

  app.get('/api/tournaments/current', { preHandler:requireUser }, async (request) => queue.run(async () => {
    const ledgerStart = service.pendingLedger.length;
    const tournament = service.view(request.user.id);
    const edition = service.editionById(tournament.id);
    const prizes = service.pendingLedger.slice(ledgerStart).filter((entry) => entry.entryType === 'prize');
    for (const prize of prizes) {
      const track = edition?.tracks.get(prize.metadata?.game);
      const winner = track ? service.entryForUser(track, prize.userId) : null;
      if (winner?.roomId) await persistGameRoom(track.game, winner.roomId);
    }
    await persistence?.flushEdition(edition?.id);
    return { tournament };
  }));

  app.post('/api/tournaments/:game/enter', { preHandler:requireUser }, async (request) => queue.run(async () => {
    const beforeUsers = snapshotUsers(service.store);
    const beforeEditions = structuredClone(service.editions);
    const beforeRooms = structuredClone(app.rooms.rooms);
    const beforeTexasRooms = structuredClone(app.texas.rooms);
    const beforeLedger = [...service.pendingLedger];
    let tournamentPersisted = false;
    let result;
    try {
      result = service.enter(request.params.game, request.user.id, request.body?.buyIn);
      await persistence?.flushEdition(result.mutation.editionId);
      tournamentPersisted = Boolean(persistence);
      await persistGameRoom(request.params.game, result.roomId, result.mutation.previousVersion, result.mutation.eventStart);
      const { mutation, ...publicResult } = result;
      return publicResult;
    } catch (error) {
      if (tournamentPersisted && result?.mutation) {
        try { await persistence.rollbackRegistration(result.mutation); }
        catch (rollbackError) { app.log.error({ err:rollbackError, entryId:result.mutation.entryId }, 'tournament registration rollback failed'); }
      }
      restoreUsers(service.store, beforeUsers);
      service.editions = beforeEditions;
      service.pendingLedger = beforeLedger;
      app.rooms.rooms = beforeRooms;
      app.texas.rooms = beforeTexasRooms;
      throw error;
    }
  }));

  return service;
}
