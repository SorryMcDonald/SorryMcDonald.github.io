import { describe, expect, it } from 'vitest';
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
});
