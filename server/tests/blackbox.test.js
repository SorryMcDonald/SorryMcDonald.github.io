import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

const runtimes = [];

afterEach(async () => {
  while (runtimes.length) await runtimes.pop().close();
});

async function startBlackBoxServer() {
  const app = await buildApp({ logger: false, attachGateway: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const runtime = { app, origin: `http://127.0.0.1:${app.server.address().port}`, close: () => app.close() };
  runtimes.push(runtime);
  return runtime;
}

async function request(origin, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

async function register(origin, index, prefix = 'blackbox') {
  const response = await request(origin, '/api/auth/register', {
    method: 'POST',
    body: { email: `${prefix}-${index}@example.test`, nickname: `${prefix}玩家${index}`, password: 'password-123' }
  });
  expect(response.status).toBe(201);
  return { ...response.body.user, cookie: response.cookie };
}

async function createRoom(origin, accounts, options = {}) {
  const created = await request(origin, '/api/rooms', { method: 'POST', cookie: accounts[0].cookie, body: options });
  expect(created.status).toBe(200);
  for (const account of accounts.slice(1)) {
    const joined = await request(origin, `/api/rooms/${created.body.room.id}/join`, { method: 'POST', cookie: account.cookie, body: {} });
    expect(joined.status).toBe(200);
  }
  return created.body.room;
}

async function connect(origin, roomId, cookie) {
  const suffix = roomId ? `?roomId=${roomId}` : '';
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws${suffix}`, { headers: { cookie } });
  await once(socket, 'open');
  return socket;
}

async function closeSocket(socket) {
  if (socket.readyState >= WebSocket.CLOSING) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

async function waitFor(predicate, timeout = 5000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('等待公开状态更新超时');
}

describe('public black-box gameplay', () => {
  it('starts two and six player rooms, rejects a seventh seat, and keeps all starting hands hidden', async () => {
    const { origin } = await startBlackBoxServer();
    const players = await Promise.all(Array.from({ length: 7 }, (_, index) => register(origin, index, 'seat')));
    const room = await createRoom(origin, players.slice(0, 6));
    const full = await request(origin, `/api/rooms/${room.id}/join`, { method: 'POST', cookie: players[6].cookie, body: {} });
    expect(full.status).toBe(409);
    const started = await request(origin, `/api/rooms/${room.id}/start-next`, { method: 'POST', cookie: players[0].cookie, body: {} });
    expect(started.status).toBe(200);
    expect(started.body.room.players).toHaveLength(6);
    expect(started.body.room.players.every((player) => player.cardCount === 3 && !player.cards)).toBe(true);

    const two = await Promise.all([register(origin, 0, 'two'), register(origin, 1, 'two')]);
    const twoRoom = await createRoom(origin, two);
    const twoStarted = await request(origin, `/api/rooms/${twoRoom.id}/start-next`, { method: 'POST', cookie: two[0].cookie, body: {} });
    expect(twoStarted.status).toBe(200);
    expect(twoStarted.body.room.players).toHaveLength(2);
  });

  it('keeps see non-advancing, doubles seen charges, and supports fixed and custom raises', async () => {
    const { origin } = await startBlackBoxServer();
    const players = await Promise.all([register(origin, 0, 'raise'), register(origin, 1, 'raise')]);
    const room = await createRoom(origin, players, { ante: 10 });
    const started = await request(origin, `/api/rooms/${room.id}/start-next`, { method: 'POST', cookie: players[0].cookie, body: {} });
    const originalTurn = started.body.room.currentTurn;

    const seen = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'see' } });
    expect(seen.body.room.currentTurn).toBe(originalTurn);
    expect(seen.body.room.players.find((player) => player.userId === players[0].id).cards).toHaveLength(3);
    await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'call', actionSeq: 1 } });
    expect((await request(origin, '/api/auth/me', { cookie: players[0].cookie })).body.user.beans).toBe(99970);
    await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[1].cookie, body: { action: 'call', actionSeq: 1 } });

    const fixed = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'raise', amount: 20, actionSeq: 2 } });
    expect(fixed.body.room.level).toBe(20);
    await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[1].cookie, body: { action: 'call', actionSeq: 2 } });
    const custom = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'raise', amount: 35, actionSeq: 3 } });
    expect(custom.status).toBe(200);
    expect(custom.body.room.level).toBe(35);
    expect((await request(origin, '/api/auth/me', { cookie: players[0].cookie })).body.user.beans).toBe(99860);
  });

  it('requires an explicit comparison target and publishes only independently revealed hands before settlement', async () => {
    const { origin } = await startBlackBoxServer();
    const players = await Promise.all([register(origin, 0, 'compare'), register(origin, 1, 'compare'), register(origin, 2, 'compare')]);
    const room = await createRoom(origin, players);
    const started = await request(origin, `/api/rooms/${room.id}/start-next`, { method: 'POST', cookie: players[0].cookie, body: {} });
    const target = started.body.room.players.find((player) => player.userId === players[1].id);
    const missing = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'compare', actionSeq: 1 } });
    expect(missing.status).toBe(400);

    const compared = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'compare', targetSeat: target.seat, actionSeq: 1 } });
    expect(compared.status).toBe(200);
    expect(compared.body.room.status).toBe('betting');
    expect(compared.body.room.players.find((player) => player.userId === players[0].id).mayReveal).toBe(true);
    const targetView = await request(origin, `/api/rooms/${room.id}`, { cookie: players[1].cookie });
    expect(targetView.body.room.players.find((player) => player.userId === players[1].id).mayReveal).toBe(true);
    expect(JSON.stringify(compared.body.room)).not.toMatch(/handType/);

    const revealed = await request(origin, `/api/rooms/${room.id}/actions`, { method: 'POST', cookie: players[0].cookie, body: { action: 'reveal' } });
    expect(revealed.status).toBe(200);
    const thirdView = await request(origin, `/api/rooms/${room.id}`, { cookie: players[2].cookie });
    expect(thirdView.body.room.players.find((player) => player.userId === players[0].id).cards).toHaveLength(3);
    expect(thirdView.body.room.players.find((player) => player.userId === players[1].id)).not.toHaveProperty('cards');
  });

  it('retains only the latest twenty plain-text room messages and enforces sender rate limits', async () => {
    const { origin } = await startBlackBoxServer();
    const players = await Promise.all(Array.from({ length: 6 }, (_, index) => register(origin, index, 'chat')));
    const room = await createRoom(origin, players);
    const sockets = await Promise.all(players.map((player) => connect(origin, room.id, player.cookie)));
    const texts = Array.from({ length: 21 }, (_, index) => `<b>消息-${index + 1}</b>`);
    for (let offset = 0; offset < texts.length; offset += 6) {
      const batch = texts.slice(offset, offset + 6);
      batch.forEach((text, index) => sockets[index].send(JSON.stringify({ type: 'chat', text })));
      if (offset + 6 < texts.length) await new Promise((resolve) => setTimeout(resolve, 1050));
    }
    const snapshot = await waitFor(async () => {
      const response = await request(origin, `/api/rooms/${room.id}`, { cookie: players[0].cookie });
      return response.body.room.messages?.length === 20 ? response.body.room : null;
    });
    expect(snapshot.messages).toHaveLength(20);
    expect(snapshot.messages.some((message) => message.text === '<b>消息-1</b>')).toBe(false);
    expect(snapshot.messages.at(-1).text).toBe('<b>消息-21</b>');

    const errorPromise = new Promise((resolve) => {
      const onMessage = (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type !== 'error') return;
        sockets[0].off('message', onMessage);
        resolve(parsed);
      };
      sockets[0].on('message', onMessage);
    });
    sockets[0].send(JSON.stringify({ type: 'chat', text: '过快一' }));
    sockets[0].send(JSON.stringify({ type: 'chat', text: '过快二' }));
    const error = await errorPromise;
    expect(error.error).toMatch(/过快/);
    await Promise.all(sockets.map(closeSocket));
  }, 15_000);

  it('requires manual refill text, broadcasts the fixed banner first, and exposes all three leaderboards', async () => {
    const { origin } = await startBlackBoxServer();
    const players = await Promise.all([register(origin, 0, 'refill'), register(origin, 1, 'refill')]);
    const room = await createRoom(origin, players, { ante: 100000 });
    await request(origin, `/api/rooms/${room.id}/start-next`, { method: 'POST', cookie: players[0].cookie, body: {} });
    const balances = await Promise.all(players.map((player) => request(origin, '/api/auth/me', { cookie: player.cookie })));
    const zeroIndex = balances.findIndex((response) => response.body.user.beans === 0);
    expect(zeroIndex).toBeGreaterThanOrEqual(0);
    const loser = players[zeroIndex];
    const wrong = await request(origin, '/api/me/refill', { method: 'POST', cookie: loser.cookie, body: { confirmationText: '错误' } });
    expect(wrong.status).toBe(400);

    const global = await connect(origin, null, loser.cookie);
    const messages = [];
    global.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'global_banner') messages.push(message.banner);
    });
    const correct = await request(origin, '/api/me/refill', { method: 'POST', cookie: loser.cookie, body: { confirmationText: '黄总大帅逼' } });
    expect(correct.status).toBe(200);
    expect(correct.body.events.slice(0, 2).map((event) => event.type)).toEqual(['fixed_banner', 'refill']);
    expect(correct.body).toMatchObject({ refillAmount: 1000, user: { beans: 1000 } });
    await waitFor(() => messages.length >= correct.body.banners.length && messages);
    expect(messages[0]).toMatchObject({ queueName: 'economy', message: `${loser.nickname}：黄总大帅逼！`, payload: { amount: 1000 } });
    for (const kind of ['wealth', 'wins', 'losses']) {
      const ranking = await request(origin, `/api/leaderboards?kind=${kind}`, { cookie: loser.cookie });
      expect(ranking.status).toBe(200);
      expect(ranking.body.kind).toBe(kind);
      expect(ranking.body.entries.every((entry) => Array.isArray(entry.titles))).toBe(true);
    }
    await closeSocket(global);
  });

  it('keeps actions open indefinitely while still expiring disconnected rooms', async () => {
    const { origin } = await startBlackBoxServer();
    const actionPlayers = await Promise.all([register(origin, 0, 'timeout'), register(origin, 1, 'timeout')]);
    const actionRoom = await createRoom(origin, actionPlayers);
    await request(origin, `/api/rooms/${actionRoom.id}/start-next`, { method: 'POST', cookie: actionPlayers[0].cookie, body: {} });

    const disconnected = await register(origin, 0, 'disconnect');
    const disconnectRoom = await createRoom(origin, [disconnected]);
    const firstSocket = await connect(origin, disconnectRoom.id, disconnected.cookie);
    await closeSocket(firstSocket);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reconnected = await connect(origin, disconnectRoom.id, disconnected.cookie);
    await closeSocket(reconnected);

    await new Promise((resolve) => setTimeout(resolve, 60_500));
    const timedOut = await request(origin, `/api/rooms/${actionRoom.id}`, { cookie: actionPlayers[1].cookie });
    expect(timedOut.status).toBe(200);
    expect(timedOut.body.room.status).toBe('betting');
    expect(timedOut.body.room.players.every((player) => player.lastAction !== 'timeout_fold')).toBe(true);
    const reclaimed = await request(origin, `/api/rooms/${disconnectRoom.id}`, { cookie: disconnected.cookie });
    expect(reclaimed.status).toBe(404);
  }, 70_000);
});
