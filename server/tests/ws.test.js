import { describe, expect, it } from 'vitest';
import { WebSocketGateway } from '../src/ws/gateway.js';
import { buildApp } from '../src/index.js';

function socket() { return { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); }, on() {} }; }

describe('WebSocket visibility', () => {
  it('authenticates a database-backed session resolver', async () => {
    const sent = [];
    const socket = { readyState: 1, send(value) { sent.push(JSON.parse(value)); }, on() {}, close() { throw new Error('socket should stay open'); } };
    const service = { room: () => ({ spectators: new Set() }), eventsSince: () => [] };
    const gateway = new WebSocketGateway({ service, findSession: async () => ({ id: 'database-user' }) });

    await gateway.handleConnection(socket, { headers: { cookie: 'zhajinhua_session=database-token' } }, new URL('http://localhost/ws?roomId=room'));

    expect(sent).toContainEqual({ type: 'connected' });
    expect(gateway.rooms.get('room')).toBeDefined();
  });

  it('keeps compare cards/type names hidden but gives spectators settled cards', () => {
    const gateway = new WebSocketGateway({}); const player = socket(); const observer = socket();
    gateway.addRoomSocket('room', player, { userId: 'p', spectator: false }); gateway.addRoomSocket('room', observer, { userId: 's', spectator: true });
    gateway.broadcastRoom('room', { eventType: 'compare_started', payload: { attacker: '甲', target: '乙', cards: [{ rank: 2 }], typeName: '豹子' } });
    expect(player.sent[0].event.payload).not.toHaveProperty('cards'); expect(player.sent[0].event.payload).not.toHaveProperty('typeName');
    gateway.broadcastRoom('room', { eventType: 'round_settled', payload: { cards: [{ rank: 2 }], typeName: '对子' } });
    expect(observer.sent[1].event.payload.cards).toHaveLength(1); expect(observer.sent[1].event.payload.typeName).toBe('对子');
  });

  it('broadcasts room events and settlement banners from HTTP actions', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    const register = (email, nickname) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, nickname, password: 'password-123' } });
    const first = await register('broadcast-test-a@example.com', '广播测试甲');
    const second = await register('broadcast-test-b@example.com', '广播测试乙');
    const firstCookie = first.headers['set-cookie'];
    const secondCookie = second.headers['set-cookie'];
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: firstCookie }, payload: {} })).json().room;
    const observer = socket(); const global = socket();
    app.gateway.addRoomSocket(room.id, observer, { userId: second.json().user.id, spectator: false });
    app.gateway.addGlobalSocket(global);
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: secondCookie }, payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: firstCookie }, payload: {} });
    expect(observer.sent.map((message) => message.event?.eventType)).toEqual(['player_joined', 'round_started']);
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: firstCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: secondCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    expect(global.sent.filter((message) => message.type === 'global_banner').map((message) => message.banner.message)).toHaveLength(1);
    await app.close();
  });
});
