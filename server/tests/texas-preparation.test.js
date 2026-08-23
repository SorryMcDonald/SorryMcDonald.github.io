import { describe, expect, it } from 'vitest';
import { TexasService } from '../src/texas/service.js';
import { buildApp } from '../src/index.js';

function serviceFixture(count = 3) {
  const users = new Map();
  for (let index = 0; index < count; index += 1) {
    users.set(`u${index}`, { id:`u${index}`, nickname:`准备玩家${index}`, beans:100000, wins:0, losses:0 });
  }
  const service = new TexasService({ store:{ users, banners:[] } });
  const room = service.createRoom('u0', { smallBlind:10, bigBlind:20, buyIn:1000, allowSpectators:true });
  for (let index = 1; index < count; index += 1) service.joinRoom(room.id, `u${index}`, { buyIn:1000, seat:index });
  return { service, room, users };
}

function readyAll(service, room, ids) {
  for (const id of ids) service.setReady(room.id, id, true);
}

function action(service, room, userId, type) {
  const player = [...room.players.values()].find((value) => value.userId === userId);
  return service.action(room.id, userId, {
    type, handId:room.hand.id, version:room.version,
    actionSeq:player.actionSeq + 1, clientActionId:`prep-${userId}-${player.actionSeq + 1}-${room.version}`
  });
}

describe('Texas preparation and next-hand decisions', () => {
  it('requires readiness and keeps an unready seated player out of the hand', () => {
    const { service, room } = serviceFixture(3);
    service.setReady(room.id, 'u0', true);
    service.setReady(room.id, 'u1', true);
    expect(() => service.startHand(room.id, 'u0')).not.toThrow();
    const waiting = [...room.players.values()].find((player) => player.userId === 'u2');
    expect(waiting).toMatchObject({ ready:false, participated:false, inHand:false, waiting:true, spectating:false });
    expect(service.snapshot(room.id, 'u2').preparation).toMatchObject({ required:true, status:'pending', viewOnly:true });
    expect(service.snapshot(room.id, 'u2').allowedActions.actions).toEqual([]);
  });

  it('does not start with fewer than two ready players', () => {
    const { service, room } = serviceFixture(3);
    service.setReady(room.id, 'u0', true);
    expect(() => service.startHand(room.id, 'u0')).toThrow(/准备至少两名/);
  });

  it('requires previously participating players to choose the next hand after settlement', () => {
    const { service, room } = serviceFixture(2);
    readyAll(service, room, ['u0', 'u1']);
    service.startHand(room.id, 'u0');
    const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    action(service, room, actor.userId, 'fold');
    expect(room.status).toBe('settled');
    expect(room.lastWinnerUserId).toBeTruthy();
    const winnerId = room.lastWinnerUserId;
    expect(service.snapshot(room.id, winnerId).settlement).toMatchObject({ required:true, decision:'pending', isWinner:true });
    expect(() => service.startHand(room.id, winnerId)).toThrow(/先选择下一手或观战/);

    service.setReady(room.id, winnerId, true);
    const loserId = winnerId === 'u0' ? 'u1' : 'u0';
    service.setReady(room.id, loserId, true);
    expect(() => service.startHand(room.id, winnerId)).not.toThrow();
    expect(room.handNumber).toBe(2);
  });

  it('keeps an observer seated and reserves next-hand authority for the previous winner', () => {
    const { service, room } = serviceFixture(3);
    readyAll(service, room, ['u0', 'u1', 'u2']);
    service.startHand(room.id, 'u0');
    while (room.status !== 'settled') {
      const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
      action(service, room, actor.userId, 'fold');
    }

    const winnerId = room.lastWinnerUserId;
    const hostId = room.hostUserId;
    expect(winnerId).not.toBe(hostId);
    readyAll(service, room, ['u0', 'u1', 'u2'].filter((id) => id !== winnerId));
    expect(() => service.startHand(room.id, winnerId)).toThrow(/先选择下一手或观战/);
    service.setReady(room.id, winnerId, true);
    expect(() => service.startHand(room.id, hostId)).toThrow(/上一手赢家/);

    service.setReady(room.id, winnerId, false, { decision:'spectate' });
    const observer = [...room.players.values()].find((player) => player.userId === winnerId);
    expect(observer).toMatchObject({ left:false, ready:false, roundDecision:'spectate', inHand:false });
    expect(service.snapshot(room.id, winnerId)).toMatchObject({
      isSpectator:false,
      settlement:{ required:true, decision:'spectate', isWinner:true }
    });
    expect(() => service.addMessage(room.id, winnerId, '绕过前端发言')).toThrow(/观战|只读/);

    service.startHand(room.id, hostId);
    expect(observer.participated).toBe(false);
    while (room.status !== 'settled') {
      const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
      action(service, room, actor.userId, 'fold');
    }
    expect(service.snapshot(room.id, winnerId).preparation).toMatchObject({
      required:true,
      status:'pending',
      viewOnly:true
    });
  });

  it('lets a settled participant switch to spectator or leave without joining the next hand', () => {
    const { service, room } = serviceFixture(2);
    readyAll(service, room, ['u0', 'u1']);
    service.startHand(room.id, 'u0');
    const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    action(service, room, actor.userId, 'fold');
    const loser = actor.userId;
    service.setSpectating(room.id, loser, true);
    expect(service.snapshot(room.id, loser)).toMatchObject({ isSpectator:true });
    expect(room.spectators.has(loser)).toBe(true);
    expect([...room.players.values()].find((player) => player.userId === loser)?.left).toBe(true);
  });
});

async function register(app, email, nickname) {
  const response = await app.inject({ method:'POST', url:'/api/auth/register', payload:{ email, nickname, password:'password-123' } });
  expect(response.statusCode).toBe(201);
  return { cookie:response.headers['set-cookie'], user:response.json().user };
}

describe('Texas preparation API', () => {
  it('exposes prepare, observe, leave and settlement decision state through the existing session API', async () => {
    const app = await buildApp({ logger:false });
    const host = await register(app, 'prep-api-host@example.com', '准备 API 房主');
    const guest = await register(app, 'prep-api-guest@example.com', '准备 API 客人');
    const created = await app.inject({ method:'POST', url:'/api/texas/rooms', headers:{ cookie:host.cookie }, payload:{ allowSpectators:true } });
    const room = created.json().room;
    await app.inject({ method:'POST', url:`/api/texas/rooms/${room.id}/join`, headers:{ cookie:guest.cookie }, payload:{} });

    const blocked = await app.inject({ method:'POST', url:`/api/texas/rooms/${room.id}/start`, headers:{ cookie:host.cookie }, payload:{} });
    expect(blocked.statusCode).toBe(409);
    const preparedHost = await app.inject({ method:'POST', url:`/api/texas/rooms/${room.id}/ready`, headers:{ cookie:host.cookie }, payload:{ ready:true } });
    expect(preparedHost.statusCode).toBe(200);
    const preparedGuest = await app.inject({ method:'POST', url:`/api/texas/rooms/${room.id}/ready`, headers:{ cookie:guest.cookie }, payload:{ ready:true } });
    expect(preparedGuest.statusCode).toBe(200);
    const started = await app.inject({ method:'POST', url:`/api/texas/rooms/${room.id}/start`, headers:{ cookie:host.cookie }, payload:{} });
    expect(started.statusCode).toBe(200);
    expect(started.json().room.players.every((player) => player.inHand)).toBe(true);
    await app.close();
  });
});
