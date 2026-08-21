import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { RoomService } from '../src/rooms/service.js';

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

describe('room directory and departure', () => {
  it('lists active rooms without private cards and lets a player leave then join another room', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'rooms-a@example.com', '房主甲');
    const second = await register(app, 'rooms-b@example.com', '房主乙');
    const visitor = await register(app, 'rooms-c@example.com', '访客丙');

    const firstRoom = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    const secondRoom = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: second.cookie }, payload: {} })).json().room;

    const directory = await app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie: visitor.cookie } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: firstRoom.code, hostNickname: '房主甲', playerCount: 1, maxPlayers: 6, status: 'waiting' }),
      expect.objectContaining({ code: secondRoom.code, hostNickname: '房主乙', playerCount: 1, maxPlayers: 6, status: 'waiting' })
    ]));
    expect(JSON.stringify(directory.json())).not.toMatch(/cards|handType/i);

    const joinedFirst = await app.inject({ method: 'POST', url: `/api/rooms/${firstRoom.id}/join`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(joinedFirst.statusCode).toBe(200);
    const leftFirst = await app.inject({ method: 'POST', url: `/api/rooms/${firstRoom.id}/leave`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(leftFirst.statusCode).toBe(200);
    const joinedSecond = await app.inject({ method: 'POST', url: `/api/rooms/${secondRoom.id}/join`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(joinedSecond.statusCode).toBe(200);

    await app.close();
  });

  it('ignores a client-supplied clock and captures server time after queued work', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'clock-a@example.com', '时钟甲');
    const second = await register(app, 'clock-b@example.com', '时钟乙');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.cookie }, payload: {} });
    const started = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: first.cookie }, payload: {} });
    const startedRoom = started.json().room;
    const current = startedRoom.players.find((player) => player.seat === startedRoom.currentTurn);
    const cookie = current.userId === first.user.id ? first.cookie : second.cookie;
    let now = Date.now();
    app.lifecycle.clock.now = () => now;
    let releaseBlocker;
    const blocker = app.lifecycle.run(room.id, () => new Promise((resolve) => { releaseBlocker = resolve; }));
    await Promise.resolve();
    let queuedAction;
    const actionQueued = new Promise((resolve) => { queuedAction = resolve; });
    const originalMutate = app.lifecycle.mutate.bind(app.lifecycle);
    vi.spyOn(app.lifecycle, 'mutate').mockImplementation((...args) => {
      queuedAction();
      return originalMutate(...args);
    });

    const actionRequest = app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/actions`,
      headers: { cookie },
      payload: { action: 'call', actionSeq: 1, now: 0 }
    });
    await actionQueued;
    now += 5_000;
    releaseBlocker();
    await blocker;
    const acted = await actionRequest;

    expect(acted.statusCode).toBe(200);
    expect(acted.json().room.turnStartedAt).toBeNull();
    await app.close();
  });

  it('removes a newly created room when its first persistence flush fails', async () => {
    const app = await buildApp({
      logger: false,
      persistence: { async flushRoom() { throw new Error('database unavailable'); } }
    });
    const mutate = vi.spyOn(app.lifecycle, 'mutate');
    const account = await register(app, 'create-failure@example.com', '建房失败');

    const response = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: account.cookie }, payload: {} });

    expect(response.statusCode).toBe(500);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(app.rooms.rooms.size).toBe(0);
    await app.close();
  });

  it('requires an explicit boolean when changing spectator permission', async () => {
    const app = await buildApp({ logger: false });
    const owner = await register(app, 'observe-owner@example.com', '观战房主');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner.cookie }, payload: {} })).json().room;

    const missing = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/observe`, headers: { cookie: owner.cookie }, payload: {} });
    expect(missing.statusCode).toBe(400);
    const enabled = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/observe`, headers: { cookie: owner.cookie }, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().room.allowSpectators).toBe(true);
    await app.close();
  });

  it('defaults omitted spectate enabled to true and rejects non-boolean values', async () => {
    const app = await buildApp({ logger: false });
    const owner = await register(app, 'spectate-owner@example.com', '观战房主');
    const viewer = await register(app, 'spectate-viewer@example.com', '观战用户');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner.cookie }, payload: { allowSpectators: true } })).json().room;

    const invalid = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/spectate`, headers: { cookie: viewer.cookie }, payload: { enabled: 'true' } });
    expect(invalid.statusCode).toBe(400);

    const defaultEnabled = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/spectate`, headers: { cookie: viewer.cookie }, payload: {} });
    expect(defaultEnabled.statusCode).toBe(200);
    expect(defaultEnabled.json().room.isSpectator).toBe(true);
    await app.close();
  });

  it('reclaims an empty room when its final spectator stops spectating', async () => {
    const deleted = [];
    const app = await buildApp({
      logger: false,
      persistence: {
        async flushRoom() {},
        async deleteRoom(roomId) { deleted.push(roomId); }
      }
    });
    const owner = await register(app, 'spectate-reclaim@example.com', '回收观战者');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner.cookie }, payload: { allowSpectators: true } })).json().room;

    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/spectate`, headers: { cookie: owner.cookie }, payload: { enabled: true } });
    const response = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/spectate`, headers: { cookie: owner.cookie }, payload: { enabled: false } });

    expect(response.statusCode).toBe(200);
    expect(app.rooms.rooms.has(room.id)).toBe(false);
    expect(deleted).toEqual([room.id]);
    await app.close();
  });

  it('creates safe room messages through the lifecycle with seat and rate checks', async () => {
    const flushed = [];
    const app = await buildApp({
      logger: false,
      attachGateway: true,
      persistence: { async flushRoom(roomId) { flushed.push(roomId); } }
    });
    const owner = await register(app, 'message-owner@example.com', '发言玩家');
    const outsider = await register(app, 'message-outsider@example.com', '房外玩家');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner.cookie }, payload: {} })).json().room;
    const broadcast = vi.spyOn(app.gateway, 'broadcastRoom');

    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, payload: { text: '未登录' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, headers: { cookie: outsider.cookie }, payload: { text: '房外发言' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, headers: { cookie: owner.cookie }, payload: { text: '' } })).statusCode).toBe(400);

    let now = 10_000;
    app.lifecycle.clock.now = () => now;
    const created = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, headers: { cookie: owner.cookie }, payload: { text: '<b>纯文本</b>' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().message).toMatchObject({ userId: owner.user.id, nickname: '发言玩家', text: '<b>纯文本</b>' });
    expect(created.json().message).toHaveProperty('id');
    expect(created.json().message).toHaveProperty('createdAt');
    expect(flushed).toContain(room.id);
    expect(broadcast).toHaveBeenCalledWith(room.id, expect.objectContaining({ eventType: 'chat_message' }));

    now += 999;
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, headers: { cookie: owner.cookie }, payload: { text: '过快' } })).statusCode).toBe(429);
    now += 1;
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/messages`, headers: { cookie: owner.cookie }, payload: { text: '可以发送' } })).statusCode).toBe(200);

    const missing = await app.inject({ method: 'POST', url: '/api/rooms/000000/messages', headers: { cookie: owner.cookie }, payload: { text: '不存在' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatch(/房间不存在/);
    await app.close();
  });

  it('settles the round when the current player leaves and keeps their contribution in the pot', async () => {
    const app = await buildApp({ logger: false });
    const first = await register(app, 'leave-a@example.com', '离桌甲');
    const second = await register(app, 'leave-b@example.com', '留桌乙');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.cookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: first.cookie }, payload: {} });

    const left = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: first.cookie }, payload: {} });
    expect(left.statusCode).toBe(200);
    const snapshot = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: { cookie: second.cookie } });
    expect(snapshot.json().room.status).toBe('settled');

    const secondMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie } });
    expect(secondMe.json().user.beans).toBe(100010);
    await app.close();
  });
});

function gameStore(count = 7) {
  const users = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = `user-${index}`;
    users.set(id, { id, nickname: `玩家${index}`, beans: 100000, wins: 0, losses: 0 });
  }
  return { users, sessions: new Map(), banners: [] };
}

function startedService(playerCount = 2) {
  const store = gameStore(Math.max(7, playerCount));
  const service = new RoomService({ store });
  const room = service.createRoom('user-0', { ante: 10 });
  for (let index = 1; index < playerCount; index += 1) service.joinRoom(room.id, `user-${index}`);
  service.startNextRound(room.id, 'user-0');
  return { service, store, room };
}

describe('RoomService approved game state machine', () => {
  it('validates room codes and antes and retries generated code collisions', () => {
    const store = gameStore(4);
    const generatedCodes = [100000, 100000, 550000];
    const service = new RoomService({ store, randomInteger: () => generatedCodes.shift() });
    expect(() => service.createRoom('user-0', { code: 'abc', ante: 10 })).toThrow(/房间码/);
    expect(() => service.createRoom('user-0', { code: '123456', ante: -1 })).toThrow(/底注/);
    expect(() => service.createRoom('user-0', { code: '123456', ante: 0 })).toThrow(/底注/);
    service.createRoom('user-0', { code: '123456', ante: 10 });
    expect(() => service.createRoom('user-1', { code: '123456', ante: 10 })).toThrow(/房间码/);

    const first = service.createRoom('user-1');
    const second = service.createRoom('user-2');
    expect(first.code).toBe('100000');
    expect(second.code).toBe('550000');
  });

  it('has six fixed seats and rejects a seventh seated player', () => {
    const store = gameStore();
    const service = new RoomService({ store });
    const room = service.createRoom('user-0');
    for (let index = 1; index < 6; index += 1) service.joinRoom(room.id, `user-${index}`);
    expect([...room.players.values()].map((player) => player.seat)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => service.joinRoom(room.id, 'user-6')).toThrow(/已满/);
  });

  it('keeps the owner hand hidden until seeing without advancing the turn', () => {
    const { service, room } = startedService(2);
    const before = service.snapshot(room.id, 'user-0');
    const owner = before.players.find((player) => player.userId === 'user-0');
    expect(owner).toMatchObject({ seen: false, cardCount: 3 });
    expect(owner).not.toHaveProperty('cards');

    const turn = room.currentTurn;
    service.action(room.id, 'user-0', { action: 'see' });
    const after = service.snapshot(room.id, 'user-0');
    expect(after.currentTurn).toBe(turn);
    expect(after.players.find((player) => player.userId === 'user-0')).toMatchObject({ seen: true, actionSeq: 0 });
    expect(after.players.find((player) => player.userId === 'user-0').cards).toHaveLength(3);
    expect(service.snapshot(room.id, 'user-1').players.find((player) => player.userId === 'user-0')).not.toHaveProperty('cards');
  });

  it('charges a seen call twice and keeps betting across complete rounds', () => {
    const { service, store, room } = startedService(2);
    service.action(room.id, 'user-0', { action: 'see' });
    service.action(room.id, 'user-0', { action: 'call', actionSeq: 1 });
    expect(store.users.get('user-0').beans).toBe(99970);
    expect([...room.players.values()].find((player) => player.userId === 'user-0').totalContribution).toBe(30);
    service.action(room.id, 'user-1', { action: 'call', actionSeq: 1 });
    expect(room.status).toBe('betting');
    expect(room.bettingRound).toBe(1);
  });

  it('requires every other player to act again after a raise', () => {
    const { service, room } = startedService(3);
    service.action(room.id, 'user-0', { action: 'call', actionSeq: 1 });
    service.action(room.id, 'user-1', { action: 'call', actionSeq: 1 });
    service.action(room.id, 'user-2', { action: 'raise', amount: 20, actionSeq: 1 });

    expect(room.bettingRound).toBe(0);
    expect(room.roundActedSeats).toEqual([2]);
    expect(room.currentTurn).toBe(0);

    service.action(room.id, 'user-0', { action: 'call', actionSeq: 2 });
    service.action(room.id, 'user-1', { action: 'call', actionSeq: 2 });
    expect(room.bettingRound).toBe(1);
  });

  it('forces settlement only after the twentieth complete betting round', () => {
    const { service, room } = startedService(2);
    for (let actionIndex = 0; actionIndex < 40; actionIndex += 1) {
      const current = [...room.players.values()].find((player) => player.seat === room.currentTurn);
      service.action(room.id, current.userId, { action: 'call', actionSeq: current.actionSeq + 1 });
      if (actionIndex < 39) expect(room.status).toBe('betting');
    }
    expect(room.bettingRound).toBe(20);
    expect(room.status).toBe('settled');
  });

  it('requires a compare target and lets both participants reveal independently', () => {
    const { service, room } = startedService(3);
    const attacker = [...room.players.values()].find((player) => player.userId === 'user-0');
    const target = [...room.players.values()].find((player) => player.userId === 'user-1');
    attacker.cards = [{ rank: 14, suit: 'S' }, { rank: 14, suit: 'H' }, { rank: 2, suit: 'D' }];
    target.cards = [{ rank: 13, suit: 'S' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'C' }];

    expect(() => service.action(room.id, attacker.userId, { action: 'compare', actionSeq: 1 })).toThrow(/目标/);
    service.action(room.id, attacker.userId, { action: 'compare', targetSeat: target.seat, actionSeq: 1 });
    expect(attacker.mayReveal).toBe(true);
    expect(target.mayReveal).toBe(true);
    expect(target.folded).toBe(true);
    const compareEvents = room.events.filter((event) => event.eventType.startsWith('compare_'));
    expect(JSON.stringify(compareEvents)).not.toMatch(/cards|handType|typeName/);

    const turn = room.currentTurn;
    service.action(room.id, target.userId, { action: 'reveal' });
    expect(room.currentTurn).toBe(turn);
    expect(target.revealed).toBe(true);
    expect(room.events.at(-1)).toMatchObject({ eventType: 'hand_revealed', payload: { userId: target.userId, seat: target.seat } });
  });

  it('identifies both seats in compare_resolved without exposing either hand', () => {
    const { service, room } = startedService(3);
    const attacker = [...room.players.values()].find((player) => player.userId === 'user-0');
    const target = [...room.players.values()].find((player) => player.userId === 'user-1');

    service.action(room.id, attacker.userId, { action: 'compare', targetSeat: target.seat, actionSeq: 1 });

    const event = room.events.findLast((entry) => entry.eventType === 'compare_resolved');
    expect(event.payload).toMatchObject({
      attackerUserId: attacker.userId,
      attackerSeat: attacker.seat,
      targetUserId: target.userId,
      targetSeat: target.seat
    });
    expect(event.payload).not.toHaveProperty('cards');
    expect(event.payload).not.toHaveProperty('handType');
  });

  it('eliminates the attacker when compared hands are equal', () => {
    const { service, room } = startedService(3);
    const attacker = [...room.players.values()].find((player) => player.userId === 'user-0');
    const target = [...room.players.values()].find((player) => player.userId === 'user-1');
    const hand = [{ rank: 14, suit: 'S' }, { rank: 13, suit: 'H' }, { rank: 9, suit: 'D' }];
    attacker.cards = hand;
    target.cards = hand.map((card) => ({ ...card }));

    service.action(room.id, attacker.userId, { action: 'compare', targetSeat: target.seat, actionSeq: 1 });

    expect(attacker.folded).toBe(true);
    expect(target.folded).toBe(false);
  });
});
