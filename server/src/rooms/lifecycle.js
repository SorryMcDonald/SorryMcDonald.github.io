import { TURN_TIMEOUT_MS } from './service.js';

export const DISCONNECT_GRACE_MS = 60_000;

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle)
};

function connectionKey(roomId, userId) {
  return `${roomId}:${userId}`;
}

function isMissingRoom(error) {
  return error?.statusCode === 404 && error?.message === '房间不存在';
}

export class RoomLifecycleController {
  constructor({ service, persistence, broadcastRoom, broadcastGlobal, clock = systemClock } = {}) {
    this.service = service;
    this.persistence = persistence;
    this.broadcastRoom = broadcastRoom;
    this.broadcastGlobal = broadcastGlobal;
    this.clock = clock;
    this.queues = new Map();
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.connections = new Map();
  }

  setBroadcasters({ room, global } = {}) {
    if (room) this.broadcastRoom = room;
    if (global) this.broadcastGlobal = global;
  }

  run(roomId, mutation) {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const execution = previous.catch(() => {}).then(mutation);
    this.queues.set(roomId, execution);
    execution.finally(() => {
      if (this.queues.get(roomId) === execution) this.queues.delete(roomId);
    }).catch(() => {});
    return execution;
  }

  idle(roomId) {
    return this.queues.get(roomId) ?? Promise.resolve();
  }

  async mutate(roomId, mutation) {
    return this.run(roomId, async () => {
      let beforeRoom;
      try {
        beforeRoom = this.service.room(roomId);
      } catch (error) {
        if (isMissingRoom(error)) return undefined;
        throw error;
      }
      const afterEventId = beforeRoom.eventSeq;
      const afterBannerCount = this.service.store?.banners?.length ?? 0;
      const value = await mutation();
      let room;
      try {
        room = this.service.room(roomId);
      } catch (error) {
        if (!isMissingRoom(error)) throw error;
      }

      if (room) {
        await this.persistence?.flushRoom(room.id, afterBannerCount);
        this.broadcastEvents(room, afterEventId);
        this.broadcastBanners(afterBannerCount);
        this.scheduleTurn(room);
      } else {
        await this.persistence?.deleteRoom?.(roomId, afterBannerCount);
        this.broadcastEvents(beforeRoom, afterEventId);
        this.cancelRoom(roomId);
      }
      return value;
    });
  }

  broadcastEvents(room, afterEventId) {
    if (!this.broadcastRoom) return;
    for (const event of room.events.filter((entry) => entry.id > afterEventId)) {
      this.broadcastRoom(room.id, event);
    }
  }

  broadcastBanners(afterBannerCount) {
    if (!this.broadcastGlobal) return;
    for (const banner of (this.service.store?.banners ?? []).slice(afterBannerCount)) {
      this.broadcastGlobal(banner);
    }
  }

  restoreAll() {
    for (const room of this.service.rooms.values()) this.restoreRoom(room.id);
  }

  restoreRoom(roomId) {
    let room;
    try {
      room = this.service.room(roomId);
    } catch (error) {
      if (isMissingRoom(error)) return;
      throw error;
    }
    this.scheduleTurn(room);
  }

  scheduleTurn(room) {
    this.cancelTurn(room.id);
    if (room.status !== 'betting' || room.currentTurn < 0 || !room.turnDeadlineAt || !room.round?.id) return;
    const player = [...room.players.values()].find((candidate) => candidate.seat === room.currentTurn && candidate.inRound && !candidate.folded && !candidate.allIn && !candidate.left);
    if (!player) return;
    const binding = {
      roomId: room.id,
      version: room.version,
      roundId: room.round.id,
      seat: room.currentTurn,
      actionSeq: player.actionSeq,
      deadlineAt: room.turnDeadlineAt
    };
    const delay = Math.max(0, new Date(binding.deadlineAt).getTime() - this.clock.now());
    const handle = this.clock.setTimeout(async () => {
      const current = this.turnTimers.get(room.id);
      if (!current || current.binding !== binding) return;
      this.turnTimers.delete(room.id);
      await this.mutate(room.id, () => {
        const latest = this.service.room(room.id);
        if (latest.version !== binding.version
          || latest.round?.id !== binding.roundId
          || latest.currentTurn !== binding.seat) return latest;
        const latestPlayer = [...latest.players.values()].find((candidate) => candidate.seat === binding.seat);
        if (!latestPlayer || latestPlayer.actionSeq !== binding.actionSeq) return latest;
        return this.service.timeoutFold(room.id, { ...binding, now: this.clock.now() });
      });
    }, delay);
    handle?.unref?.();
    this.turnTimers.set(room.id, { handle, binding });
  }

  cancelTurn(roomId) {
    const timer = this.turnTimers.get(roomId);
    if (!timer) return;
    this.clock.clearTimeout(timer.handle);
    this.turnTimers.delete(roomId);
  }

  connected(roomId, userId) {
    const key = connectionKey(roomId, userId);
    this.connections.set(key, (this.connections.get(key) ?? 0) + 1);
    const departure = this.disconnectTimers.get(key);
    if (departure) {
      this.clock.clearTimeout(departure.handle);
      this.disconnectTimers.delete(key);
    }
  }

  disconnected(roomId, userId) {
    const key = connectionKey(roomId, userId);
    const count = Math.max(0, (this.connections.get(key) ?? 0) - 1);
    if (count > 0) {
      this.connections.set(key, count);
      return;
    }
    this.connections.delete(key);
    if (this.disconnectTimers.has(key)) return;
    const token = Symbol(key);
    const handle = this.clock.setTimeout(async () => {
      const current = this.disconnectTimers.get(key);
      if (!current || current.token !== token || (this.connections.get(key) ?? 0) > 0) return;
      this.disconnectTimers.delete(key);
      await this.mutate(roomId, () => this.service.leaveRoom(roomId, userId, { now: this.clock.now() }));
    }, DISCONNECT_GRACE_MS);
    handle?.unref?.();
    this.disconnectTimers.set(key, { handle, token, roomId, userId });
  }

  cancelRoom(roomId) {
    this.cancelTurn(roomId);
    for (const [key, timer] of this.disconnectTimers) {
      if (timer.roomId !== roomId) continue;
      this.clock.clearTimeout(timer.handle);
      this.disconnectTimers.delete(key);
      this.connections.delete(key);
    }
  }

  close() {
    for (const roomId of [...this.turnTimers.keys()]) this.cancelTurn(roomId);
    for (const timer of this.disconnectTimers.values()) this.clock.clearTimeout(timer.handle);
    this.disconnectTimers.clear();
    this.connections.clear();
  }
}

export { TURN_TIMEOUT_MS };
