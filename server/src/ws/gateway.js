import { WebSocketServer } from 'ws';
import { publicEvent } from '../game/events.js';
import { hashSessionToken, SESSION_COOKIE } from '../auth/session.js';

const HEARTBEAT_TRACKED = Symbol('heartbeatTracked');
export const MAX_WS_PAYLOAD_BYTES = 16 * 1024;

function payloadSize(raw) {
  if (typeof raw === 'string') return Buffer.byteLength(raw);
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + payloadSize(part), 0);
  return Number(raw?.byteLength ?? raw?.length ?? 0);
}

function trackHeartbeat(socket) {
  if (socket[HEARTBEAT_TRACKED]) return;
  socket[HEARTBEAT_TRACKED] = true;
  socket.isAlive = true;
  socket.on?.('pong', () => { socket.isAlive = true; });
}

function send(socket, message) {
  if (socket.readyState === undefined || socket.readyState === 1) socket.send(JSON.stringify(message));
}

function gameFor(value) {
  return value === 'texas' ? 'texas' : 'zhajinhua';
}

function roomPlayers(room) {
  if (room?.players && typeof room.players.values === 'function') return [...room.players.values()];
  if (Array.isArray(room?.players)) return room.players;
  // Keep minimal service doubles usable in unit tests. Production rooms always hydrate a player Map.
  return null;
}

function canAccessZhajinhuaRoom(room, userId) {
  const players = roomPlayers(room);
  if (players === null) return true;
  const seated = players.some((player) => player?.userId === userId && !player.left);
  const spectator = room?.spectators?.has?.(userId) ?? false;
  return seated || spectator;
}

function canAccessRoom(room, service, roomId, userId, game) {
  if (game === 'texas') return typeof service?.canAccess === 'function' ? service.canAccess(roomId, userId) : true;
  return canAccessZhajinhuaRoom(room, userId);
}

export class WebSocketGateway {
  constructor({ service, services, store, findSession, lifecycle, texasLifecycle, heartbeatIntervalMs = 30_000, maxPayloadBytes = MAX_WS_PAYLOAD_BYTES } = {}) {
    this.service = service;
    this.services = { ...(service ? { zhajinhua: service } : {}), ...(services ?? {}) };
    this.store = store ?? service?.store;
    this.findSession = findSession;
    this.lifecycle = lifecycle;
    this.texasLifecycle = texasLifecycle;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxPayloadBytes = maxPayloadBytes;
    this.rooms = new Map();
    this.global = new Set();
    this.wss = null;
    this.heartbeatTimer = null;
  }

  roomKey(roomId, game = 'zhajinhua') {
    return game === 'zhajinhua' ? String(roomId) : `${game}:${roomId}`;
  }

  canonicalRoomId(roomId, game = 'zhajinhua') {
    try {
      return this.services?.[game]?.room(roomId)?.id ?? roomId;
    } catch {
      return roomId;
    }
  }

  addRoomSocket(roomId, socket, { userId, spectator = false, game = 'zhajinhua' } = {}) {
    const canonicalRoomId = this.canonicalRoomId(roomId, game);
    const key = this.roomKey(canonicalRoomId, game);
    if (!this.rooms.has(key)) this.rooms.set(key, new Set());
    const entry = { socket, userId, spectator, game, remove: null };
    this.rooms.get(key).add(entry);
    trackHeartbeat(socket);
    if (game === 'zhajinhua') this.lifecycle?.connected(canonicalRoomId, userId);
    if (game === 'texas') this.texasLifecycle?.connected(canonicalRoomId, userId);

    let removed = false;
    const remove = ({ notifyLifecycle = true } = {}) => {
      if (removed) return;
      removed = true;
      const entries = this.rooms.get(key);
      entries?.delete(entry);
      if (entries?.size === 0) this.rooms.delete(key);
      if (notifyLifecycle && game === 'zhajinhua') this.lifecycle?.disconnected(canonicalRoomId, userId);
      if (notifyLifecycle && game === 'texas') this.texasLifecycle?.disconnected(canonicalRoomId, userId);
    };
    entry.remove = remove;
    socket.on?.('close', () => remove());
    return remove;
  }

  closeUserRoomSockets(roomId, userId, game = 'zhajinhua') {
    const canonicalRoomId = this.canonicalRoomId(roomId, game);
    const key = this.roomKey(canonicalRoomId, game);
    for (const entry of [...(this.rooms.get(key) ?? [])]) {
      if (entry.userId !== userId) continue;
      entry.remove?.({ notifyLifecycle: false });
      if (entry.socket.readyState === undefined || entry.socket.readyState === 0 || entry.socket.readyState === 1) {
        entry.socket.close?.(1008, 'room access denied');
      }
    }
  }

  addGlobalSocket(socket) {
    if (this.global.has(socket)) return () => this.global.delete(socket);
    this.global.add(socket);
    trackHeartbeat(socket);
    const remove = () => this.global.delete(socket);
    socket.on?.('close', remove);
    return remove;
  }

  broadcastRoom(roomId, event, game = 'zhajinhua') {
    const canonicalRoomId = this.canonicalRoomId(roomId, game);
    const service = this.services?.[game];
    let room;
    try { room = service?.room(canonicalRoomId); } catch {}

    for (const entry of this.rooms.get(this.roomKey(canonicalRoomId, game)) ?? []) {
      const tournamentMoveRecipient = event.eventType === 'tournament_player_moved'
        && event.payload?.userId === entry.userId
        && event.payload?.toRoomId;
      if (tournamentMoveRecipient) {
        const moveEvent = game === 'texas' && room && service?.publicEvent
          ? service.publicEvent(room, event, entry.userId)
          : publicEvent(event, { spectator:false });
        send(entry.socket, game === 'texas'
          ? { type:'room_event', game, event:moveEvent }
          : { type:'room_event', event:moveEvent });
        continue;
      }
      if (room && !canAccessRoom(room, service, canonicalRoomId, entry.userId, game)) {
        this.closeUserRoomSockets(canonicalRoomId, entry.userId, game);
        continue;
      }
      if (game === 'zhajinhua') {
        if (event.audience?.startsWith('user:') && event.audience !== `user:${entry.userId}`) continue;
        let spectator = entry.spectator;
        try { spectator = room?.spectators?.has(entry.userId) ?? spectator; } catch {}
        send(entry.socket, {
          type: 'room_event',
          event: publicEvent(event, {
            spectator,
            settled: event.eventType === 'round_settled',
            revealed: event.eventType === 'hand_revealed'
          })
        });
        continue;
      }

      if (!room || !service?.publicEvent) continue;
      send(entry.socket, { type: 'room_event', game, event: service.publicEvent(room, event, entry.userId) });
    }
  }

  broadcastGlobal(banner) {
    for (const socket of this.global) send(socket, { type: 'global_banner', banner });
  }

  broadcastBanner(banner) { this.broadcastGlobal(banner); }

  closeRoom(roomId, game = 'zhajinhua') {
    const canonicalRoomId = this.canonicalRoomId(roomId, game);
    const key = this.roomKey(canonicalRoomId, game);
    const entries = [...(this.rooms.get(key) ?? [])];
    this.rooms.delete(key);
    for (const entry of entries) {
      entry.remove?.({ notifyLifecycle: false });
      if (entry.socket.readyState === undefined || entry.socket.readyState === 0 || entry.socket.readyState === 1) {
        entry.socket.close?.(1000, 'room reclaimed');
      }
    }
  }

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
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== path) return socket.destroy();
      this.wss.handleUpgrade(request, socket, head, (client) => {
        this.handleConnection(client, request, url).catch(() => client.close(1011, 'connection failed'));
      });
    });
    this.startHeartbeat();
    return this.wss;
  }

  async handleConnection(socket, request, url) {
    const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => {
      const index = part.indexOf('=');
      if (index < 0) return [];
      try {
        return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())];
      } catch {
        return [];
      }
    }).filter((part) => part.length === 2));
    const token = cookies[SESSION_COOKIE] ?? '';
    const session = this.findSession ? await this.findSession(token) : this.store?.sessions?.get(hashSessionToken(token));
    if (!session || (session.expiresAt && session.expiresAt <= new Date())) return socket.close(1008, 'unauthorized');

    const requestedRoomId = url.searchParams.get('roomId');
    const userId = session.userId ?? session.user_id ?? session.id;
    if (!requestedRoomId) {
      this.addGlobalSocket(socket);
      send(socket, { type: 'connected' });
      return;
    }

    const game = gameFor(url.searchParams.get('game'));
    const service = this.services?.[game];
    if (!service) return socket.close(1008, 'unsupported game');

    let room;
    try { room = service.room(requestedRoomId); } catch { return socket.close(1008, 'room not found'); }
    const roomId = room.id ?? requestedRoomId;
    if (game === 'texas' && !service.canAccess(roomId, userId)) return socket.close(1008, 'room access denied');
    if (game === 'zhajinhua' && !canAccessZhajinhuaRoom(room, userId)) return socket.close(1008, 'room access denied');

    const spectator = room.spectators?.has(userId) ?? false;
    this.addRoomSocket(roomId, socket, { userId, spectator, game });
    socket.on('message', (raw) => {
      this.handleMessage(socket, roomId, userId, raw, service, game)
        .catch((error) => send(socket, { type: 'error', error: error?.message ?? '消息处理失败' }));
    });
    send(socket, { type: 'connected' });
  }

  async handleMessage(socket, roomId, userId, raw, service = this.service, game = 'zhajinhua') {
    if (payloadSize(raw) > this.maxPayloadBytes) return send(socket, { type: 'error', error: '消息过大' });
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: '消息格式错误' }); }
    if (message.type === 'subscribe_global') return this.addGlobalSocket(socket);
    if (message.type === 'sync' && service) {
      if (game === 'texas') {
        if (!service.canAccess?.(roomId, userId)) {
          this.closeUserRoomSockets(roomId, userId, game);
          return;
        }
      } else {
        let room;
        try { room = service.room(roomId); } catch { return socket.close?.(1008, 'room not found'); }
        if (!canAccessZhajinhuaRoom(room, userId)) {
          this.closeUserRoomSockets(room.id ?? roomId, userId, game);
          return;
        }
      }
      for (const event of service.eventsSince(roomId, userId, message.after ?? 0)) {
        send(socket, game === 'texas' ? { type: 'room_event', game, event } : { type: 'room_event', event });
      }
      return;
    }
    if (message.type === 'chat' && service) {
      if (game === 'zhajinhua' && this.lifecycle) {
        await this.lifecycle.mutate(roomId, () => service.addMessage(roomId, userId, message.text));
      } else if (game === 'texas' && this.texasLifecycle) {
        await this.texasLifecycle.mutate(roomId, () => service.addMessage(roomId, userId, message.text));
      } else {
        const room = service.room(roomId);
        const afterEventId = room.eventSeq;
        service.addMessage(roomId, userId, message.text);
        for (const event of room.events.filter((entry) => entry.id > afterEventId)) this.broadcastRoom(roomId, event, game);
      }
      return;
    }
    send(socket, { type: 'error', error: '未知消息类型' });
  }
}

export function createGateway(options) { return new WebSocketGateway(options); }
