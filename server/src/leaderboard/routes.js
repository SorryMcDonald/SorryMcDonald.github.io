import { appendBanner, appendRankingChanges, rankUsers, resolveUserTitles, snapshotRanking } from './ranking.js';
import { mutationQueueFor } from '../persistence/mutation-queue.js';

const REFILL_REWARDS = new Map([
  ['黄总大帅逼', 1_000],
  ['我是菜逼', 10_000]
]);

export { LOSS_TITLES, WIN_TITLES, appendBanner, appendRankingChanges, rankUsers, resolveUserTitles, snapshotRanking, titleFor } from './ranking.js';

export function registerLeaderboardRoutes(app, options = {}) {
  const store = options.store ?? app.auth?.store ?? { users: new Map(), banners: [] };
  const persistence = options.persistence;
  const mutationQueue = options.mutationQueue ?? mutationQueueFor(store);
  const refillQueues = new Map();
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
    const previousRefill = refillQueues.get(request.user.id) ?? Promise.resolve();
    const refill = previousRefill.catch(() => {}).then(() => mutationQueue.run(async () => {
      const user = store.users.get(request.user.id); if (!user) return reply.code(404).send({ error: '用户不存在' });
      if (Number(user.beans ?? 0) !== 0) return reply.code(409).send({ error: '余额不为零，不能领取补给' });
      const confirmationText = String(request.body?.confirmationText ?? '').trim();
      const refillAmount = REFILL_REWARDS.get(confirmationText);
      if (!refillAmount) return reply.code(400).send({ error: '确认文字不正确' });
      const generation = Number(user.refill_generation ?? 0);
      if (user.last_zero_generation !== null && user.last_zero_generation !== undefined && Number(user.last_zero_generation) === generation) return reply.code(409).send({ error: '本次归零已经领取过补给' });
      const beforeBannerCount = store.banners.length;
      const beforeRanking = snapshotRanking(store.users.values());
      const previous = { beans: user.beans, lastZeroGeneration: user.last_zero_generation };
      const fixed = appendBanner(store, 'economy', `${user.nickname}：${confirmationText}！`, { userId: user.id, amount: refillAmount });
      user.beans = Number(user.beans ?? 0) + refillAmount;
      user.last_zero_generation = generation;
      const rankingBanners = appendRankingChanges(store, beforeRanking, snapshotRanking(store.users.values()));
      const insertedBanners = [fixed, ...rankingBanners];
      try {
        await persistence?.flushStore?.(beforeBannerCount, insertedBanners);
      } catch (error) {
        user.beans = previous.beans;
        user.last_zero_generation = previous.lastZeroGeneration;
        for (const banner of insertedBanners) {
          const index = store.banners.indexOf(banner);
          if (index >= 0) store.banners.splice(index, 1);
        }
        throw error;
      }
      for (const banner of insertedBanners) app.gateway?.broadcastGlobal(banner);
      const titles = resolveUserTitles(store.users.values()).get(user.id) ?? [];
      return {
        user: { id: user.id, nickname: user.nickname, beans: user.beans, titles },
        refillAmount,
        banners: insertedBanners,
        events: [
          { type: 'fixed_banner', banner: fixed },
          { type: 'refill', amount: refillAmount, beans: user.beans },
          ...rankingBanners.map((banner) => ({ type: 'ranking_banner', banner }))
        ]
      };
    }));
    refillQueues.set(request.user.id, refill);
    try {
      return await refill;
    } finally {
      if (refillQueues.get(request.user.id) === refill) refillQueues.delete(request.user.id);
    }
  });
}
