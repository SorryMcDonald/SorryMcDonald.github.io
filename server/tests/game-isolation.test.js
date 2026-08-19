import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/index.js';
import { WebSocketGateway } from '../src/ws/gateway.js';

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

describe('independent game entries', () => {
  it('marks each document with its own game entry and loads only its client', async () => {
    const zhaHtml = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    const texasHtml = await readFile(new URL('../../public/dezhou.html', import.meta.url), 'utf8');
    const zhaJs = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    const texasJs = await readFile(new URL('../../public/dezhou.js', import.meta.url), 'utf8');

    expect(zhaHtml).toContain('<body data-game="zhajinhua"');
    expect(texasHtml).toContain('<body data-game="texas"');
    expect(zhaHtml).toContain('<script type="module" src="/app.js"></script>');
    expect(zhaHtml).not.toContain('/dezhou.js');
    expect(texasHtml).toContain('<script type="module" src="/dezhou.js"></script>');
    expect(texasHtml).not.toContain('/app.js');
    expect(zhaJs).not.toMatch(/\/api\/texas\//);
    expect(zhaJs).not.toContain('game=texas');
    expect(texasJs).not.toMatch(/["'`]\/api\/rooms(?:["'`/?])/);
    expect(texasJs).not.toContain('game=zhajinhua');
  });

  it('keeps room directories and room detail routes in separate namespaces', async () => {
    const app = await buildApp({ logger: false });
    try {
      const player = await register(app, 'entry-isolation@example.com', '入口隔离玩家');

    const zhaRoom = (await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { cookie: player.cookie },
      payload: {}
    })).json().room;
    const texasRoom = (await app.inject({
      method: 'POST',
      url: '/api/texas/rooms',
      headers: { cookie: player.cookie },
      payload: {}
    })).json().room;

    const zhaDirectory = await app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie: player.cookie } });
    const texasDirectory = await app.inject({ method: 'GET', url: '/api/texas/rooms', headers: { cookie: player.cookie } });
    expect(zhaDirectory.json().rooms.map((room) => room.id)).toContain(zhaRoom.id);
    expect(zhaDirectory.json().rooms.map((room) => room.id)).not.toContain(texasRoom.id);
    expect(texasDirectory.json().rooms.map((room) => room.id)).toContain(texasRoom.id);
    expect(texasDirectory.json().rooms.map((room) => room.id)).not.toContain(zhaRoom.id);

    const zhaViewOfTexas = await app.inject({ method: 'GET', url: `/api/rooms/${texasRoom.id}`, headers: { cookie: player.cookie } });
    const texasViewOfZha = await app.inject({ method: 'GET', url: `/api/texas/rooms/${zhaRoom.id}`, headers: { cookie: player.cookie } });
    expect(zhaViewOfTexas.statusCode).toBe(404);
    expect(texasViewOfZha.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('keeps same-id WebSocket subscriptions on their own game namespace', () => {
    const socket = () => ({ readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); }, on() {} });
    const zha = socket();
    const texas = socket();
    const zhaService = { room: () => ({ id: 'same-zha', players: new Map([['zha-user', { userId: 'zha-user', left: false }]]), spectators: new Set() }) };
    const texasService = { room: () => ({ id: 'same-texas', players: new Map(), spectators: new Set() }), publicEvent: (_room, event) => event };
    const gateway = new WebSocketGateway({ services: { zhajinhua: zhaService, texas: texasService } });
    gateway.addRoomSocket('same-code', zha, { userId: 'zha-user', game: 'zhajinhua' });
    gateway.addRoomSocket('same-code', texas, { userId: 'texas-user', game: 'texas' });
    gateway.broadcastRoom('same-code', { eventType: 'round_started' }, 'zhajinhua');
    gateway.broadcastRoom('same-code', { eventType: 'texas_hand_started' }, 'texas');

    expect(zha.sent).toHaveLength(1);
    expect(zha.sent[0].event.eventType).toBe('round_started');
    expect(texas.sent).toEqual([{ type: 'room_event', game: 'texas', event: { eventType: 'texas_hand_started' } }]);
  });
});
