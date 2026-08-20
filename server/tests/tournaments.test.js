import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

async function register(app, index) {
  const response = await app.inject({
    method:'POST', url:'/api/auth/register',
    payload:{ email:`tournament-${index}@example.com`, nickname:`锦标赛玩家${index}`, password:'password-123' }
  });
  return { cookie:response.headers['set-cookie'], user:response.json().user };
}

function clockAt(iso) {
  let now = Date.parse(iso);
  return { now:() => now, set:(value) => { now = Date.parse(value); } };
}

describe('weekly tournaments', () => {
  it('rejects entry before Wednesday noon and opens at the exact Shanghai boundary', async () => {
    const clock = clockAt('2026-08-19T03:59:59.999Z');
    const app = await buildApp({ logger:false, tournamentClock:clock });
    const player = await register(app, 'boundary');

    const early = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:player.cookie }, payload:{ buyIn:4000 } });
    expect(early.statusCode).toBe(403);
    expect((await app.inject({ method:'GET', url:'/api/tournaments/current', headers:{ cookie:player.cookie } })).json().tournament.status).toBe('scheduled');

    clock.set('2026-08-19T04:00:00.000Z');
    const opened = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:player.cookie }, payload:{ buyIn:4000 } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().room.tournament.game).toBe('texas');
    await app.close();
  });

  it('enforces the cap, blocks normal-room joins and permanently blocks re-entry after leaving', async () => {
    const clock = clockAt('2026-08-19T04:05:00.000Z');
    const app = await buildApp({ logger:false, tournamentClock:clock });
    const first = await register(app, 'rules-a');
    const second = await register(app, 'rules-b');

    const aboveCap = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:first.cookie }, payload:{ buyIn:200001 } });
    expect(aboveCap.statusCode).toBe(400);
    const entered = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:first.cookie }, payload:{ buyIn:4000 } });
    const roomId = entered.json().roomId;
    const bypass = await app.inject({ method:'POST', url:`/api/texas/rooms/${roomId}/join`, headers:{ cookie:second.cookie }, payload:{ buyIn:4000 } });
    expect(bypass.statusCode).toBe(403);
    const rebuy = await app.inject({ method:'POST', url:`/api/texas/rooms/${roomId}/rebuy`, headers:{ cookie:first.cookie }, payload:{ amount:100 } });
    expect(rebuy.statusCode).toBe(409);
    expect((await app.inject({ method:'POST', url:`/api/texas/rooms/${roomId}/leave`, headers:{ cookie:first.cookie }, payload:{} })).statusCode).toBe(200);
    const reentry = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:first.cookie }, payload:{ buyIn:4000 } });
    expect(reentry.statusCode).toBe(409);
    await app.close();
  });

  it('isolates Zhajinhua tournament chips from account beans during hands', async () => {
    const clock = clockAt('2026-08-19T04:05:00.000Z');
    const app = await buildApp({ logger:false, tournamentClock:clock });
    const first = await register(app, 'zjh-a');
    const second = await register(app, 'zjh-b');
    const entered = await app.inject({ method:'POST', url:'/api/tournaments/zhajinhua/enter', headers:{ cookie:first.cookie }, payload:{ buyIn:1000 } });
    const roomId = entered.json().roomId;
    await app.inject({ method:'POST', url:'/api/tournaments/zhajinhua/enter', headers:{ cookie:second.cookie }, payload:{ buyIn:1000 } });
    expect(app.auth.store.users.get(first.user.id).beans).toBe(99000);
    expect(app.auth.store.users.get(second.user.id).beans).toBe(99000);

    const started = await app.inject({ method:'POST', url:`/api/rooms/${roomId}/start-next`, headers:{ cookie:first.cookie }, payload:{} });
    expect(started.statusCode).toBe(200);
    const actor = started.json().room.players.find((player) => player.seat === started.json().room.currentTurn);
    const actorCookie = actor.userId === first.user.id ? first.cookie : second.cookie;
    expect((await app.inject({ method:'POST', url:`/api/rooms/${roomId}/actions`, headers:{ cookie:actorCookie }, payload:{ action:'fold', actionSeq:1 } })).statusCode).toBe(200);

    expect(app.auth.store.users.get(first.user.id).beans).toBe(99000);
    expect(app.auth.store.users.get(second.user.id).beans).toBe(99000);
    const chips = [...app.rooms.room(roomId).players.values()].reduce((sum, player) => sum + Number(player.tournamentChips ?? 0), 0);
    expect(chips).toBe(2000);
    await app.close();
  });

  it('automatically creates another Texas table when the first table is full', async () => {
    const clock = clockAt('2026-08-19T04:05:00.000Z');
    const app = await buildApp({ logger:false, tournamentClock:clock, attachGateway:true });
    const players = [];
    for (let index = 0; index < 10; index += 1) {
      const player = await register(app, `table-${index}`);
      players.push(player);
      const entered = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:player.cookie }, payload:{ buyIn:4000 } });
      expect(entered.statusCode).toBe(200);
    }
    const tournament = app.tournaments.view(null);
    expect(tournament.tracks.find((track) => track.game === 'texas')).toMatchObject({ playerCount:10, tableCount:2 });

    const track = [...app.tournaments.editions.values()][0].tracks.get('texas');
    const tables = [...track.tables.values()];
    const sourceEntry = app.tournaments.entryForUser(track, players.at(-1).user.id);
    expect(sourceEntry.roomId).toBe(tables[1].roomId);
    const socket = { readyState:1, sent:[], send(value){ this.sent.push(JSON.parse(value)); }, on(){} };
    app.gateway.addRoomSocket(tables[1].roomId, socket, { userId:sourceEntry.userId, game:'texas' });
    const eliminated = [...app.texas.room(tables[0].roomId).players.values()].find((player) => !player.left);
    eliminated.stack = 0;
    await app.reconcileTournamentRoom('texas', tables[0].roomId);
    expect(sourceEntry.roomId).toBe(tables[0].roomId);
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type:'room_event', game:'texas', event:expect.objectContaining({ eventType:'tournament_player_moved', payload:expect.objectContaining({ toRoomId:tables[0].roomId }) })
    }));
    await app.close();
  });

  it('declares the sole remaining entrant champion only after registration closes', async () => {
    const clock = clockAt('2026-08-19T04:05:00.000Z');
    const app = await buildApp({ logger:false, tournamentClock:clock });
    const player = await register(app, 'champion');
    await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:player.cookie }, payload:{ buyIn:4000 } });
    expect(app.auth.store.users.get(player.user.id).beans).toBe(96000);

    clock.set('2026-08-19T04:30:00.000Z');
    const current = await app.inject({ method:'GET', url:'/api/tournaments/current', headers:{ cookie:player.cookie } });
    const track = current.json().tournament.tracks.find((value) => value.game === 'texas');
    expect(track.status).toBe('completed');
    expect(track.champion.nickname).toBe('锦标赛玩家champion');
    expect(app.auth.store.users.get(player.user.id).beans).toBe(100000);
    await app.close();
  });

  it('rolls back tournament registration when the game room cannot be persisted', async () => {
    const clock = clockAt('2026-08-19T04:05:00.000Z');
    const rolledBack = [];
    const app = await buildApp({
      logger:false, tournamentClock:clock,
      tournamentPersistence:{ async flushEdition(){}, async rollbackRegistration(mutation){ rolledBack.push(mutation); } },
      texasPersistence:{ async flushRoom(){ throw new Error('database unavailable'); } }
    });
    const player = await register(app, 'rollback');
    const response = await app.inject({ method:'POST', url:'/api/tournaments/texas/enter', headers:{ cookie:player.cookie }, payload:{ buyIn:4000 } });
    expect(response.statusCode).toBe(500);
    expect(rolledBack).toHaveLength(1);
    expect(app.auth.store.users.get(player.user.id).beans).toBe(100000);
    expect(app.texas.rooms.size).toBe(0);
    expect(app.tournaments.view(player.user.id).tracks.find((track) => track.game === 'texas').entry).toBeNull();
    await app.close();
  });
});
