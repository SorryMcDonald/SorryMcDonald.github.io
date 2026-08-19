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

    const first = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '黄总是大帅比' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().events.slice(0, 2).map((event) => event.type)).toEqual(['fixed_banner', 'refill']);
    expect(app.auth.store.banners[0].message).toBe('归零：黄总是大帅比！');
    expect(app.auth.store.banners.slice(1).every((banner) => banner.queueName === 'leaderboard')).toBe(true);
    expect(first.json().user).toMatchObject({ beans: 100000, titles: expect.arrayContaining(['大富翁']) });
    user.beans = 0;
    const second = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '黄总是大帅比' } });
    expect(second.statusCode).toBe(409);
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
});
