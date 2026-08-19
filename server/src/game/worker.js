export class GameWorker {
  constructor({ service } = {}) { this.service = service; this.pending = new Set(); }
  enqueue(roomId, action) { this.pending.add(roomId); return action(); }
  wake(roomId) { this.pending.add(roomId); }
  stop() { this.pending.clear(); }
}
