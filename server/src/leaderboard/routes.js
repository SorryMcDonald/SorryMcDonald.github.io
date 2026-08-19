export const WIN_TITLES = ['赌神', '赌圣', '赌王', '赌霸', '赌鬼'];
export const LOSS_TITLES = ['散财童子', '赌鬼', '赌霸', '赌王', '赌圣'];

export function titleFor(kind, rank) { return (kind === 'losses' ? LOSS_TITLES : WIN_TITLES)[Math.max(0, Number(rank) - 1)] ?? (kind === 'losses' ? '散财童子' : '赌鬼'); }

export function rankUsers(users, kind, limit = 100) {
  const key = kind === 'losses' ? 'losses' : 'wins';
  return [...users].filter((user) => Number(user[key] ?? 0) > 0).sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0) || String(a.nickname).localeCompare(String(b.nickname), 'zh-CN') || String(a.id).localeCompare(String(b.id))).slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000))).map((user, index) => ({ rank: index + 1, id: user.id, nickname: user.nickname, beans: Number(user.beans ?? 0), wins: Number(user.wins ?? 0), losses: Number(user.losses ?? 0), title: titleFor(key, index + 1) }));
}

export function resolveUserTitles(users) {
  const values = [...users]; const wins = rankUsers(values, 'wins', 1000); const losses = rankUsers(values, 'losses', 1000); const titles = new Map();
  for (const entry of [...wins.map((entry) => ({ ...entry, kind: 'wins' })), ...losses.map((entry) => ({ ...entry, kind: 'losses' }))]) {
    const current = titles.get(entry.id); if (!current || entry.rank < current.rank || (entry.rank === current.rank && entry.kind === 'wins')) titles.set(entry.id, { rank: entry.rank, kind: entry.kind, title: titleFor(entry.kind, entry.rank) });
  }
  return titles;
}

export function registerLeaderboardRoutes(app, options = {}) {
  const store = options.store ?? app.auth?.store ?? { users: new Map(), banners: [] };
  const persistence = options.persistence;
  if (!store.banners) store.banners = [];
  app.decorate('banners', store.banners);
  app.get('/api/leaderboards', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '需要登录' });
    const kind = request.query?.kind === 'losses' ? 'losses' : 'wins';
    const titles = resolveUserTitles(store.users.values());
    return { kind, entries: rankUsers(store.users.values(), kind, request.query?.limit).map((entry) => ({ ...entry, title: titles.get(entry.id)?.title ?? entry.title })) };
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
