import { describe, expect, it } from 'vitest';
import { createDoudizhuPersistence } from '../src/doudizhu/persistence.js';
import { DoudizhuService } from '../src/doudizhu/service.js';

function makeStore(userId = '00000000-0000-4000-8000-000000000001') {
  return {
    users: new Map([[userId, { id: userId, nickname: '持久化玩家', beans: 100000, wins: 0, losses: 0, refill_count: 0 }]]),
    sessions: new Map(),
    banners: []
  };
}

function stateDb(initialRows = []) {
  let rows = initialRows;
  const queries = [];
  return {
    queries,
    setRows(value) { rows = value; },
    async query(text, values = []) {
      queries.push({ text, values });
      if (/^\s*select state from doudizhu_rooms/i.test(text)) return { rows };
      if (/insert into doudizhu_rooms/i.test(text)) rows = [{ state: structuredClone(values[7]) }];
      return { rows: [] };
    }
  };
}

describe('Doudizhu persistence', () => {
  it('round-trips an active room and resumes it after hydration', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const db = stateDb();
    const firstStore = makeStore(userId);
    const firstService = new DoudizhuService({ store: firstStore });
    const firstPersistence = createDoudizhuPersistence({ db, service: firstService });
    const room = firstService.createRoom(userId, { maxPlayers: 4, baseScore: 500 });
    await firstPersistence.flushRoom(room.id);

    const secondStore = makeStore(userId);
    const secondService = new DoudizhuService({ store: secondStore });
    await createDoudizhuPersistence({ db, service: secondService }).hydrateRooms();

    const restored = secondService.room(room.id);
    expect(restored.spectators).toBeInstanceOf(Set);
    expect(secondService.snapshot(restored.id, userId)).toMatchObject({ id: room.id, maxPlayers: 4, baseScore: 500 });
    expect(secondService.createRoom(userId)).toBe(restored);
    expect(secondService.rooms.size).toBe(1);
    expect(db.queries.map((entry) => entry.text).join('\n')).toMatch(/BEGIN[\s\S]*UPDATE users[\s\S]*INSERT INTO doudizhu_rooms[\s\S]*COMMIT/i);
  });

  it('ignores malformed, closed, and all-left historical snapshots', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const emptyRoom = {
      id: '00000000-0000-4000-8000-000000000010', code: '123456', version: 2,
      status: 'waiting', players: [{ userId, left: true }], spectators: [], events: []
    };
    const closedRoom = { ...emptyRoom, id: '00000000-0000-4000-8000-000000000011', status: 'closed', players: [{ userId, left: false }] };
    const db = stateDb([{ state: null }, { state: {} }, { state: emptyRoom }, { state: closedRoom }]);
    const service = new DoudizhuService({ store: makeStore(userId) });

    await createDoudizhuPersistence({ db, service }).hydrateRooms();

    expect(service.rooms.size).toBe(0);
  });
});
