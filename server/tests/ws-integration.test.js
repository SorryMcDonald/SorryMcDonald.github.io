import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

const cleanup = [];

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

async function connect(origin, roomId, cookie) {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?roomId=${roomId}`, { headers: { cookie } });
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
      await Promise.race([once(socket, 'close'), new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  });
  await once(socket, 'open');
  return socket;
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

  it('closes every canonical room tab when the last player reclaims a room', async () => {
    const app = await buildApp({ logger: false, attachGateway: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const account = await register(app, 'texas-integration-reclaim@example.com', '回收多页');
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: account.cookie }, payload: {} })).json().room;
    const firstTab = await connect(origin, room.id, account.cookie);
    const secondTab = await connect(origin, room.code, account.cookie);
    const firstClosed = once(firstTab, 'close');
    const secondClosed = once(secondTab, 'close');

    const leave = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: { cookie: account.cookie } });

    expect(leave.statusCode).toBe(200);
    await expect(Promise.all([firstClosed, secondClosed])).resolves.toHaveLength(2);
    expect(app.gateway.rooms.has(room.id)).toBe(false);
    expect(app.lifecycle.connections.has(`${room.id}:${account.user.id}`)).toBe(false);
  });
});
