import { describe, expect, it } from 'vitest';
import { TEXAS_DISCONNECT_GRACE_MS, TexasLifecycleController } from '../src/texas/lifecycle.js';
import { TexasService } from '../src/texas/service.js';

class FakeClock {
  constructor(start = 0) { this.time = start; this.nextId = 1; this.tasks = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay) => { const id = this.nextId++; this.tasks.set(id, { id, at:this.time + Number(delay), callback }); return id; };
  clearTimeout = (id) => this.tasks.delete(id);
  async advanceBy(milliseconds) {
    const target = this.time + milliseconds;
    for (let iterations = 0; ; iterations += 1) {
      if (iterations > 10_000) throw new Error('FakeClock.advanceBy exceeded 10000 timer callbacks');
      const task = [...this.tasks.values()].filter((value) => value.at <= target).sort((a,b) => a.at - b.at || a.id - b.id)[0];
      if (!task) break;
      this.tasks.delete(task.id); this.time = task.at; await task.callback();
    }
    this.time = target;
  }
}

function fixture() {
  const users = new Map([
    ['u0', { id:'u0', nickname:'甲', beans:100000, wins:0, losses:0 }],
    ['u1', { id:'u1', nickname:'乙', beans:100000, wins:0, losses:0 }]
  ]);
  const store = { users, banners:[] };
  const clock = new FakeClock(1000);
  const service = new TexasService({ store, clock });
  const room = service.createRoom('u0', { buyIn:1000 });
  service.joinRoom(room.id, 'u1', { buyIn:1000 });
  return { clock, service, room };
}

describe('TexasLifecycleController', () => {
  it('folds the bound current player exactly at the sixty-second deadline', async () => {
    const { clock, service, room } = fixture();
    service.startHand(room.id, 'u0');
    const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    const lifecycle = new TexasLifecycleController({ service, clock });
    lifecycle.restoreAll();

    await clock.advanceBy(59_999);
    expect(actor.folded).toBe(false);
    await clock.advanceBy(1);
    await lifecycle.idle(room.id);

    expect(actor.folded).toBe(true);
    expect(actor.lastAction).toBe('timeout');
  });

  it('retries a timed-out action after one persistence rollback', async () => {
    const { clock, service, room } = fixture();
    service.startHand(room.id, 'u0');
    const actorId = [...room.players.values()].find((player) => player.seat === room.currentTurn).id;
    let failOnce = true;
    const lifecycle = new TexasLifecycleController({
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
    lifecycle.scheduleTurn(room);

    await clock.advanceBy(60_000);
    expect([...service.room(room.id).players.values()].find((player) => player.id === actorId).folded).toBe(false);
    expect([...clock.tasks.values()].map((task) => task.at)).toEqual([62_000]);

    await clock.advanceBy(1_000);
    await lifecycle.idle(room.id);
    expect([...service.room(room.id).players.values()].find((player) => player.id === actorId).folded).toBe(true);
  });

  it('caps timed-out action persistence retries and reports the final failure', async () => {
    const { clock, service, room } = fixture();
    service.startHand(room.id, 'u0');
    let flushes = 0;
    const errors = [];
    const lifecycle = new TexasLifecycleController({
      service,
      clock,
      onError: (error) => errors.push(error),
      persistence: { async flushRoom() { flushes += 1; throw new Error('database unavailable'); } }
    });
    lifecycle.scheduleTurn(room);

    await clock.advanceBy(100_000);

    expect(flushes).toBe(6);
    expect(clock.tasks.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('waits for every browser tab to close, cancels on reconnect, then cashes out after the grace period', async () => {
    const { clock, service, room } = fixture();
    const lifecycle = new TexasLifecycleController({ service, clock });
    lifecycle.connected(room.id, 'u0');
    lifecycle.connected(room.id, 'u0');
    lifecycle.disconnected(room.id, 'u0');
    await clock.advanceBy(60_000);
    expect([...room.players.values()].find((player) => player.userId === 'u0').left).toBe(false);
    lifecycle.disconnected(room.id, 'u0');
    await clock.advanceBy(59_999);
    lifecycle.connected(room.id, 'u0');
    await clock.advanceBy(1);
    expect([...room.players.values()].find((player) => player.userId === 'u0').left).toBe(false);
    lifecycle.disconnected(room.id, 'u0');
    await clock.advanceBy(60_000);
    await lifecycle.idle(room.id);
    expect([...room.players.values()].find((player) => player.userId === 'u0').left).toBe(true);
  });

  it('clears a stale disconnect timer when a connection is already present', async () => {
    const { clock, service, room } = fixture();
    const lifecycle = new TexasLifecycleController({ service, clock });
    lifecycle.scheduleDisconnect(room.id, 'u0');
    expect(lifecycle.disconnectTimers).toHaveProperty('size', 1);
    lifecycle.connected(room.id, 'u0');
    lifecycle.scheduleDisconnect(room.id, 'u0');
    expect(lifecycle.disconnectTimers).toHaveProperty('size', 0);
    await clock.advanceBy(TEXAS_DISCONNECT_GRACE_MS);
    expect([...room.players.values()].find((player) => player.userId === 'u0').left).toBe(false);
  });

  it('waits for an in-flight mutation before closing and rejects new mutations', async () => {
    const { service, room } = fixture();
    const lifecycle = new TexasLifecycleController({ service });
    let release;
    const pending = lifecycle.run(room.id, () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();

    const closing = lifecycle.close();
    await expect(lifecycle.mutate(room.id, () => undefined)).rejects.toMatchObject({ statusCode: 503 });
    let closed = false;
    closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await pending;
    await closing;
    expect(closed).toBe(true);
  });

  it('restores users in place when a mutation rolls back', async () => {
    const { service, room } = fixture();
    const users = service.store.users;
    const user = users.get('u0');
    const beans = user.beans;
    const lifecycle = new TexasLifecycleController({ service });

    await expect(lifecycle.mutate(room.id, () => {
      user.beans = 1;
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    expect(service.store.users).toBe(users);
    expect(service.store.users.get('u0')).toBe(user);
    expect(user.beans).toBe(beans);
  });

  it('does not roll back a committed mutation when post-commit broadcast fails', async () => {
    const { service, room } = fixture();
    let flushes = 0;
    const lifecycle = new TexasLifecycleController({
      service,
      persistence: { async flushRoom() { flushes += 1; } },
      broadcastRoom() { throw new Error('socket closed during broadcast'); }
    });

    await expect(lifecycle.mutate(room.id, () => service.startHand(room.id, 'u0'))).resolves.toBeDefined();
    expect(flushes).toBe(1);
    expect(service.room(room.id).status).not.toBe('waiting');
  });

  it('reclaims a Texas room immediately after its last player leaves', async () => {
    const { service, room } = fixture();
    const deleted = [];
    const lifecycle = new TexasLifecycleController({
      service,
      persistence: { async flushRoom() {}, async deleteRoom(roomId) { deleted.push(roomId); } }
    });

    await lifecycle.mutate(room.id, () => service.leaveRoom(room.id, 'u0'));
    expect(service.rooms.has(room.id)).toBe(true);
    await lifecycle.mutate(room.id, () => service.leaveRoom(room.id, 'u1'));

    expect(service.rooms.has(room.id)).toBe(false);
    expect(deleted).toEqual([room.id]);
  });

  it('does not resurrect a room when the mutation itself reclaims it', async () => {
    const { service, room } = fixture();
    const deleted = [];
    const lifecycle = new TexasLifecycleController({
      service,
      persistence: { async deleteRoom(roomId) { deleted.push(roomId); } }
    });

    room.players.clear();
    await expect(lifecycle.mutate(room.id, () => service.reclaimRoom(room.id))).resolves.toBe(true);
    expect(service.rooms.has(room.id)).toBe(false);
    expect(deleted).toEqual([room.id]);
  });

  it('reports a disconnect mutation failure after bounded retries', async () => {
    const { clock, service, room } = fixture();
    const errors = [];
    const lifecycle = new TexasLifecycleController({
      service,
      clock,
      onError: (error) => errors.push(error),
      persistence: { async flushRoom() { throw new Error('database unavailable'); } }
    });

    lifecycle.disconnected(room.id, 'u0');
    await clock.advanceBy(TEXAS_DISCONNECT_GRACE_MS + 31_000);
    expect(errors).toHaveLength(1);
  });
});
