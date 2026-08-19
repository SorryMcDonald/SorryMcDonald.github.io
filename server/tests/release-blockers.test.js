import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { calculateTexasPots } from '../src/texas/rules.js';
import { RoomService } from '../src/rooms/service.js';
import { RoomLifecycleController } from '../src/rooms/lifecycle.js';
import { TexasLifecycleController } from '../src/texas/lifecycle.js';
import { TexasService } from '../src/texas/service.js';
import { WebSocketGateway } from '../src/ws/gateway.js';

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

class FakeClock {
  constructor(start = 0) { this.time = start; this.nextId = 1; this.tasks = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { id, at: this.time + Number(delay), callback });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  async advanceBy(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const task = [...this.tasks.values()]
        .filter((value) => value.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!task) break;
      this.tasks.delete(task.id);
      this.time = task.at;
      await task.callback();
    }
    this.time = target;
  }
}

function texasStore() {
  const users = new Map([
    ['u0', { id: 'u0', nickname: '甲', beans: 100000, wins: 0, losses: 0 }],
    ['u1', { id: 'u1', nickname: '乙', beans: 100000, wins: 0, losses: 0 }]
  ]);
  return { users, banners: [] };
}

describe('release blockers', () => {
  it('denies a non-member Zhajinhua snapshot even after settlement', async () => {
    const app = await buildApp({ logger: false });
    const owner = await register(app, 'snapshot-owner@example.com', '牌局房主');
    const outsider = await register(app, 'snapshot-outsider@example.com', '房外玩家');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner.cookie }, payload: {} })).json().room;

    const response = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: { cookie: outsider.cookie } });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns an uncalled Texas contribution layer and preserves chip conservation', () => {
    const players = [
      { id: 'short', seat: 0, totalContribution: 50, folded: false, left: false, evaluation: { level: 2, values: [14] } },
      { id: 'deep', seat: 1, totalContribution: 100, folded: false, left: false, evaluation: { level: 1, values: [13] } }
    ];

    const result = calculateTexasPots(players, 0);

    expect(result.payouts).toEqual({ short: 100, deep: 50 });
    expect(Object.values(result.payouts).reduce((sum, value) => sum + value, 0)).toBe(150);
    expect(result.pots.map((pot) => pot.amount)).toEqual([100]);
  });

  it('keeps existing Texas in-memory chat when a route mutation persistence fails', async () => {
    let flushCount = 0;
    const app = await buildApp({
      logger: false,
      texasPersistence: {
        async flushRoom() {
          flushCount += 1;
          if (flushCount > 1) throw new Error('database unavailable');
        }
      }
    });
    const owner = await register(app, 'rollback-chat-owner@example.com', '聊天房主');
    const room = (await app.inject({ method: 'POST', url: '/api/texas/rooms', headers: { cookie: owner.cookie }, payload: {} })).json().room;
    app.texas.addMessage(room.id, owner.user.id, '持久化失败前的聊天', { now: 1000 });

    const guest = await register(app, 'rollback-chat-guest@example.com', '聊天客人');
    const response = await app.inject({ method: 'POST', url: `/api/texas/rooms/${room.id}/join`, headers: { cookie: guest.cookie }, payload: {} });

    expect(response.statusCode).toBe(500);
    expect(app.texas.room(room.id).messages.map((message) => message.text)).toEqual(['持久化失败前的聊天']);
    await app.close();
  });

  it('restores a sixty-second disconnect grace timer for a recovered Zhajinhua room', async () => {
    const store = {
      users: new Map([
        ['u0', { id: 'u0', nickname: '甲', beans: 100000, wins: 0, losses: 0 }],
        ['u1', { id: 'u1', nickname: '乙', beans: 100000, wins: 0, losses: 0 }]
      ]),
      banners: []
    };
    const clock = new FakeClock();
    const service = new RoomService({ store });
    const room = service.createRoom('u0');
    service.joinRoom(room.id, 'u1');
    const lifecycle = new RoomLifecycleController({ service, clock });

    lifecycle.restoreAll();

    expect(lifecycle.disconnectTimers.size).toBe(2);
    await clock.advanceBy(60_000);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].every((player) => player.left)).toBe(true);
  });

  it('restores a sixty-second disconnect grace timer for a recovered Texas room', async () => {
    const store = texasStore();
    const clock = new FakeClock();
    const service = new TexasService({ store, clock });
    const room = service.createRoom('u0');
    service.joinRoom(room.id, 'u1');
    const lifecycle = new TexasLifecycleController({ service, clock });

    lifecycle.restoreAll();

    expect(lifecycle.disconnectTimers.size).toBe(2);
    await clock.advanceBy(60_000);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].every((player) => player.left)).toBe(true);
  });

  it('closes a departed user socket and rejects sync after access is revoked', async () => {
    const sent = [];
    const handlers = new Map();
    const socket = {
      readyState: 1,
      send(value) { sent.push(JSON.parse(value)); },
      on(name, handler) { handlers.set(name, handler); },
      close: vi.fn()
    };
    const room = {
      id: 'room-id',
      players: new Map([['player', { userId: 'user-id', left: false }]]),
      spectators: new Set(),
      events: [{ id: 1, eventType: 'player_joined', payload: {} }]
    };
    const service = {
      room() { return room; },
      eventsSince() { return room.events; }
    };
    const gateway = new WebSocketGateway({ service });
    gateway.addRoomSocket(room.id, socket, { userId: 'user-id' });

    room.players.get('player').left = true;
    gateway.closeUserRoomSockets(room.id, 'user-id');
    await gateway.handleMessage(socket, room.id, 'user-id', JSON.stringify({ type: 'sync', after: 0 }), service);

    expect(socket.close).toHaveBeenCalledWith(1008, 'room access denied');
    expect(sent).toEqual([]);
    expect(gateway.rooms.has(room.id)).toBe(false);
  });

  it('marks split systemd examples as unavailable because Compose owns the single app', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const name of ['zhajinhua-api.service', 'zhajinhua-ws.service', 'zhajinhua-worker.service']) {
      const contents = await readFile(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
      expect(contents).toMatch(/deprecated|废弃|compose/i);
      expect(contents).not.toMatch(/^ExecStart=/m);
    }
  });
});
