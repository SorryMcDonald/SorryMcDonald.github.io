import { describe, expect, it } from 'vitest';
import { RoomLifecycleController } from '../src/rooms/lifecycle.js';
import { RoomService } from '../src/rooms/service.js';

class FakeClock {
  constructor(start = 0) {
    this.time = start;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { id, at: this.time + Math.max(0, Number(delay)), callback });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  async advanceBy(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.tasks.values()].filter((task) => task.at <= target).sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.tasks.delete(next.id);
      this.time = next.at;
      await next.callback();
    }
    this.time = target;
  }
}

function fixture(playerCount = 2) {
  const users = new Map();
  for (let index = 0; index < playerCount; index += 1) {
    users.set(`user-${index}`, { id: `user-${index}`, nickname: `玩家${index}`, beans: 100000, wins: 0, losses: 0 });
  }
  const store = { users, sessions: new Map(), banners: [] };
  const service = new RoomService({ store });
  const room = service.createRoom('user-0');
  for (let index = 1; index < playerCount; index += 1) service.joinRoom(room.id, `user-${index}`);
  return { service, store, room };
}

describe('RoomLifecycleController', () => {
  it('folds the current player through the normal transition after 60 seconds', async () => {
    const clock = new FakeClock(1000);
    const { service, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    const current = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    const lifecycle = new RoomLifecycleController({ service, clock });
    lifecycle.restoreRoom(room.id);

    await clock.advanceBy(59_999);
    expect(current.folded).toBe(false);
    await clock.advanceBy(1);
    await lifecycle.idle(room.id);

    expect(current.folded).toBe(true);
    expect(current.lastAction).toBe('timeout_fold');
    expect(room.status).toBe('settled');
    expect(room.events.some((event) => event.payload?.action === 'timeout_fold')).toBe(true);
  });

  it('cancels a stale turn task after a valid action moves the deadline', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    const lifecycle = new RoomLifecycleController({ service, clock });
    lifecycle.restoreRoom(room.id);

    await clock.advanceBy(30_000);
    const first = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    await lifecycle.mutate(room.id, () => service.action(room.id, first.userId, { action: 'call', actionSeq: 1, now: clock.now() }));
    const second = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    await clock.advanceBy(30_000);

    expect(second.folded).toBe(false);
    expect(room.status).toBe('betting');
  });

  it('reschedules a timeout after persistence rollback with a bounded retry delay', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    let failOnce = true;
    const lifecycle = new RoomLifecycleController({
      service,
      clock,
      persistence: {
        async flushRoom() {
          if (failOnce) {
            failOnce = false;
            throw new Error('temporary persistence failure');
          }
        }
      }
    });
    const current = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    lifecycle.restoreRoom(room.id);

    await expect(clock.advanceBy(60_000)).resolves.toBeUndefined();
    expect([...room.players.values()].find((player) => player.id === current.id).folded).toBe(false);
    expect([...clock.tasks.values()].map((task) => task.at)).toEqual([61_000]);
    await clock.advanceBy(999);
    expect([...room.players.values()].find((player) => player.id === current.id).folded).toBe(false);
    await clock.advanceBy(1);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].find((player) => player.id === current.id).folded).toBe(true);
  });

  it('caps timeout persistence retries with exponential backoff', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    let flushes = 0;
    const errors = [];
    const lifecycle = new RoomLifecycleController({
      service,
      clock,
      onError: (error) => errors.push(error),
      persistence: { async flushRoom() { flushes += 1; throw new Error('database unavailable'); } }
    });
    lifecycle.restoreRoom(room.id);

    await expect(clock.advanceBy(100_000)).resolves.toBeUndefined();

    expect(flushes).toBe(6);
    expect(clock.tasks.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('starts disconnect grace only after the final socket and cancels it on reconnect', async () => {
    const clock = new FakeClock(10_000);
    const { service, room } = fixture(2);
    const lifecycle = new RoomLifecycleController({ service, clock });
    lifecycle.connected(room.id, 'user-0');
    lifecycle.connected(room.id, 'user-0');
    lifecycle.disconnected(room.id, 'user-0');
    await clock.advanceBy(60_000);
    expect([...room.players.values()].find((player) => player.userId === 'user-0').left).toBe(false);

    lifecycle.disconnected(room.id, 'user-0');
    await clock.advanceBy(59_999);
    lifecycle.connected(room.id, 'user-0');
    await clock.advanceBy(1);
    expect([...room.players.values()].find((player) => player.userId === 'user-0').left).toBe(false);

    lifecycle.disconnected(room.id, 'user-0');
    await clock.advanceBy(60_000);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].find((player) => player.userId === 'user-0').left).toBe(true);
  });

  it('reschedules an expired disconnect after persistence rollback with a bounded retry delay', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(2);
    let failOnce = true;
    const lifecycle = new RoomLifecycleController({
      service,
      clock,
      persistence: {
        async flushRoom() {
          if (failOnce) {
            failOnce = false;
            throw new Error('temporary persistence failure');
          }
        }
      }
    });
    const player = [...room.players.values()].find((candidate) => candidate.userId === 'user-0');
    lifecycle.connected(room.id, player.userId);
    lifecycle.disconnected(room.id, player.userId);

    await expect(clock.advanceBy(60_000)).resolves.toBeUndefined();
    expect([...room.players.values()].find((candidate) => candidate.id === player.id).left).toBe(false);
    expect([...clock.tasks.values()].map((task) => task.at)).toEqual([61_000]);
    await clock.advanceBy(999);
    expect([...room.players.values()].find((candidate) => candidate.id === player.id).left).toBe(false);
    await clock.advanceBy(1);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].find((candidate) => candidate.id === player.id).left).toBe(true);
  });

  it('reclaims an empty room and turns old tasks into no-ops', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(1);
    const lifecycle = new RoomLifecycleController({ service, clock });
    lifecycle.connected(room.id, 'user-0');
    lifecycle.disconnected(room.id, 'user-0');
    await clock.advanceBy(60_000);
    await lifecycle.idle(room.id);

    expect(service.rooms.has(room.id)).toBe(false);
    expect(room.messages).toEqual([]);
    await clock.advanceBy(60_000);
    expect(service.rooms.has(room.id)).toBe(false);
  });

  it('restores room and economy state when persistence fails after a mutation', async () => {
    const clock = new FakeClock(5000);
    const { service, store, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    const current = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    const before = {
      beans: store.users.get(current.userId).beans,
      currentTurn: room.currentTurn,
      eventSeq: room.eventSeq,
      version: room.version,
      turnDeadlineAt: room.turnDeadlineAt
    };
    const lifecycle = new RoomLifecycleController({
      service,
      clock,
      persistence: { async flushRoom() { throw new Error('flush failed'); } }
    });

    await expect(lifecycle.mutate(room.id, () => service.action(room.id, current.userId, { action: 'call', actionSeq: 1, now: clock.now() }))).rejects.toThrow(/flush failed/);

    expect(store.users.get(current.userId).beans).toBe(before.beans);
    expect(room).toMatchObject({
      currentTurn: before.currentTurn,
      eventSeq: before.eventSeq,
      version: before.version,
      turnDeadlineAt: before.turnDeadlineAt
    });
    expect(room.players.get(current.id).actionSeq).toBe(0);
  });

  it('does not deep-clone immutable historical events for rollback', async () => {
    const { service, room } = fixture(2);
    room.events.push({ id: 999, eventType: 'historical', payload: { unsupportedCloneValue() {} } });
    const lifecycle = new RoomLifecycleController({
      service,
      persistence: { async flushRoom() { throw new Error('flush failed'); } }
    });

    await expect(lifecycle.mutate(room.id, () => { room.status = 'broken'; })).rejects.toThrow(/flush failed/);

    expect(room.status).toBe('waiting');
    expect(room.events.at(-1)?.eventType).toBe('historical');
  });

  it('preserves a banner appended by another operation while persistence is pending', async () => {
    const { service, store, room } = fixture(2);
    let rejectFlush;
    let flushStarted;
    const started = new Promise((resolve) => { flushStarted = resolve; });
    const lifecycle = new RoomLifecycleController({
      service,
      persistence: {
        flushRoom() {
          flushStarted();
          return new Promise((resolve, reject) => { rejectFlush = reject; });
        }
      }
    });
    const mutation = lifecycle.mutate(room.id, () => { room.status = 'changed'; });
    await started;
    const concurrent = { id: 9999, queueName: 'leaderboard', message: '其他房间横幅' };
    store.banners.push(concurrent);
    rejectFlush(new Error('flush failed'));

    await expect(mutation).rejects.toThrow(/flush failed/);
    expect(store.banners).toContain(concurrent);
  });

  it('persists banners created after an asynchronous mutation boundary', async () => {
    const { service, store, room } = fixture(2);
    let persistedBanners;
    const lifecycle = new RoomLifecycleController({
      service,
      persistence: {
        async flushRoom(roomId, bannerStart, banners) {
          persistedBanners = banners;
        }
      }
    });
    const banner = { id: 1001, queueName: 'leaderboard', message: '异步横幅' };

    await lifecycle.mutate(room.id, async () => {
      await Promise.resolve();
      store.banners.push(banner);
      return room;
    });

    expect(persistedBanners).toEqual([banner]);
  });

  it('rolls back banners created before an asynchronous mutation rejects', async () => {
    const { service, store, room } = fixture(2);
    const lifecycle = new RoomLifecycleController({ service });
    const banner = { id: 1002, queueName: 'leaderboard', message: '异步回滚横幅' };

    await expect(lifecycle.mutate(room.id, async () => {
      await Promise.resolve();
      store.banners.push(banner);
      throw new Error('asynchronous mutation failed');
    })).rejects.toThrow(/asynchronous mutation failed/);

    expect(store.banners).not.toContain(banner);
  });

  it('supports a partial persistence adapter without flushRoom', async () => {
    const { service, room } = fixture(2);
    const lifecycle = new RoomLifecycleController({ service, persistence: { async flushStore() {} } });

    await expect(lifecycle.mutate(room.id, () => { room.status = 'changed'; })).resolves.toBeUndefined();
    expect(room.status).toBe('changed');
  });

  it('restores partial in-memory changes when a mutation throws', async () => {
    const { service, room } = fixture(2);
    const lifecycle = new RoomLifecycleController({ service });
    const beforeEventSeq = room.eventSeq;

    await expect(lifecycle.mutate(room.id, () => {
      room.status = 'broken';
      room.eventSeq += 1;
      throw new Error('mutation failed');
    })).rejects.toThrow(/mutation failed/);

    expect(room.status).toBe('waiting');
    expect(room.eventSeq).toBe(beforeEventSeq);
  });

  it('canonicalizes room-code mutations and snapshots only affected users', async () => {
    const { service, store, room } = fixture(2);
    store.users.set('unrelated', { id: 'unrelated', nickname: '无关账号', beans: 1, unsupportedCloneValue() {} });
    const lifecycle = new RoomLifecycleController({ service });

    await lifecycle.mutate(room.code, () => { room.status = 'changed'; });
    expect(room.status).toBe('changed');
    await expect(lifecycle.mutate(room.code, () => {
      room.status = 'broken';
      throw new Error('rollback');
    })).rejects.toThrow(/rollback/);

    expect(room.status).toBe('changed');
    expect(service.rooms.has(room.id)).toBe(true);
    expect(service.rooms.has(room.code)).toBe(false);
  });

  it('deletes reclaimed persistence by canonical room id', async () => {
    const { service, room } = fixture(2);
    const deleted = [];
    const lifecycle = new RoomLifecycleController({
      service,
      persistence: { async deleteRoom(roomId) { deleted.push(roomId); } }
    });

    await lifecycle.mutate(room.code, () => service.reclaimRoom(room.id));

    expect(deleted).toEqual([room.id]);
    expect(service.rooms.has(room.id)).toBe(false);
  });

  it('reports post-commit cleanup failures without rejecting a reclaimed room', async () => {
    const { service, room } = fixture(1);
    const errors = [];
    let socketsReclaimed = false;
    const lifecycle = new RoomLifecycleController({
      service,
      persistence: { async deleteRoom() {} },
      reclaimRoomSockets() {
        socketsReclaimed = true;
        throw new Error('socket cleanup failed');
      },
      onError(error) { errors.push(error.message); }
    });
    lifecycle.cancelRoom = () => { throw new Error('timer cleanup failed'); };

    await expect(lifecycle.mutate(room.id, () => service.reclaimRoom(room.id))).resolves.toBe(true);

    expect(socketsReclaimed).toBe(true);
    expect(errors).toEqual(['timer cleanup failed', 'socket cleanup failed']);
    expect(service.rooms.has(room.id)).toBe(false);
  });

  it('waits for queued mutations before closing', async () => {
    const { service, room } = fixture(2);
    const lifecycle = new RoomLifecycleController({ service });
    let release;
    const pending = lifecycle.run(room.id, () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();

    let closed = false;
    const closing = Promise.resolve(lifecycle.close()).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await pending;
    await closing;
    expect(closed).toBe(true);
  });

  it('does not recreate lifecycle timers while close drains a mutation', async () => {
    const clock = new FakeClock(0);
    const { service, room } = fixture(2);
    service.startNextRound(room.id, 'user-0', { now: clock.now() });
    let releaseFlush;
    let flushStarted;
    const started = new Promise((resolve) => { flushStarted = resolve; });
    const lifecycle = new RoomLifecycleController({
      service,
      clock,
      persistence: {
        flushRoom() {
          flushStarted();
          return new Promise((resolve) => { releaseFlush = resolve; });
        }
      }
    });
    const current = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    const mutation = lifecycle.mutate(room.id, () => service.action(room.id, current.userId, {
      action: 'call', actionSeq: 1, now: clock.now()
    }));
    await started;

    const closing = lifecycle.close();
    releaseFlush();
    await mutation;
    await closing;

    expect(clock.tasks.size).toBe(0);
    expect(lifecycle.turnTimers.size).toBe(0);
    expect(lifecycle.disconnectTimers.size).toBe(0);
  });
});
