import { WebSocketServer } from 'ws';
import { publicEvent } from '../game/events.js';
import { hashSessionToken, SESSION_COOKIE } from '../auth/session.js';

function send(socket, message) { if (socket.readyState === undefined || socket.readyState === 1) socket.send(JSON.stringify(message)); }

export class WebSocketGateway {
  constructor({ service, services, store, findSession } = {}) { this.service = service; this.services = services ?? { zhajinhua:service }; this.store = store ?? service?.store; this.findSession = findSession; this.rooms = new Map(); this.global = new Set(); this.wss = null; }
  roomKey(roomId, game='zhajinhua') { return game === 'zhajinhua' ? roomId : `${game}:${roomId}`; }
  addRoomSocket(roomId, socket, { userId, spectator = false, game='zhajinhua' } = {}) { const key=this.roomKey(roomId,game); if (!this.rooms.has(key)) this.rooms.set(key, new Set()); const entry = { socket, userId, spectator, game }; this.rooms.get(key).add(entry); socket.on?.('close', () => this.rooms.get(key)?.delete(entry)); return () => this.rooms.get(key)?.delete(entry); }
  addGlobalSocket(socket) { this.global.add(socket); const remove = () => this.global.delete(socket); socket.on?.('close', remove); return remove; }
  broadcastRoom(roomId, event, game='zhajinhua') { for (const entry of this.rooms.get(this.roomKey(roomId,game)) ?? []) { const visible=game==='texas' ? this.services.texas.publicEvent(this.services.texas.room(roomId),event,entry.userId) : publicEvent(event, { spectator: entry.spectator, settled: event.eventType === 'round_settled' }); send(entry.socket, { type:'room_event', game, event:visible }); } }
  broadcastGlobal(banner) { for (const socket of this.global) send(socket, { type: 'global_banner', banner }); }
  broadcastBanner(banner) { this.broadcastGlobal(banner); }
  attach(server, { path = '/ws' } = {}) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://localhost'); if (url.pathname !== path) return socket.destroy();
      this.wss.handleUpgrade(request, socket, head, (client) => { this.handleConnection(client, request, url).catch(() => client.close(1011, 'connection failed')); });
    });
    return this.wss;
  }
  async handleConnection(socket, request, url) {
    const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => { const index = part.indexOf('='); if (index < 0) return []; try { return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())]; } catch { return []; } }).filter((part) => part.length === 2));
    const token = cookies[SESSION_COOKIE] ?? '';
    const session = this.findSession ? await this.findSession(token) : this.store?.sessions?.get(hashSessionToken(token));
    if (!session || (session.expiresAt && session.expiresAt <= new Date())) return socket.close(1008, 'unauthorized');
    const game=url.searchParams.get('game') === 'texas' ? 'texas' : 'zhajinhua';
    const service=this.services?.[game] ?? this.service;
    const roomId = url.searchParams.get('roomId'); const userId = session.userId ?? session.user_id ?? session.id; const spectator = roomId ? service?.room(roomId)?.spectators?.has(userId) ?? false : false;
    if (roomId && service && game === 'texas' && !service.canAccess(roomId,userId)) return socket.close(1008,'room access denied');
    if (roomId && service) { this.addRoomSocket(roomId, socket, { userId, spectator, game }); socket.on('message', (raw) => this.handleMessage(socket, roomId, userId, raw, service, game)); }
    else this.addGlobalSocket(socket);
    send(socket, { type: 'connected' });
  }
  handleMessage(socket, roomId, userId, raw, service=this.service, game='zhajinhua') {
    let message; try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: '消息格式错误' }); }
    if (message.type === 'subscribe_global') this.addGlobalSocket(socket);
    if (message.type === 'sync' && service) for (const event of service.eventsSince(roomId, userId, message.after ?? 0)) send(socket, { type:'room_event', game, event });
  }
}

export function createGateway(options) { return new WebSocketGateway(options); }
