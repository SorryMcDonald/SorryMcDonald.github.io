import { mutationQueueFor } from '../persistence/mutation-queue.js';

export const TEXAS_DISCONNECT_GRACE_MS = 60_000;
export const TEXAS_PERSISTENCE_RETRY_MS = 1_000;
export const TEXAS_PERSISTENCE_RETRY_LIMIT = 5;
export const TEXAS_PERSISTENCE_RETRY_MAX_MS = 16_000;

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle)
};

function connectionKey(roomId, userId) { return `${roomId}:${userId}`; }
function isMissingRoom(error) { return error?.statusCode === 404; }

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) {
    if (!(key in snapshot)) delete target[key];
  }
  Object.assign(target, structuredClone(snapshot));
}

function snapshotUsers(store) {
  return new Map([...store.users].map(([id, user]) => [id, structuredClone(user)]));
}

function restoreUsers(store, snapshot) {
  const users = store.users;
  for (const id of users.keys()) {
    if (!snapshot.has(id)) users.delete(id);
  }
  for (const [id, userSnapshot] of snapshot) {
    const user = users.get(id);
    if (user && typeof user === 'object' && userSnapshot && typeof userSnapshot === 'object') {
      restoreObject(user, userSnapshot);
    } else {
      users.set(id, structuredClone(userSnapshot));
    }
  }
}

export class TexasLifecycleController {
  constructor({ service, persistence, broadcastRoom, reclaimRoomSockets, clock = systemClock, mutationQueue, onError } = {}) {
    this.service = service;
    this.persistence = persistence;
    this.broadcastRoom = broadcastRoom;
    this.reclaimRoomSockets = reclaimRoomSockets;
    this.clock = clock;
    this.mutationQueue = mutationQueue ?? mutationQueueFor(service?.store);
    this.queues = new Map();
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.connections = new Map();
    this.closing = false;
    this.closePromise = null;
    this.onError = onError;
  }

  reportError(error) {
    try { this.onError?.(error); } catch {}
  }

  canonicalRoomId(roomId) {
    try {
      return this.service.room(roomId).id;
    } catch (error) {
      if (isMissingRoom(error)) return roomId;
      throw error;
    }
  }

  run(roomId, operation) {
    if (this.closing) return Promise.reject(Object.assign(new Error('德州生命周期正在关闭'), { statusCode: 503 }));
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.queues.set(roomId, result);
    result.finally(() => { if (this.queues.get(roomId) === result) this.queues.delete(roomId); }).catch(() => {});
    return result;
  }

  idle(roomId) { return this.queues.get(this.canonicalRoomId(roomId)) ?? Promise.resolve(); }

  async mutate(roomId, operation) {
    const canonicalRoomId = this.canonicalRoomId(roomId);
    return this.run(canonicalRoomId, () => this.mutationQueue.run(async () => {
      const before = structuredClone(this.service.room(canonicalRoomId));
      const beforeUsers = snapshotUsers(this.service.store);
      const beforeVersion = before.version;
      const eventStart = before.eventSeq;
      let value;
      let room;
      try {
        value = await operation();
        try {
          room = this.service.room(canonicalRoomId);
        } catch (error) {
          if (!isMissingRoom(error)) throw error;
        }
        if (room) await this.persistence?.flushRoom?.(canonicalRoomId, beforeVersion, eventStart);
        else await this.persistence?.deleteRoom?.(canonicalRoomId);
      } catch (error) {
        this.service.rooms.set(canonicalRoomId, before);
        restoreUsers(this.service.store, beforeUsers);
        throw error;
      }

      if (!room) {
        try {
          for (const event of before.events.filter((entry) => entry.id > eventStart)) this.broadcastRoom?.(canonicalRoomId, event);
        } catch (error) {
          this.reportError(error);
        }
        this.cancelTurn(canonicalRoomId);
        try {
          this.reclaimRoomSockets?.(canonicalRoomId);
        } catch (error) {
          this.reportError(error);
        }
        return value;
      }

      // Persistence is the rollback boundary. A disconnected client must not
      // undo a mutation that is already durable in the database.
      try {
        for (const event of room.events.filter((entry) => entry.id > eventStart)) this.broadcastRoom?.(canonicalRoomId, event);
      } catch (error) {
        this.reportError(error);
      }
      try {
        this.scheduleTurn(room);
      } catch (error) {
        this.reportError(error);
      }
      const roomIsEmpty = ![...room.players.values()].some((player) => !player.left && !player.spectating)
        && room.spectators.size === 0;
      if (room.status === 'closed' && roomIsEmpty) {
        let deleted = true;
        try {
          await this.persistence?.deleteRoom?.(canonicalRoomId);
        } catch (error) {
          deleted = false;
          this.reportError(error);
        }
        if (deleted) {
          try {
            this.service.reclaimRoom(canonicalRoomId);
          } catch (error) {
            this.reportError(error);
          }
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

  restoreAll() {
    for (const room of this.service.rooms.values()) {
      this.scheduleTurn(room);
      for (const player of room.players.values()) {
        if (player.left || player.spectating) continue;
        this.scheduleDisconnect(room.id, player.userId);
      }
    }
  }

  scheduleTurn(room, minimumDelay = 0, retryAttempt = 0) {
    this.cancelTurn(room.id);
    if (this.closing || !room.turnDeadlineAt || room.currentTurn < 0 || !room.hand?.id) return;
    const player = [...room.players.values()].find((candidate) => candidate.seat === room.currentTurn && candidate.inHand && !candidate.folded && !candidate.allIn && !candidate.left);
    if (!player) return;
    const binding = { roomId:room.id, roomVersion:room.version, handId:room.hand.id, currentTurn:room.currentTurn, actionSeq:player.actionSeq };
    const delay = Math.max(minimumDelay, new Date(room.turnDeadlineAt).getTime() - this.clock.now(), 0);
    const handle = this.clock.setTimeout(async () => {
      const current = this.turnTimers.get(room.id);
      if (!current || current.binding !== binding) return;
      this.turnTimers.delete(room.id);
      try {
        await this.mutate(room.id, () => this.service.timeoutFold(room.id, binding));
      } catch (error) {
        if (this.closing) return;
        if (retryAttempt >= TEXAS_PERSISTENCE_RETRY_LIMIT) {
          this.reportError(error);
          return;
        }
        try {
          this.scheduleTurn(
            this.service.room(room.id),
            Math.min(TEXAS_PERSISTENCE_RETRY_MS * (2 ** retryAttempt), TEXAS_PERSISTENCE_RETRY_MAX_MS),
            retryAttempt + 1
          );
        } catch (retryError) {
          this.reportError(retryError);
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
    const pending = this.disconnectTimers.get(key);
    if (pending) { this.clock.clearTimeout(pending.handle); this.disconnectTimers.delete(key); }
  }

  disconnected(roomId, userId) {
    if (this.closing) return;
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const key = connectionKey(canonicalRoomId, userId);
    const remaining = Math.max(0, (this.connections.get(key) ?? 0) - 1);
    if (remaining) { this.connections.set(key, remaining); return; }
    this.connections.delete(key);
    this.scheduleDisconnect(canonicalRoomId, userId);
  }

  scheduleDisconnect(roomId, userId, delay = TEXAS_DISCONNECT_GRACE_MS, retryAttempt = 0) {
    if (this.closing) return;
    const canonicalRoomId = this.canonicalRoomId(roomId);
    const key = connectionKey(canonicalRoomId, userId);
    if ((this.connections.get(key) ?? 0) > 0) {
      const stale = this.disconnectTimers.get(key);
      if (stale) {
        this.clock.clearTimeout(stale.handle);
        this.disconnectTimers.delete(key);
      }
      return;
    }
    if (this.disconnectTimers.has(key)) return;
    const token = Symbol(key);
    const handle = this.clock.setTimeout(async () => {
      const pending = this.disconnectTimers.get(key);
      if (!pending || pending.token !== token || (this.connections.get(key) ?? 0) > 0) return;
      this.disconnectTimers.delete(key);
      try {
        await this.mutate(canonicalRoomId, () => this.service.leaveRoom(canonicalRoomId, userId));
      } catch (error) {
        if (this.closing) return;
        if (retryAttempt >= TEXAS_PERSISTENCE_RETRY_LIMIT) {
          this.reportError(error);
          return;
        }
        this.scheduleDisconnect(
          canonicalRoomId,
          userId,
          Math.min(TEXAS_PERSISTENCE_RETRY_MS * (2 ** retryAttempt), TEXAS_PERSISTENCE_RETRY_MAX_MS),
          retryAttempt + 1
        );
      }
    }, delay);
    handle?.unref?.();
    this.disconnectTimers.set(key, { handle, token, roomId:canonicalRoomId, userId });
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      for (const timer of this.turnTimers.values()) this.clock.clearTimeout(timer.handle);
      for (const timer of this.disconnectTimers.values()) this.clock.clearTimeout(timer.handle);
      this.turnTimers.clear();
      this.disconnectTimers.clear();
      this.connections.clear();
      while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
      this.queues.clear();
    })();
    return this.closePromise;
  }
}
