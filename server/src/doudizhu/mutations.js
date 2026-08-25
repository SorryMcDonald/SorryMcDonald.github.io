import { mutationQueueFor } from '../persistence/mutation-queue.js';

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) {
    if (!(key in snapshot)) delete target[key];
  }
  Object.assign(target, structuredClone(snapshot));
}

function snapshotUsers(store, room) {
  const userIds = new Set(room.players.map((player) => player.userId));
  return new Map([...userIds].flatMap((id) => {
    const user = store.users.get(id);
    return user ? [[id, structuredClone(user)]] : [];
  }));
}

function restoreUsers(store, snapshots) {
  for (const [id, snapshot] of snapshots) {
    const user = store.users.get(id);
    if (user && typeof user === 'object') restoreObject(user, snapshot);
    else store.users.set(id, structuredClone(snapshot));
  }
}

export class DoudizhuMutationController {
  constructor({ service, persistence, mutationQueue } = {}) {
    this.service = service;
    this.persistence = persistence;
    this.mutationQueue = mutationQueue ?? mutationQueueFor(service?.store);
  }

  run(operation) {
    return this.mutationQueue.run(operation);
  }

  createOrResume(userId, input = {}) {
    return this.run(async () => {
      const existing = this.service.activeRoomForUser(userId);
      if (existing) return { room: existing, created: false };

      const room = this.service.createRoom(userId, input);
      try {
        await this.persistence?.flushRoom?.(room.id);
      } catch (error) {
        this.service.rooms.delete(room.id);
        throw error;
      }
      return { room, created: true };
    });
  }

  mutate(roomId, operation, { deleteWhenEmpty = false } = {}) {
    return this.run(async () => {
      const room = this.service.room(roomId);
      const canonicalRoomId = room.id;
      const roomSnapshot = structuredClone(room);
      const userSnapshots = snapshotUsers(this.service.store, room);
      const beforeVersion = Number(room.version);

      try {
        const value = await operation(room);
        const current = this.service.room(canonicalRoomId);
        const empty = !current.players.some((player) => !player.left);

        if (deleteWhenEmpty && empty) {
          await this.persistence?.deleteRoom?.(canonicalRoomId);
          this.service.rooms.delete(canonicalRoomId);
          return { value, room: null, changed: true, deleted: true };
        }

        const changed = Number(current.version) !== beforeVersion;
        if (changed) await this.persistence?.flushRoom?.(canonicalRoomId);
        return { value, room: current, changed, deleted: false };
      } catch (error) {
        restoreObject(room, roomSnapshot);
        this.service.rooms.set(canonicalRoomId, room);
        restoreUsers(this.service.store, userSnapshots);
        throw error;
      }
    });
  }
}
