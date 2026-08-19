import { WebSocketServer } from 'ws';
import { publicEvent } from '../game/events.js';
import { hashSessionToken, SESSION_COOKIE } from '../auth/session.js';

function send(socket, message) { if (socket.readyState === undefined || socket.readyState === 1) socket.send(JSON.stringify(message)); }

export class WebSocketGateway {
  constructor({ service, store, findSession } = {}) { this.service = service; this.store = store ?? service?.store; this.findSession = findSession; this.rooms = new Map(); this.global = new Set(); this.wss = null; }
  addRoomSocket(roomId, socket, { userId, spectator = false } = {}) { if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set()); const entry = { socket, userId, spectator }; this.rooms.get(roomId).add(entry); socket.on?.('close', () => this.rooms.get(roomId)?.delete(entry)); return () => this.rooms.get(roomId)?.delete(entry); }
  addGlobalSocket(socket) { this.global.add(socket); const remove = () => this.global.delete(socket); socket.on?.('close', remove); return remove; }
  broadcastRoom(roomId, event) { for (const entry of this.rooms.get(roomId) ?? []) send(entry.socket, { type: 'room_event', event: publicEvent(event, { spectator: entry.spectator, settled: event.eventType === 'round_settled' }) }); }
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
    const roomId = url.searchParams.get('roomId'); const userId = session.userId ?? session.user_id ?? session.id; const spectator = roomId ? this.service?.room(roomId)?.spectators?.has(userId) ?? false : false;
    if (roomId && this.service) { this.addRoomSocket(roomId, socket, { userId, spectator }); socket.on('message', (raw) => this.handleMessage(socket, roomId, userId, raw)); }
    else this.addGlobalSocket(socket);
    send(socket, { type: 'connected' });
  }
  handleMessage(socket, roomId, userId, raw) {
    let message; try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: '消息格式错误' }); }
    if (message.type === 'subscribe_global') this.addGlobalSocket(socket);
    if (message.type === 'sync' && this.service) for (const event of this.service.eventsSince(roomId, userId, message.after ?? 0)) send(socket, { type: 'room_event', event });
  }
}

export function createGateway(options) { return new WebSocketGateway(options); }
