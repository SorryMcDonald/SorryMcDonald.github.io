import { describe, expect, it } from 'vitest';
import { rankUsers, resolveUserTitles, titleFor } from '../src/leaderboard/routes.js';
import { buildApp } from '../src/index.js';
import { RoomService } from '../src/rooms/service.js';

describe('leaderboards and refill', () => {
  it('uses win/loss count as primary key and exposes the six titles', () => {
    const entries = rankUsers([{ id: 'b', nickname: '乙', wins: 3, losses: 1, beans: 2 }, { id: 'a', nickname: '甲', wins: 3, losses: 2, beans: 9 }], 'wins');
    expect(entries.map((entry) => entry.nickname)).toEqual(['甲', '乙']);
    expect(entries[0].title).toBe('赌神');
    expect(titleFor('losses', 1)).toBe('散财童子');
    expect(titleFor('wins', 5)).toBe('赌鬼');
    expect(titleFor('wins', 6)).toBe('');
    expect(titleFor('losses', 6)).toBe('');
  });

  it('ranks every account by wealth and shares wealth titles across tied extrema', () => {
    const users = [
      { id: 'c', nickname: '丙', wins: 0, losses: 0, beans: 10 },
      { id: 'b', nickname: '乙', wins: 1, losses: 4, beans: 90 },
      { id: 'a', nickname: '甲', wins: 4, losses: 1, beans: 90 },
      { id: 'd', nickname: '丁', wins: 2, losses: 2, beans: 10 },
    ];

    expect(rankUsers(users, 'wealth').map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    const titles = resolveUserTitles(users);
    expect(titles.get('a')).toEqual(expect.arrayContaining(['大富翁', '赌神']));
    expect(titles.get('b')).toEqual(expect.arrayContaining(['大富翁', '散财童子']));
    expect(titles.get('c')).toContain('穷乞丐');
    expect(titles.get('d')).toContain('穷乞丐');
  });

  it('does not assign wealth titles when every balance is equal', () => {
    const titles = resolveUserTitles([
      { id: 'a', nickname: '甲', wins: 0, losses: 0, beans: 100 },
      { id: 'b', nickname: '乙', wins: 0, losses: 0, beans: 100 },
    ]);
    expect(titles.get('a')).toEqual([]);
    expect(titles.get('b')).toEqual([]);
  });

  it('keeps the best single game title while preserving a simultaneous wealth title', () => {
    const titles = resolveUserTitles([
      { id: 'a', nickname: '甲', wins: 3, losses: 10, beans: 200 },
      { id: 'b', nickname: '乙', wins: 10, losses: 1, beans: 100 },
      { id: 'c', nickname: '丙', wins: 1, losses: 5, beans: 0 },
      { id: 'd', nickname: '丁', wins: 2, losses: 2, beans: 50 }
    ]);

    expect(titles.get('a')).toEqual(expect.arrayContaining(['散财童子', '大富翁']));
    expect(titles.get('a')).not.toContain('赌圣');
    expect(titles.get('b')).toContain('赌神');
    expect(titles.get('b')).not.toContain('赌霸');
    expect(titles.get('c')).toContain('赌鬼');
    expect(titles.get('c')).not.toContain('赌王');
    expect(titles.get('d')).toContain('赌王');
    expect(titles.get('d')).not.toContain('赌霸');
  });

  it('requires the exact refill text and orders fixed, refill, then ranking events', async () => {
    const app = await buildApp({ logger: false });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'zero@example.com', nickname: '归零', password: 'password-123' } });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'other@example.com', nickname: '余豆', password: 'password-123' } });
    const cookie = registration.headers['set-cookie'];
    const user = app.auth.store.users.get(registration.json().user.id); user.beans = 0; user.refill_generation = 1; user.last_zero_generation = null; user.losses = 4;
    const other = [...app.auth.store.users.values()].find((candidate) => candidate.id !== user.id); other.beans = 50000;

    const wrong = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '不正确' } });
    expect(wrong.statusCode).toBe(400);
    expect(user.beans).toBe(0);
    expect(app.auth.store.banners).toHaveLength(0);

    const first = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '黄总大帅逼' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().events.slice(0, 2).map((event) => event.type)).toEqual(['fixed_banner', 'refill']);
    expect(app.auth.store.banners[0]).toMatchObject({ message: '归零：黄总大帅逼！', payload: { amount: 1000 } });
    expect(app.auth.store.banners.slice(1).every((banner) => banner.queueName === 'leaderboard')).toBe(true);
    expect(first.json()).toMatchObject({ refillAmount: 1000, user: { beans: 1000 } });
    user.beans = 0;
    const second = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '黄总大帅逼' } });
    expect(second.statusCode).toBe(409);
    user.refill_generation = 2;
    const third = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '我是菜逼' } });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({ refillAmount: 10000, user: { beans: 10000 } });
    expect(third.json().banners[0]).toMatchObject({ message: '归零：我是菜逼！', payload: { amount: 10000 } });
    await app.close();
  });

  it('creates one refill generation for each all-in zero and permits only one refill per generation', async () => {
    const app = await buildApp({ logger: false });
    const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'all-in-zero-a@example.com', nickname: '梭哈甲', password: 'password-123' } });
    const second = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'all-in-zero-b@example.com', nickname: '梭哈乙', password: 'password-123' } });
    const third = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'all-in-zero-c@example.com', nickname: '梭哈丙', password: 'password-123' } });
    const firstUser = app.auth.store.users.get(first.json().user.id);
    const secondUser = app.auth.store.users.get(second.json().user.id);
    const firstCookie = first.headers['set-cookie'];
    const secondCookie = second.headers['set-cookie'];
    firstUser.beans = 100;
    secondUser.beans = 200;
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: firstCookie }, payload: { ante: 1 } })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: secondCookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: third.headers['set-cookie'] }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: firstCookie }, payload: {} });

    const initial = app.rooms.room(room.id);
    const firstPlayer = [...initial.players.values()].find((player) => player.userId === first.json().user.id);
    const secondPlayer = [...initial.players.values()].find((player) => player.userId === second.json().user.id);
    firstPlayer.cards = [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 5, suit: 'D' }];
    secondPlayer.cards = [{ rank: 14, suit: 'S' }, { rank: 14, suit: 'H' }, { rank: 14, suit: 'D' }];

    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: firstCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    expect(firstUser.refill_generation).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: firstCookie }, payload: { confirmationText: '黄总大帅逼' } })).statusCode).toBe(200);

    firstUser.beans = 0;
    expect((await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: firstCookie }, payload: { confirmationText: '黄总大帅逼' } })).statusCode).toBe(409);
    firstUser.beans = 100000;

    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: secondCookie }, payload: { action: 'all_in', actionSeq: 1 } });
    const settled = app.rooms.room(room.id);
    settled.dealerUserId = first.json().user.id;
    settled.dealerSeat = firstPlayer.seat;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: firstCookie }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/actions`, headers: { cookie: firstCookie }, payload: { action: 'all_in', actionSeq: 1 } });

    expect(firstUser.refill_generation).toBe(2);
    expect((await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: firstCookie }, payload: { confirmationText: '黄总大帅逼' } })).statusCode).toBe(200);
    await app.close();
  });

  it('emits independent ranking banners when settlement changes leaders and wealth extrema', () => {
    const store = {
      users: new Map([
        ['a', { id: 'a', nickname: '甲', beans: 100000, wins: 0, losses: 0 }],
        ['b', { id: 'b', nickname: '乙', beans: 100000, wins: 0, losses: 0 }]
      ]),
      sessions: new Map(),
      banners: []
    };
    const service = new RoomService({ store });
    const room = service.createRoom('a');
    service.joinRoom(room.id, 'b');
    service.startNextRound(room.id, 'a');
    service.action(room.id, 'a', { action: 'fold', actionSeq: 1 });

    expect(store.banners.some((banner) => banner.queueName === 'leaderboard' && banner.message.includes('赌神榜头名'))).toBe(true);
    expect(store.banners.some((banner) => banner.message.includes('大富翁'))).toBe(true);
    expect(store.banners.some((banner) => banner.message.includes('穷乞丐'))).toBe(true);
  });

  it('handles a large account set without spreading every balance into Math helpers', () => {
    const users = Array.from({ length: 200000 }, (_, index) => ({
      id: `user-${index}`,
      nickname: `玩家${index}`,
      beans: index,
      wins: 0,
      losses: 0
    }));

    expect(() => resolveUserTitles(users)).not.toThrow();
  });

  it('preserves concurrently appended banners when refill persistence fails', async () => {
    let enteredFlush;
    let rejectFlush;
    const flushStarted = new Promise((resolve) => { enteredFlush = resolve; });
    const flushGate = new Promise((resolve, reject) => { rejectFlush = reject; });
    const app = await buildApp({
      logger: false,
      persistence: {
        async flushStore() {
          enteredFlush();
          return flushGate;
        }
      }
    });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'rollback@example.com', nickname: '回滚', password: 'password-123' } });
    const user = app.auth.store.users.get(registration.json().user.id);
    user.beans = 0;
    user.refill_generation = 1;
    user.last_zero_generation = null;

    const pending = app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: registration.headers['set-cookie'] }, payload: { confirmationText: '黄总大帅逼' } });
    await flushStarted;
    const concurrent = { id: 9999, queueName: 'leaderboard', message: '并发横幅', payload: {}, createdAt: new Date().toISOString() };
    app.auth.store.banners.push(concurrent);
    rejectFlush(new Error('flush failed'));
    const response = await pending;

    expect(response.statusCode).toBe(500);
    expect(app.auth.store.banners).toContain(concurrent);
    expect(app.auth.store.banners.some((banner) => banner.message === '回滚：黄总大帅逼！')).toBe(false);
    await app.close();
  });

  it('serializes concurrent refill attempts and returns only their own banners', async () => {
    let enteredFlush;
    let releaseFlush;
    const flushStarted = new Promise((resolve) => { enteredFlush = resolve; });
    const flushGate = new Promise((resolve) => { releaseFlush = resolve; });
    const app = await buildApp({
      logger: false,
      persistence: {
        async flushStore() {
          enteredFlush();
          await flushGate;
        }
      }
    });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'concurrent-refill@example.com', nickname: '并发补豆', password: 'password-123' } });
    const user = app.auth.store.users.get(registration.json().user.id);
    user.beans = 0;
    user.refill_generation = 1;
    user.last_zero_generation = null;
    const request = () => app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie: registration.headers['set-cookie'] }, payload: { confirmationText: '黄总大帅逼' } });

    const first = request();
    await flushStarted;
    const second = request();
    const concurrent = { id: 9998, queueName: 'leaderboard', message: '其他操作横幅', payload: {}, createdAt: new Date().toISOString() };
    app.auth.store.banners.push(concurrent);
    releaseFlush();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const success = responses.find((response) => response.statusCode === 200).json();
    expect(success.banners.some((banner) => banner.message === concurrent.message)).toBe(false);
    expect(app.auth.store.banners.filter((banner) => banner.message === '并发补豆：黄总大帅逼！')).toHaveLength(1);
    await app.close();
  });

  it('waits for a failing room persistence rollback before evaluating refill eligibility', async () => {
    let blockRoomFlush = false;
    let roomFlushStarted;
    let rejectRoomFlush;
    const started = new Promise((resolve) => { roomFlushStarted = resolve; });
    const gate = new Promise((resolve, reject) => { rejectRoomFlush = reject; });
    let storeFlushes = 0;
    const app = await buildApp({
      logger: false,
      persistence: {
        async flushRoom() {
          if (!blockRoomFlush) return;
          roomFlushStarted();
          await gate;
        },
        async flushStore() {
          storeFlushes += 1;
        }
      }
    });
    const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'room-refill-race-a@example.com', nickname: '竞态甲', password: 'password-123' } });
    const second = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'room-refill-race-b@example.com', nickname: '竞态乙', password: 'password-123' } });
    const third = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'room-refill-race-c@example.com', nickname: '竞态丙', password: 'password-123' } });
    const firstUser = app.auth.store.users.get(first.json().user.id);
    firstUser.beans = 1;
    const room = (await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: first.headers['set-cookie'] }, payload: { ante: 1 } })).json().room;
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: second.headers['set-cookie'] }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: third.headers['set-cookie'] }, payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/start-next`, headers: { cookie: first.headers['set-cookie'] }, payload: {} });
    const current = [...app.rooms.room(room.id).players.values()].find((player) => player.seat === app.rooms.room(room.id).currentTurn);
    const currentCookie = current.userId === firstUser.id ? first.headers['set-cookie'] : second.headers['set-cookie'];
    const currentUser = app.auth.store.users.get(current.userId);
    currentUser.beans = 1;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;

    blockRoomFlush = true;
    const action = fetch(`${origin}/api/rooms/${room.id}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: currentCookie },
      body: JSON.stringify({ action: 'all_in', actionSeq: 1 })
    });
    await started;
    const refill = fetch(`${origin}/api/me/refill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: currentCookie },
      body: JSON.stringify({ confirmationText: '黄总大帅逼' })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    rejectRoomFlush(new Error('room flush failed'));
    const [actionResponse, refillResponse] = await Promise.all([action, refill]);

    expect(actionResponse.status).toBe(500);
    expect(refillResponse.status).toBe(409);
    expect(currentUser.beans).toBe(1);
    expect(storeFlushes).toBe(0);
    expect(app.auth.store.banners.some((banner) => banner.message === `${currentUser.nickname}：黄总大帅逼！`)).toBe(false);
    await app.close();
  });
});
