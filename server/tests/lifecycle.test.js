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
});
