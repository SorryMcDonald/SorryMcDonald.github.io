import { describe, expect, it } from 'vitest';
import { createProductionRuntime } from '../src/runtime.js';

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
});
