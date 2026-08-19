import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { WebSocketGateway } from '../src/ws/gateway.js';

const cleanup = [];
const execFileAsync = promisify(execFile);
const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function register(app, email, nickname) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, nickname, password: 'password-123' }
  });
  return { cookie: response.headers['set-cookie'], user: response.json().user };
}

async function waitForMessage(socket, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('等待 WebSocket 消息超时')), timeout);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) finish(null, message);
    };
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on('message', onMessage);
  });
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待 WebSocket 状态超时');
}

async function connect(origin, roomId, cookie, options = {}) {
  const game = options.game;
  const wsOptions = { ...options };
  delete wsOptions.game;
  const gameQuery = game ? `&game=${encodeURIComponent(game)}` : '';
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?roomId=${roomId}${gameQuery}`, { headers: { cookie }, ...wsOptions });
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
      await Promise.race([once(socket, 'close'), new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  });
  await once(socket, 'open');
  return socket;
}

async function attachTlsGateway(app) {
  const directory = await mkdtemp(join(tmpdir(), 'zhajinhua-wss-'));
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certificatePath,
    '-days', '1', '-subj', '/CN=127.0.0.1'
  ]);
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (request, response) => {
    app.server.emit('request', request, response);
  });
  const gateway = new WebSocketGateway({
    service: app.rooms,
    store: app.auth.store,
    findSession: app.auth.findSession,
    lifecycle: app.lifecycle
  });
  gateway.attach(server);
  app.lifecycle.setBroadcasters({
    room: (roomId, event) => gateway.broadcastRoom(roomId, event),
    global: (banner) => gateway.broadcastGlobal(banner)
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  cleanup.push(async () => {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return `https://127.0.0.1:${server.address().port}`;
}

describe('real WebSocket gateway', () => {
  it('authenticates sockets, broadcasts player chat, rejects spectator chat, and filters compare data', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const first = await register(app, 'socket-a@example.com', '实时甲');
    const second = await register(app, 'socket-b@example.com', '实时乙');
    const observer = await register(app, 'socket-c@example.com', '实时观战');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: { allowSpectators: true } })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.cookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/spectate`, headers: { cookie: observer.cookie }, payload: { enabled: true } });

    const playerSocket = await connect(origin, room.id, first.cookie);
    const observerSocket = await connect(origin, room.id, observer.cookie);
    const chatPromise = waitForMessage(observerSocket, (message) => message.event?.eventType === 'chat_message');
    playerSocket.send(JSON.stringify({ type: 'chat', text: '<b>大家好</b>' }));
    const chat = await chatPromise;
    expect(chat.event.payload.message).toMatchObject({ nickname: '实时甲', text: '<b>大家好</b>' });

    const errorPromise = waitForMessage(observerSocket, (message) => message.type === 'error');
    observerSocket.send(JSON.stringify({ type: 'chat', text: '观战发言' }));
    expect((await errorPromise).error).toMatch(/只能读取聊天/);

    const comparePromise = waitForMessage(playerSocket, (message) => message.event?.eventType === 'compare_started');
    app.gateway.broadcastRoom(room.id, {
      eventType: 'compare_started',
      payload: { attacker: '实时甲', target: '实时乙', cards: [{ rank: 14, suit: 'S' }], handType: '豹子', typeName: '豹子' }
    });
    expect(JSON.stringify(await comparePromise)).not.toMatch(/cards|handType|typeName/);
  });

  it('closes unauthenticated sockets with policy violation', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });

  it('closes authenticated sockets that request an unknown room with policy violation', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const account = await register(app, 'unknown-room@example.com', '未知房间');
    const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws?roomId=000000`, {
      headers: { cookie: account.cookie }
    });
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });

  it('closes authenticated sockets for a user who has not joined or entered spectator mode', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const owner = await register(app, 'access-owner@example.com', '房间房主');
    const stranger = await register(app, 'access-stranger@example.com', '陌生玩家');
    const room = (await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { cookie: owner.cookie },
      payload: { allowSpectators: true }
    })).json().room;
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?roomId=${room.id}`, {
      headers: { cookie: stranger.cookie }
    });
    cleanup.push(async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    });

    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });

  it('shares room-code and UUID sockets for broadcasts and disconnect accounting', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const account = await register(app, 'canonical-socket@example.com', '同房多页');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: account.cookie }, payload: {} })).json().room;
    const byCode = await connect(origin, room.code, account.cookie);
    const byId = await connect(origin, room.id, account.cookie);

    expect(app.lifecycle.connections.get(`${room.id}:${account.user.id}`)).toBe(2);
    const codeEvent = waitForMessage(byCode, (message) => message.event?.eventType === 'canonical_event');
    const idEvent = waitForMessage(byId, (message) => message.event?.eventType === 'canonical_event');
    app.gateway.broadcastRoom(room.id, { eventType: 'canonical_event', payload: { roomId: room.id } });
    await expect(Promise.all([codeEvent, idEvent])).resolves.toHaveLength(2);

    byCode.terminate();
    await once(byCode, 'close');
    await waitFor(() => app.lifecycle.connections.get(`${room.id}:${account.user.id}`) === 1);
    expect(app.lifecycle.connections.get(`${room.id}:${account.user.id}`)).toBe(1);
    expect(app.lifecycle.disconnectTimers.size).toBe(0);
  });

  it('closes every tab and clears connection tracking when the last player reclaims a room', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const account = await register(app, 'reclaim-tabs@example.com', '回收多页');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: account.cookie }, payload: {} })).json().room;
    const firstTab = await connect(origin, room.id, account.cookie);
    const secondTab = await connect(origin, room.code, account.cookie);
    const firstClosed = once(firstTab, 'close');
    const secondClosed = once(secondTab, 'close');

    const leave = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: account.cookie } });

    expect(leave.statusCode).toBe(200);
    await Promise.race([
      Promise.all([firstClosed, secondClosed]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('房间回收后 WebSocket 未关闭')), 1000))
    ]);
    expect(app.gateway.rooms.has(room.id)).toBe(false);
    expect(app.lifecycle.connections.has(`${room.id}:${account.user.id}`)).toBe(false);
    expect(app.lifecycle.disconnectTimers.size).toBe(0);
  });

  it('broadcasts Texas room-code events through the isolated namespace', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const account = await register(app, 'texas-ws-code@example.com', '德州订阅');
    const room = (await app.inject({
      method: 'POST',
      url: '/api/texas/rooms',
      headers: { cookie: account.cookie },
      payload: { buyIn: 1000 }
    })).json().room;
    const socket = await connect(origin, room.code, account.cookie, { game: 'texas' });
    const received = waitForMessage(socket, (message) => message.game === 'texas' && message.event?.eventType === 'texas_test_event');

    app.gateway.broadcastRoom(room.id, { id: 999, eventType: 'texas_test_event', payload: {} }, 'texas');

    await expect(received).resolves.toMatchObject({ game: 'texas', event: { eventType: 'texas_test_event' } });
  });

  (opensslAvailable ? it : it.skip)('authenticates and broadcasts chat over a local self-signed WSS server', async () => {
    const app = await buildApp({ logger: false });
    cleanup.push(() => app.close());
    const origin = await attachTlsGateway(app);
    const first = await register(app, 'wss-a@example.com', '加密甲');
    const second = await register(app, 'wss-b@example.com', '加密乙');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.cookie }, payload: {} })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.cookie }, payload: {} });
    const firstSocket = await connect(origin, room.id, first.cookie, { rejectUnauthorized: false });
    const secondSocket = await connect(origin, room.id, second.cookie, { rejectUnauthorized: false });

    const message = waitForMessage(secondSocket, (event) => event.event?.eventType === 'chat_message');
    firstSocket.send(JSON.stringify({ type: 'chat', text: '加密聊天室' }));
    expect((await message).event.payload.message).toMatchObject({ userId: first.user.id, text: '加密聊天室' });
  });
});
