import { describe, expect, it } from 'vitest';
import { WebSocketGateway } from '../src/ws/gateway.js';
import { buildApp } from '../src/index.js';
import { visibleRoom } from '../src/game/events.js';
import { RoomService } from '../src/rooms/service.js';

function socket() { return { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); }, on() {} }; }

function managedSocket() {
  const handlers = new Map();
  return {
    readyState: 1,
    sent: [],
    pings: 0,
    terminated: 0,
    send(value) { this.sent.push(JSON.parse(value)); },
    ping() { this.pings += 1; },
    terminate() { this.terminated += 1; this.emit('close'); },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    emit(name, ...args) { for (const handler of handlers.get(name) ?? []) handler(...args); }
  };
}

describe('WebSocket visibility', () => {
  it('authenticates a database-backed session resolver', async () => {
    const sent = [];
    const socket = { readyState: 1, send(value) { sent.push(JSON.parse(value)); }, on() {}, close() { throw new Error('socket should stay open'); } };
    const service = { room: () => ({ id: 'room', spectators: new Set() }), eventsSince: () => [] };
    const gateway = new WebSocketGateway({ service, findSession: async () => ({ id: 'database-user' }) });

    await gateway.handleConnection(socket, { headers: { cookie: 'zhajinhua_session=database-token' } }, new URL('http://localhost/ws?roomId=room'));

    expect(sent).toContainEqual({ type: 'connected' });
    expect(gateway.rooms.get('room')).toBeDefined();
  });

  it('rejects an authenticated user who is neither seated nor an explicit spectator', async () => {
    const closes = [];
    const socket = {
      readyState: 1,
      sent: [],
      send(value) { this.sent.push(JSON.parse(value)); },
      on() {},
      close(code, reason) { closes.push([code, reason]); }
    };
    const service = {
      room: () => ({
        id: 'room',
        players: new Map([['player-entry', { userId: 'seated-user', left: false }]]),
        spectators: new Set(),
        allowSpectators: true
      }),
      eventsSince: () => []
    };
    const gateway = new WebSocketGateway({ service, findSession: async () => ({ id: 'stranger' }) });

    await gateway.handleConnection(
      socket,
      { headers: { cookie: 'zhajinhua_session=database-token' } },
      new URL('http://localhost/ws?roomId=room')
    );

    expect(closes).toEqual([[1008, 'room access denied']]);
    expect(gateway.rooms.has('room')).toBe(false);
  });

  it('keeps compare cards/type names hidden but gives spectators settled cards', () => {
    const gateway = new WebSocketGateway({}); const player = socket(); const observer = socket();
    gateway.addRoomSocket('room', player, { userId: 'p', spectator: false }); gateway.addRoomSocket('room', observer, { userId: 's', spectator: true });
    gateway.broadcastRoom('room', { eventType: 'compare_started', payload: { attacker: '甲', target: '乙', cards: [{ rank: 2 }], typeName: '豹子' } });
    expect(player.sent[0].event.payload).not.toHaveProperty('cards'); expect(player.sent[0].event.payload).not.toHaveProperty('typeName');
    gateway.broadcastRoom('room', { eventType: 'round_settled', payload: { cards: [{ rank: 2 }], typeName: '对子' } });
    expect(observer.sent[1].event.payload.cards).toHaveLength(1); expect(observer.sent[1].event.payload.typeName).toBe('对子');
  });

  it('keeps an unseen owner hidden while spectators receive every live hand', () => {
    const store = {
      users: new Map([
        ['owner', { id: 'owner', nickname: '牌手甲', beans: 100000, wins: 0, losses: 0 }],
        ['other', { id: 'other', nickname: '牌手乙', beans: 100000, wins: 0, losses: 0 }],
        ['observer', { id: 'observer', nickname: '观战者', beans: 100000, wins: 0, losses: 0 }]
      ]),
      sessions: new Map(),
      banners: []
    };
    const service = new RoomService({ store });
    const room = service.createRoom('owner', { allowSpectators: true });
    service.joinRoom(room.id, 'other');
    service.setReady(room.id, 'owner', true);
    service.setReady(room.id, 'other', true);
    service.startNextRound(room.id, 'owner');
    room.spectators.add('observer');

    const ownerView = visibleRoom(room, { userId: 'owner' });
    expect(ownerView.players.find((player) => player.userId === 'owner')).not.toHaveProperty('cards');
    const observerView = visibleRoom(room, { userId: 'observer', spectator: true });
    expect(observerView.players.every((player) => player.cards.length === 3)).toBe(true);
  });

  it('broadcasts room events without sending a zero-balance banner before manual refill', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    const register = (email, nickname) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, nickname, password: 'password-123' } });
    const first = await register('broadcast-test-a@example.com', '广播测试甲');
    const second = await register('broadcast-test-b@example.com', '广播测试乙');
    const firstCookie = first.headers['set-cookie'];
    const secondCookie = second.headers['set-cookie'];
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: firstCookie }, payload: {} })).json().room;
    const observer = socket(); const global = socket();
    app.gateway.addRoomSocket(room.id, observer, { userId: second.json().user.id, spectator: false });
    app.gateway.addGlobalSocket(global);
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: secondCookie }, payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/ready`, headers: { cookie: firstCookie }, payload: { ready: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/ready`, headers: { cookie: secondCookie }, payload: { ready: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: firstCookie }, payload: {} });
    expect(observer.sent.map((message) => message.event?.eventType)).toEqual(['player_joined', 'player_ready', 'player_ready', 'round_started']);
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: firstCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: secondCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    expect(global.sent.filter((message) => message.type === 'global_banner' && message.banner?.queueName === 'economy')).toHaveLength(0);
    expect(global.sent.some((message) => message.banner?.queueName === 'leaderboard')).toBe(true);
    await app.close();
  });

  it('tracks room connections once per socket and removes dead heartbeat clients', () => {
    const lifecycle = { connectedCalls: [], disconnectedCalls: [], connected(roomId, userId) { this.connectedCalls.push([roomId, userId]); }, disconnected(roomId, userId) { this.disconnectedCalls.push([roomId, userId]); } };
    const gateway = new WebSocketGateway({ lifecycle });
    const client = managedSocket();
    gateway.addRoomSocket('room-a', client, { userId: 'user-a' });

    expect(lifecycle.connectedCalls).toEqual([['room-a', 'user-a']]);
    gateway.sweepHeartbeat();
    expect(client.pings).toBe(1);
    client.emit('pong');
    gateway.sweepHeartbeat();
    expect(client.terminated).toBe(0);
    gateway.sweepHeartbeat();
    expect(client.terminated).toBe(1);
    expect(lifecycle.disconnectedCalls).toEqual([['room-a', 'user-a']]);
  });

  it('keeps responsive global clients alive until they miss a heartbeat', () => {
    const gateway = new WebSocketGateway({});
    const client = managedSocket();
    gateway.addGlobalSocket(client);

    gateway.sweepHeartbeat();
    expect(client.pings).toBe(1);
    client.emit('pong');
    gateway.sweepHeartbeat();
    expect(client.terminated).toBe(0);

    gateway.sweepHeartbeat();
    expect(client.terminated).toBe(1);
  });

  it('keeps Texas sockets isolated and canonicalizes invite codes', async () => {
    const texasRoom = { id: 'texas-room-id', code: '654321', spectators: new Set(['texas-user']) };
    const texas = {
      room(roomId) { expect(roomId).toBe('654321'); return texasRoom; },
      canAccess(roomId, userId) { expect([roomId, userId]).toEqual(['texas-room-id', 'texas-user']); return true; },
      eventsSince(roomId, userId, after) {
        expect([roomId, userId, after]).toEqual(['texas-room-id', 'texas-user', 0]);
        return [{ id: 1, eventType: 'texas_player_action', payload: {} }];
      },
      publicEvent(_room, event) { return event; }
    };
    const zhajinhua = { room: () => ({ id: 'zhajinhua-room', spectators: new Set() }) };
    const gateway = new WebSocketGateway({
      service: zhajinhua,
      services: { zhajinhua, texas },
      findSession: async () => ({ id: 'texas-user' })
    });
    const client = socket();

    await gateway.handleConnection(
      client,
      { headers: { cookie: 'zhajinhua_session=database-token' } },
      new URL('http://localhost/ws?game=texas&roomId=654321')
    );
    await gateway.handleMessage(client, 'texas-room-id', 'texas-user', JSON.stringify({ type: 'sync', after: 0 }), texas, 'texas');

    expect(gateway.rooms.has('texas:texas-room-id')).toBe(true);
    expect(client.sent).toContainEqual({
      type: 'room_event',
      game: 'texas',
      event: { id: 1, eventType: 'texas_player_action', payload: {} }
    });
  });

  it('rejects oversized inbound messages before parsing', async () => {
    const gateway = new WebSocketGateway({ maxPayloadBytes: 8 });
    const client = socket();

    await gateway.handleMessage(client, 'room', 'user', Buffer.from('{"type":"chat"}'));

    expect(client.sent).toContainEqual({ type: 'error', error: '消息过大' });
  });
});
