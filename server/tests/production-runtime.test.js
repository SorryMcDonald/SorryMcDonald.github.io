import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createProductionRuntime } from '../src/runtime.js';
import { deserializeRoom, serializeRoom } from '../src/persistence/runtime-state.js';
import { RoomService } from '../src/rooms/service.js';

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return response.headers['set-cookie'];
}

function fakeDb() {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (/from users/i.test(text) && /^\s*select/i.test(text)) {
        return {
          rows: [
            { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com', nickname: '甲', beans: 90000, wins: 2, losses: 1, music_enabled: true, effects_enabled: true, animation_mode: 'light', refill_generation: 0, last_zero_generation: null },
            { id: '00000000-0000-4000-8000-000000000002', email: 'b@example.com', nickname: '乙', beans: 80000, wins: 1, losses: 2, music_enabled: true, effects_enabled: true, animation_mode: 'light', refill_generation: 0, last_zero_generation: null }
          ]
        };
      }
      if (/from global_banners/i.test(text) || /from rooms/i.test(text)) return { rows: [] };
      return { rows: [] };
    },
    async end() {}
  };
}

describe('production runtime persistence', () => {
  it('refuses to start production without PostgreSQL', async () => {
    await expect(createProductionRuntime({ env: { NODE_ENV: 'production' } })).rejects.toThrow(/DATABASE_URL/);
  });

  it('hydrates users and flushes balances, room state, and banners', async () => {
    const db = fakeDb();
    const runtime = await createProductionRuntime({
      db,
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://example.invalid/test', SESSION_SECRET: 'test-only' }
    });

    expect(runtime.store.users.size).toBe(2);
    const room = runtime.roomService.createRoom('00000000-0000-4000-8000-000000000001');
    runtime.store.users.get('00000000-0000-4000-8000-000000000001').beans = 77777;
    runtime.store.banners.push({ id: 1, queueName: 'economy', message: '甲：黄总是大帅比！', createdAt: new Date().toISOString() });

    await runtime.persistence.flushRoom(room.id, 0);

    const sql = db.queries.map((entry) => entry.text).join('\n');
    expect(sql).toMatch(/UPDATE users/i);
    expect(sql).toMatch(/INSERT INTO rooms/i);
    expect(sql).toMatch(/INSERT INTO global_banners/i);
    await runtime.close();
  });

  it('routes room mutations through lifecycle timers and deletes reclaimed snapshots', async () => {
    const deleted = [];
    const persistence = {
      async flushRoom() {},
      async deleteRoom(roomId) { deleted.push(roomId); }
    };
    const app = await buildApp({ logger: false, persistence });
    const firstCookie = await register(app, 'lifecycle-a@example.com', '生命周期甲');
    const secondCookie = await register(app, 'lifecycle-b@example.com', '生命周期乙');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: firstCookie }, payload: {} })).json().room;

    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: secondCookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: firstCookie }, payload: {} });

    expect(app.lifecycle.turnTimers.has(room.id)).toBe(true);
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: firstCookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: secondCookie }, payload: {} });
    expect(deleted).toEqual([room.id]);
    expect(app.lifecycle.turnTimers.has(room.id)).toBe(false);
    await app.close();
  });

  it('persists only durable room state and restores chat as empty memory state', () => {
    const store = {
      users: new Map([
        ['user-a', { id: 'user-a', nickname: '甲', beans: 100000, wins: 0, losses: 0 }],
        ['user-b', { id: 'user-b', nickname: '乙', beans: 100000, wins: 0, losses: 0 }]
      ]),
      sessions: new Map(),
      banners: []
    };
    const service = new RoomService({ store });
    const room = service.createRoom('user-a');
    service.joinRoom(room.id, 'user-b');
    service.addMessage(room.id, 'user-a', '只保留在内存里', { now: 2000 });

    const serialized = serializeRoom(room);
    expect(serialized).not.toHaveProperty('messages');
    expect(serialized).not.toHaveProperty('chatLastAt');
    expect(serialized.events.some((event) => event.eventType === 'chat_message')).toBe(false);
    expect(JSON.stringify(serialized)).not.toMatch(/只保留在内存里|timer|connection|disconnect/i);

    const restored = deserializeRoom(serialized);
    expect(restored.messages).toEqual([]);
    expect(restored.chatLastAt).toBeInstanceOf(Map);
  });
});
