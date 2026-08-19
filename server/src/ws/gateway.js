import { WebSocketServer } from 'ws';
import { publicEvent } from '../game/events.js';
import { hashSessionToken, SESSION_COOKIE } from '../auth/session.js';

function send(socket, message) { if (socket.readyState === undefined || socket.readyState === 1) socket.send(JSON.stringify(message)); }

export class WebSocketGateway {
  constructor({ service, store, findSession, lifecycle, heartbeatIntervalMs = 30_000 } = {}) {
    this.service = service;
    this.store = store ?? service?.store;
    this.findSession = findSession;
    this.lifecycle = lifecycle;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.rooms = new Map();
    this.global = new Set();
    this.wss = null;
    this.heartbeatTimer = null;
  }

  addRoomSocket(roomId, socket, { userId, spectator = false } = {}) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    const entry = { socket, userId, spectator };
    this.rooms.get(roomId).add(entry);
    socket.isAlive = true;
    socket.on?.('pong', () => { socket.isAlive = true; });
    this.lifecycle?.connected(roomId, userId);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      const entries = this.rooms.get(roomId);
      entries?.delete(entry);
      if (entries?.size === 0) this.rooms.delete(roomId);
      this.lifecycle?.disconnected(roomId, userId);
    };
    socket.on?.('close', remove);
    return remove;
  }
  addGlobalSocket(socket) { this.global.add(socket); const remove = () => this.global.delete(socket); socket.on?.('close', remove); return remove; }
  broadcastRoom(roomId, event) {
    for (const entry of this.rooms.get(roomId) ?? []) {
      if (event.audience?.startsWith('user:') && event.audience !== `user:${entry.userId}`) continue;
      let spectator = entry.spectator;
      try { spectator = this.service?.room(roomId)?.spectators?.has(entry.userId) ?? spectator; } catch {}
      send(entry.socket, {
        type: 'room_event',
        event: publicEvent(event, {
          spectator,
          settled: event.eventType === 'round_settled',
          revealed: event.eventType === 'hand_revealed'
        })
      });
    }
  }
  broadcastGlobal(banner) { for (const socket of this.global) send(socket, { type: 'global_banner', banner }); }
  broadcastBanner(banner) { this.broadcastGlobal(banner); }
  sweepHeartbeat() {
    const sockets = new Set([
      ...[...this.rooms.values()].flatMap((entries) => [...entries].map((entry) => entry.socket)),
      ...this.global
    ]);
    for (const socket of sockets) {
      if (socket.isAlive === false) {
        socket.terminate?.();
        continue;
      }
      socket.isAlive = false;
      socket.ping?.();
    }
  }
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }
  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.wss?.close();
  }
  attach(server, { path = '/ws' } = {}) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://localhost'); if (url.pathname !== path) return socket.destroy();
      this.wss.handleUpgrade(request, socket, head, (client) => { this.handleConnection(client, request, url).catch(() => client.close(1011, 'connection failed')); });
    });
    this.startHeartbeat();
    return this.wss;
  }
  async handleConnection(socket, request, url) {
    const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => { const index = part.indexOf('='); if (index < 0) return []; try { return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())]; } catch { return []; } }).filter((part) => part.length === 2));
    const token = cookies[SESSION_COOKIE] ?? '';
    const session = this.findSession ? await this.findSession(token) : this.store?.sessions?.get(hashSessionToken(token));
    if (!session || (session.expiresAt && session.expiresAt <= new Date())) return socket.close(1008, 'unauthorized');
    const roomId = url.searchParams.get('roomId'); const userId = session.userId ?? session.user_id ?? session.id; const spectator = roomId ? this.service?.room(roomId)?.spectators?.has(userId) ?? false : false;
    if (roomId && this.service) {
      this.addRoomSocket(roomId, socket, { userId, spectator });
      socket.on('message', (raw) => {
        this.handleMessage(socket, roomId, userId, raw).catch((error) => send(socket, { type: 'error', error: error?.message ?? '消息处理失败' }));
      });
    }
    else this.addGlobalSocket(socket);
    send(socket, { type: 'connected' });
  }
  async handleMessage(socket, roomId, userId, raw) {
    let message; try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: '消息格式错误' }); }
    if (message.type === 'subscribe_global') return this.addGlobalSocket(socket);
    if (message.type === 'sync' && this.service) {
      for (const event of this.service.eventsSince(roomId, userId, message.after ?? 0)) send(socket, { type: 'room_event', event });
      return;
    }
    if (message.type === 'chat' && this.service) {
      if (this.lifecycle) await this.lifecycle.mutate(roomId, () => this.service.addMessage(roomId, userId, message.text));
      else {
        const room = this.service.room(roomId);
        const afterEventId = room.eventSeq;
        this.service.addMessage(roomId, userId, message.text);
        for (const event of room.events.filter((entry) => entry.id > afterEventId)) this.broadcastRoom(roomId, event);
      }
      return;
    }
    send(socket, { type: 'error', error: '未知消息类型' });
  }
}

export function createGateway(options) { return new WebSocketGateway(options); }
