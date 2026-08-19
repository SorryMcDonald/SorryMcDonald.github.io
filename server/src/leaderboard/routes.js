import { rankUsers, resolveUserTitles } from './ranking.js';

export { LOSS_TITLES, WIN_TITLES, rankUsers, resolveUserTitles, titleFor } from './ranking.js';

export function registerLeaderboardRoutes(app, options = {}) {
  const store = options.store ?? app.auth?.store ?? { users: new Map(), banners: [] };
  const persistence = options.persistence;
  if (!store.banners) store.banners = [];
  app.decorate('banners', store.banners);
  app.get('/api/leaderboards', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '需要登录' });
    const kind = ['wealth', 'wins', 'losses'].includes(request.query?.kind) ? request.query.kind : 'wins';
    const titles = resolveUserTitles(store.users.values());
    return { kind, entries: rankUsers(store.users.values(), kind, request.query?.limit).map((entry) => ({ ...entry, titles: titles.get(entry.id) ?? [], title: (titles.get(entry.id) ?? [entry.title]).filter(Boolean)[0] ?? '' })) };
  });
  app.post('/api/me/refill', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '需要登录' });
    const user = store.users.get(request.user.id); if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (Number(user.beans ?? 0) !== 0) return reply.code(409).send({ error: '余额不为零，不能领取补给' });
    if (user.last_zero_generation === user.refill_generation) return reply.code(409).send({ error: '本次归零已经领取过补给' });
    const beforeBannerCount = store.banners.length;
    if (user.zero_banner_generation !== user.refill_generation) { store.banners.push({ id: store.banners.length + 1, queueName: 'economy', message: `${user.nickname}：黄总是大帅比！`, createdAt: new Date().toISOString() }); user.zero_banner_generation = user.refill_generation; }
    user.beans = 100000; user.last_zero_generation = user.refill_generation;
    const losers = rankUsers(store.users.values(), 'losses'); if (losers[0]?.id === user.id) store.banners.push({ id: store.banners.length + 1, queueName: 'leaderboard', message: `${user.nickname}恭喜登上散财榜头名`, createdAt: new Date().toISOString() });
    await persistence?.flushStore(beforeBannerCount);
    for (const banner of store.banners.slice(beforeBannerCount)) app.gateway?.broadcastGlobal(banner);
    return { user: { id: user.id, nickname: user.nickname, beans: user.beans }, banners: store.banners.slice(-2) };
  });
}
