import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DoudizhuMutationController } from '../src/doudizhu/mutations.js';
import { createDoudizhuPersistence, serializeRoom } from '../src/doudizhu/persistence.js';
import { DoudizhuService } from '../src/doudizhu/service.js';

function storeWithUsers(...users) {
  return {
    users: new Map(users.map(([id, nickname]) => [id, { id, nickname, beans: 100000, wins: 0, losses: 0, refill_count: 0 }])),
    sessions: new Map(),
    banners: []
  };
}

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

describe('Doudizhu room recovery', () => {
  it('reuses an active room without allocating an orphan', () => {
    const store = storeWithUsers(['u1', '甲']);
    const service = new DoudizhuService({ store });
    const first = service.createRoom('u1', { maxPlayers: 3, baseScore: 100 });
    const resumed = service.createRoom('u1', { maxPlayers: 4, baseScore: 500 });

    expect(resumed).toBe(first);
    expect(service.rooms.size).toBe(1);
    expect(resumed).toMatchObject({ maxPlayers: 3, baseScore: 100 });
    expect(resumed.players.filter((player) => !player.left)).toHaveLength(1);
    expect(resumed.events.filter((event) => event.eventType === 'doudizhu_room_created')).toHaveLength(1);
  });

  it('keeps explicit cross-room joins conflicting and permits creation after leaving', () => {
    const store = storeWithUsers(['u1', '甲'], ['u2', '乙']);
    const service = new DoudizhuService({ store });
    const first = service.createRoom('u1');
    const other = service.createRoom('u2');

    expect(() => service.joinRoom(other.id, 'u1')).toThrow(/账号已在其他斗地主房间/);
    expect(first.players.find((player) => player.userId === 'u1')?.left).toBe(false);
    service.leaveRoom(first.id, 'u1');
    expect(service.createRoom('u1').id).not.toBe(first.id);
  });

  it('rejects ambiguous restored membership instead of choosing a room', () => {
    const store = storeWithUsers(['u1', '甲'], ['u2', '乙']);
    const service = new DoudizhuService({ store });
    const first = service.createRoom('u1');
    const second = service.createRoom('u2');
    second.players.push({ ...first.players[0], id: 'duplicate-player' });

    expect(() => service.activeRoomForUser('u1')).toThrow(/多个斗地主房间/);
    expect(() => service.createRoom('u1')).toThrow(/多个斗地主房间/);
  });

  it('restores room and shared user objects when persistence fails', async () => {
    const store = storeWithUsers(['u1', '甲']);
    const service = new DoudizhuService({ store });
    const room = service.createRoom('u1');
    const roomBeforeMutation = structuredClone(room);
    const originalUser = store.users.get('u1');
    const controller = new DoudizhuMutationController({
      service,
      persistence: { async flushRoom() { throw new Error('database unavailable'); } }
    });

    await expect(controller.mutate(room.id, (current) => {
      originalUser.beans = 1;
      service.touch(current);
    })).rejects.toThrow(/database unavailable/);

    expect(store.users.get('u1')).toBe(originalUser);
    expect(originalUser.beans).toBe(100000);
    expect(service.room(room.id)).toBe(room);
    expect(service.room(room.id)).toEqual(roomBeforeMutation);
  });
});

describe('Doudizhu API persistence boundary', () => {
  it('returns a hydrated production room instead of creating a conflicting room', async () => {
    const app = await buildApp({ logger: false, tournamentScheduler: false });
    const account = await register(app, 'ddz-hydrated@example.com', '生产恢复');
    const sourceService = new DoudizhuService({ store: app.auth.store });
    const persistedRoom = sourceService.createRoom(account.user.id, { maxPlayers: 4, baseScore: 500 });
    await createDoudizhuPersistence({
      db: { async query() { return { rows: [{ state: serializeRoom(persistedRoom) }] }; } },
      service: app.doudizhu
    }).hydrateRooms();

    const response = await app.inject({
      method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: account.cookie },
      payload: { maxPlayers: 2, baseScore: 10 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: false, room: { id: persistedRoom.id, maxPlayers: 4, baseScore: 500 } });
    expect(app.doudizhu.rooms.size).toBe(1);
    await app.close();
  });

  it('serializes simultaneous creates into one created and one resumed response', async () => {
    let releaseFlush;
    let enteredFlush;
    const flushEntered = new Promise((resolve) => { enteredFlush = resolve; });
    const flushGate = new Promise((resolve) => { releaseFlush = resolve; });
    let flushCount = 0;
    const persistence = {
      async flushRoom() {
        flushCount += 1;
        if (flushCount === 1) { enteredFlush(); await flushGate; }
      }
    };
    const app = await buildApp({ logger: false, tournamentScheduler: false, doudizhuPersistence: persistence });
    const account = await register(app, 'ddz-concurrent@example.com', '并发房主');

    const first = app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: account.cookie }, payload: { maxPlayers: 3, baseScore: 100 } });
    await flushEntered;
    const second = app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: account.cookie }, payload: { maxPlayers: 4, baseScore: 500 } });
    releaseFlush();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(responses.map((response) => response.json().room.id)).toEqual([responses[0].json().room.id, responses[0].json().room.id]);
    expect(responses.map((response) => response.json().created).sort()).toEqual([false, true]);
    expect(app.doudizhu.rooms.size).toBe(1);
    expect(flushCount).toBe(1);
    await app.close();
  });

  it('removes a new room when its initial flush fails', async () => {
    const app = await buildApp({
      logger: false, tournamentScheduler: false,
      doudizhuPersistence: { async flushRoom() { throw new Error('create flush failed'); } }
    });
    const account = await register(app, 'ddz-create-fail@example.com', '创建回滚');

    const response = await app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: account.cookie }, payload: {} });

    expect(response.statusCode).toBe(500);
    expect(app.doudizhu.rooms.size).toBe(0);
    await app.close();
  });

  it('rolls back join, action, and final leave when persistence fails', async () => {
    let failFlush = false;
    let failDelete = false;
    const persistence = {
      async flushRoom() { if (failFlush) throw new Error('flush failed'); },
      async deleteRoom() { if (failDelete) throw new Error('delete failed'); }
    };
    const app = await buildApp({ logger: false, tournamentScheduler: false, doudizhuPersistence: persistence });
    const host = await register(app, 'ddz-rollback-host@example.com', '回滚房主');
    const guest = await register(app, 'ddz-rollback-guest@example.com', '回滚客人');
    const created = await app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: host.cookie }, payload: {} });
    const roomId = created.json().room.id;

    failFlush = true;
    const join = await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/join`, headers: { cookie: guest.cookie }, payload: {} });
    expect(join.statusCode).toBe(500);
    expect(app.doudizhu.room(roomId).players.filter((player) => !player.left)).toHaveLength(1);

    const beforeAction = structuredClone(app.doudizhu.room(roomId));
    const action = await app.inject({
      method: 'POST', url: `/api/doudizhu/rooms/${roomId}/actions`, headers: { cookie: host.cookie },
      payload: { action: 'ready', ready: true, version: beforeAction.version }
    });
    expect(action.statusCode).toBe(500);
    expect(app.doudizhu.room(roomId)).toEqual(beforeAction);

    failFlush = false;
    failDelete = true;
    const failedLeave = await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/leave`, headers: { cookie: host.cookie }, payload: {} });
    expect(failedLeave.statusCode).toBe(500);
    expect(app.doudizhu.room(roomId).players.find((player) => player.userId === host.user.id)?.left).toBe(false);

    failDelete = false;
    const left = await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/leave`, headers: { cookie: host.cookie }, payload: {} });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toMatchObject({ ok: true, deleted: true });
    expect(app.doudizhu.rooms.has(roomId)).toBe(false);
    await app.close();
  });

  it('returns the current room and prevents non-members from triggering progress', async () => {
    let flushCount = 0;
    const app = await buildApp({
      logger: false, tournamentScheduler: false,
      doudizhuPersistence: { async flushRoom() { flushCount += 1; } }
    });
    const host = await register(app, 'ddz-current-host@example.com', '恢复房主');
    const outsider = await register(app, 'ddz-current-outsider@example.com', '外部用户');
    const created = await app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: host.cookie }, payload: {} });
    const room = app.doudizhu.room(created.json().room.id);
    room.status = 'playing';
    let progressCalls = 0;
    app.doudizhu.autoProgress = () => { progressCalls += 1; app.doudizhu.touch(room); return room; };

    const directory = await app.inject({ method: 'GET', url: '/api/doudizhu/rooms', headers: { cookie: host.cookie } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().currentRoom.id).toBe(room.id);
    expect(directory.json().rooms).toContainEqual(expect.objectContaining({ id: room.id, isMember: true }));

    const beforeUnauthorized = flushCount;
    const denied = await app.inject({ method: 'GET', url: `/api/doudizhu/rooms/${room.id}`, headers: { cookie: outsider.cookie } });
    expect(denied.statusCode).toBe(403);
    expect(progressCalls).toBe(0);
    expect(flushCount).toBe(beforeUnauthorized);
    await app.close();
  });

  it('rejects actions from a departed player before changing or flushing the room', async () => {
    let flushCount = 0;
    const app = await buildApp({
      logger: false, tournamentScheduler: false,
      doudizhuPersistence: {
        async flushRoom() { flushCount += 1; },
        async deleteRoom() {}
      }
    });
    const host = await register(app, 'ddz-departed-host@example.com', '退出房主');
    const guest = await register(app, 'ddz-departed-guest@example.com', '留守玩家');
    const created = await app.inject({ method: 'POST', url: '/api/doudizhu/rooms', headers: { cookie: host.cookie }, payload: {} });
    const roomId = created.json().room.id;
    await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/join`, headers: { cookie: guest.cookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/actions`, headers: { cookie: host.cookie }, payload: { action: 'ready', ready: true } });
    await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/actions`, headers: { cookie: guest.cookie }, payload: { action: 'ready', ready: true } });
    await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/actions`, headers: { cookie: host.cookie }, payload: { action: 'start' } });
    const left = await app.inject({ method: 'POST', url: `/api/doudizhu/rooms/${roomId}/leave`, headers: { cookie: host.cookie }, payload: {} });
    expect(left.statusCode).toBe(200);

    const beforeAction = structuredClone(app.doudizhu.room(roomId));
    const beforeFlush = flushCount;
    const denied = await app.inject({
      method: 'POST', url: `/api/doudizhu/rooms/${roomId}/actions`, headers: { cookie: host.cookie },
      payload: { action: 'bid', choice: false, version: beforeAction.version }
    });

    expect(denied.statusCode).toBe(403);
    expect(app.doudizhu.room(roomId)).toEqual(beforeAction);
    expect(flushCount).toBe(beforeFlush);
    await app.close();
  });
});
