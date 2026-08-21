import { TURN_TIMEOUT_MS } from './service.js';
import { mutationQueueFor } from '../persistence/mutation-queue.js';

export const DISCONNECT_GRACE_MS = 60_000;
export const PERSISTENCE_RETRY_MS = 1_000;
export const PERSISTENCE_RETRY_LIMIT = 5;
export const PERSISTENCE_RETRY_MAX_MS = 16_000;

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

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) {
    if (!(key in snapshot)) delete target[key];
  }
  Object.assign(target, structuredClone(snapshot));
}

function captureMutationState(service, room, affectedUserIds = []) {
  const { events, ...roomWithoutEvents } = room;
  const userIds = new Set([
    ...[...room.players.values()].map((player) => player.userId),
    ...affectedUserIds
  ]);
  return {
    room: structuredClone(roomWithoutEvents),
    events: events ?? [],
    eventCount: events?.length ?? 0,
    users: new Map([...userIds].flatMap((id) => {
      const user = service.store.users.get(id);
      return user ? [[id, structuredClone(user)]] : [];
    }))
  };
}

function restoreMutationState(service, roomId, room, snapshot, createdBanners) {
  snapshot.events.length = snapshot.eventCount;
  restoreObject(room, snapshot.room);
  room.events = snapshot.events;
  service.rooms.set(roomId, room);
  for (const [id, userSnapshot] of snapshot.users) {
    const user = service.store.users.get(id);
    if (user) restoreObject(user, userSnapshot);
    else service.store.users.set(id, structuredClone(userSnapshot));
  }
  const banners = service.store.banners ?? [];
  for (const banner of createdBanners) {
    const index = banners.indexOf(banner);
    if (index >= 0) banners.splice(index, 1);
  }
}

function persistenceRetryDelay(retryAttempt) {
  return Math.min(PERSISTENCE_RETRY_MS * (2 ** retryAttempt), PERSISTENCE_RETRY_MAX_MS);
}

export class RoomLifecycleController {
  constructor({ service, persistence, broadcastRoom, broadcastGlobal, reclaimRoomSockets, clock, autoTimeout = true, onError, mutationQueue } = {}) {
    this.service = service;
    this.persistence = persistence;
    this.broadcastRoom = broadcastRoom;
    this.broadcastGlobal = broadcastGlobal;
    this.reclaimRoomSockets = reclaimRoomSockets;
    this.mutationQueue = mutationQueue ?? mutationQueueFor(service?.store);
    const sourceClock = clock ?? systemClock;
    this.clock = {
      now: (...args) => sourceClock.now(...args),
      setTimeout: (...args) => sourceClock.setTimeout(...args),
      clearTimeout: (...args) => sourceClock.clearTimeout(...args)
    };
    this.autoTimeout = Boolean(autoTimeout);
    this.onError = onError;
    this.queues = new Map();
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.connections = new Map();
    this.closing = false;
  }

  reportError(error) {
    try { this.onError?.(error); } catch {}
  }

  setBroadcasters({ room, global, reclaim } = {}) {
    if (room) this.broadcastRoom = room;
    if (global) this.broadcastGlobal = global;
    if (reclaim) this.reclaimRoomSockets = reclaim;
  }

  canonicalRoomId(roomId) {
    try {
      return this.service?.room(roomId)?.id ?? roomId;
    } catch (error) {
      if (isMissingRoom(error)) return roomId;
      throw error;
    }
  }

  run(roomId, mutation) {
    if (this.closing) return Promise.reject(Object.assign(new Error('房间生命周期正在关闭'), { statusCode: 503 }));
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const previous = this.queues.get(canonicalRoomId) ?? Promise.resolve();
    const execution = previous.catch(() => {}).then(mutation);
    this.queues.set(canonicalRoomId, execution);
    execution.finally(() => {
      if (this.queues.get(canonicalRoomId) === execution) this.queues.delete(canonicalRoomId);
    }).catch(() => {});
    return execution;
  }

  idle(roomId) {
    return this.queues.get(this.canonicalRoomId(roomId)) ?? Promise.resolve();
  }

  async mutate(roomId, mutation, { affectedUserIds = [] } = {}) {
    let canonicalRoomId;
    try {
      canonicalRoomId = this.service.room(roomId).id;
    } catch (error) {
      if (isMissingRoom(error)) return undefined;
      throw error;
    }
    return this.run(canonicalRoomId, () => this.mutationQueue.run(async () => {
      let beforeRoom;
      try {
        beforeRoom = this.service.room(canonicalRoomId);
      } catch (error) {
        if (isMissingRoom(error)) return undefined;
        throw error;
      }
      const afterEventId = beforeRoom.eventSeq;
      const afterBannerCount = this.service.store?.banners?.length ?? 0;
      const snapshot = captureMutationState(this.service, beforeRoom, affectedUserIds);
      let value;
      let room;
      let createdBanners = [];
      let mutationCompleted = false;
      try {
        value = await mutation();
        createdBanners = (this.service.store?.banners ?? []).slice(afterBannerCount);
        mutationCompleted = true;
        try {
          room = this.service.room(canonicalRoomId);
        } catch (error) {
          if (!isMissingRoom(error)) throw error;
        }

        if (room) await this.persistence?.flushRoom?.(room.id, afterBannerCount, createdBanners);
        else await this.persistence?.deleteRoom?.(canonicalRoomId, afterBannerCount, createdBanners);
      } catch (error) {
        if (!mutationCompleted) createdBanners = (this.service.store?.banners ?? []).slice(afterBannerCount);
        restoreMutationState(this.service, canonicalRoomId, beforeRoom, snapshot, createdBanners);
        throw error;
      }

      if (room) {
        this.broadcastEvents(room, afterEventId);
        this.broadcastBanners(createdBanners);
        this.scheduleTurn(room);
      } else {
        this.broadcastEvents(beforeRoom, afterEventId);
        try {
          this.cancelRoom(canonicalRoomId);
        } catch (error) {
          this.reportError(error);
        }
        try {
          this.reclaimRoomSockets?.(canonicalRoomId);
        } catch (error) {
          this.reportError(error);
        }
      }
      return value;
    }));
  }

  broadcastEvents(room, afterEventId) {
    if (!this.broadcastRoom) return;
    for (const event of room.events.filter((entry) => entry.id > afterEventId)) {
      this.broadcastRoom(room.id, event);
    }
  }

  broadcastBanners(banners) {
    if (!this.broadcastGlobal) return;
    for (const banner of banners) this.broadcastGlobal(banner);
  }

  restoreAll() {
    for (const room of this.service.rooms.values()) {
      this.restoreRoom(room.id);
      for (const player of room.players.values()) {
        if (player.left || room.spectators.has(player.userId)) continue;
        this.scheduleDisconnect(room.id, player.userId);
      }
    }
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

  scheduleTurn(room, minimumDelay = 0, retryAttempt = 0) {
    if (this.closing) return;
    this.cancelTurn(room.id);
    if (!this.autoTimeout || room.status !== 'betting' || room.currentTurn < 0 || !room.turnDeadlineAt || !room.round?.id) return;
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
    const delay = Math.max(minimumDelay, new Date(binding.deadlineAt).getTime() - this.clock.now(), 0);
    const handle = this.clock.setTimeout(async () => {
      const current = this.turnTimers.get(room.id);
      if (!current || current.binding !== binding) return;
      this.turnTimers.delete(room.id);
      try {
        await this.mutate(room.id, () => {
          const latest = this.service.room(room.id);
          if (latest.version !== binding.version
            || latest.round?.id !== binding.roundId
            || latest.currentTurn !== binding.seat) return latest;
          const latestPlayer = [...latest.players.values()].find((candidate) => candidate.seat === binding.seat);
          if (!latestPlayer || latestPlayer.actionSeq !== binding.actionSeq) return latest;
          return this.service.timeoutFold(room.id, { ...binding, now: this.clock.now() });
        });
        await this.onRoomMutation?.(room.id);
      } catch (error) {
        if (this.closing) return;
        if (retryAttempt >= PERSISTENCE_RETRY_LIMIT) {
          this.reportError(error);
          return;
        }
        try {
          this.scheduleTurn(this.service.room(room.id), persistenceRetryDelay(retryAttempt), retryAttempt + 1);
        } catch (retryError) {
          if (!isMissingRoom(retryError)) this.reportError(retryError);
        }
      }
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
    if (this.closing) return;
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const key = connectionKey(canonicalRoomId, userId);
    this.connections.set(key, (this.connections.get(key) ?? 0) + 1);
    const departure = this.disconnectTimers.get(key);
    if (departure) {
      this.clock.clearTimeout(departure.handle);
      this.disconnectTimers.delete(key);
    }
  }

  disconnected(roomId, userId) {
    if (this.closing) return;
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const key = connectionKey(canonicalRoomId, userId);
    const count = Math.max(0, (this.connections.get(key) ?? 0) - 1);
    if (count > 0) {
      this.connections.set(key, count);
      return;
    }
    this.connections.delete(key);
    this.scheduleDisconnect(canonicalRoomId, userId);
  }

  scheduleDisconnect(roomId, userId, delay = DISCONNECT_GRACE_MS, retryAttempt = 0) {
    if (this.closing) return;
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const key = connectionKey(canonicalRoomId, userId);
    if (this.disconnectTimers.has(key) || (this.connections.get(key) ?? 0) > 0) return;
    const token = Symbol(key);
    const handle = this.clock.setTimeout(async () => {
      const current = this.disconnectTimers.get(key);
      if (!current || current.token !== token || (this.connections.get(key) ?? 0) > 0) return;
      this.disconnectTimers.delete(key);
      try {
        await this.mutate(canonicalRoomId, () => this.service.leaveRoom(canonicalRoomId, userId, { now: this.clock.now() }));
        await this.onRoomMutation?.(canonicalRoomId);
      } catch (error) {
        if (this.closing) return;
        if (retryAttempt >= PERSISTENCE_RETRY_LIMIT) {
          this.reportError(error);
          return;
        }
        this.scheduleDisconnect(canonicalRoomId, userId, persistenceRetryDelay(retryAttempt), retryAttempt + 1);
      }
    }, delay);
    handle?.unref?.();
    this.disconnectTimers.set(key, { handle, token, roomId: canonicalRoomId, userId });
  }

  cancelRoom(roomId) {
    const canonicalRoomId = this.canonicalRoomId(roomId);
    this.cancelTurn(canonicalRoomId);
    for (const [key, timer] of this.disconnectTimers) {
      if (timer.roomId !== canonicalRoomId) continue;
      this.clock.clearTimeout(timer.handle);
      this.disconnectTimers.delete(key);
      this.connections.delete(key);
    }
    const prefix = `${canonicalRoomId}:`;
    for (const key of this.connections.keys()) {
      if (key.startsWith(prefix)) this.connections.delete(key);
    }
  }

  async close() {
    this.closing = true;
    for (const roomId of [...this.turnTimers.keys()]) this.cancelTurn(roomId);
    for (const timer of this.disconnectTimers.values()) this.clock.clearTimeout(timer.handle);
    this.disconnectTimers.clear();
    this.connections.clear();
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
    for (const roomId of [...this.turnTimers.keys()]) this.cancelTurn(roomId);
    for (const timer of this.disconnectTimers.values()) this.clock.clearTimeout(timer.handle);
    this.disconnectTimers.clear();
    this.queues.clear();
  }
}

export { TURN_TIMEOUT_MS };
