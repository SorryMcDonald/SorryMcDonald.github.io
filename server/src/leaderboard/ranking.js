export const WIN_TITLES = ['赌神', '赌圣', '赌王', '赌霸', '赌鬼'];
export const LOSS_TITLES = ['散财童子', '赌鬼', '赌霸', '赌王', '赌圣'];

export function titleFor(kind, rank) {
  const titles = kind === 'losses' ? LOSS_TITLES : WIN_TITLES;
  return titles[Math.max(0, Number(rank) - 1)] ?? titles.at(-1);
}

function primaryKey(kind) {
  if (kind === 'wealth') return 'beans';
  if (kind === 'losses') return 'losses';
  return 'wins';
}

export function rankUsers(users, kind = 'wins', limit = 100) {
  const key = primaryKey(kind);
  const values = [...users].filter((user) => kind === 'wealth' || Number(user[key] ?? 0) > 0);
  return values
    .sort((left, right) => Number(right[key] ?? 0) - Number(left[key] ?? 0)
      || String(left.nickname).localeCompare(String(right.nickname), 'zh-CN')
      || String(left.id).localeCompare(String(right.id)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000)))
    .map((user, index) => ({
      rank: index + 1,
      id: user.id,
      nickname: user.nickname,
      beans: Number(user.beans ?? 0),
      wins: Number(user.wins ?? 0),
      losses: Number(user.losses ?? 0),
      title: kind === 'wealth' ? '' : titleFor(kind, index + 1)
    }));
}

function addTitle(titles, userId, title) {
  const current = titles.get(userId);
  if (current && !current.includes(title)) current.push(title);
}

export function resolveUserTitles(users) {
  const values = [...users];
  const titles = new Map(values.map((user) => [user.id, []]));
  for (const entry of rankUsers(values, 'wins', 1000)) addTitle(titles, entry.id, titleFor('wins', entry.rank));
  for (const entry of rankUsers(values, 'losses', 1000)) addTitle(titles, entry.id, titleFor('losses', entry.rank));

  const balances = values.map((user) => Number(user.beans ?? 0));
  if (balances.length > 1 && Math.min(...balances) !== Math.max(...balances)) {
    const richest = Math.max(...balances);
    const poorest = Math.min(...balances);
    for (const user of values) {
      if (Number(user.beans ?? 0) === richest) addTitle(titles, user.id, '大富翁');
      if (Number(user.beans ?? 0) === poorest) addTitle(titles, user.id, '穷乞丐');
    }
  }
  return titles;
}

function wealthExtrema(users) {
  const values = [...users];
  if (values.length < 2) return { richest: [], poorest: [] };
  const balances = values.map((user) => Number(user.beans ?? 0));
  const richestBalance = Math.max(...balances);
  const poorestBalance = Math.min(...balances);
  if (richestBalance === poorestBalance) return { richest: [], poorest: [] };
  return {
    richest: values.filter((user) => Number(user.beans ?? 0) === richestBalance).map((user) => user.id).sort(),
    poorest: values.filter((user) => Number(user.beans ?? 0) === poorestBalance).map((user) => user.id).sort()
  };
}

export function snapshotRanking(users) {
  const values = [...users];
  const extrema = wealthExtrema(values);
  return {
    wins: rankUsers(values, 'wins', 1)[0]?.id ?? null,
    losses: rankUsers(values, 'losses', 1)[0]?.id ?? null,
    richest: extrema.richest,
    poorest: extrema.poorest
  };
}

function nextBannerId(banners) {
  return banners.reduce((maximum, banner) => Math.max(maximum, Number(banner.id) || 0), 0) + 1;
}

export function appendBanner(store, queueName, message, payload = {}, bannerType) {
  const banner = {
    id: nextBannerId(store.banners),
    queueName,
    bannerType: bannerType ?? (queueName === 'economy' ? 'zero_balance' : 'leaderboard_first'),
    message,
    payload,
    createdAt: new Date().toISOString()
  };
  store.banners.push(banner);
  return banner;
}

export function appendRankingChanges(store, before, after) {
  const added = [];
  const nickname = (userId) => store.users.get(userId)?.nickname ?? '玩家';
  if (after.wins && after.wins !== before.wins) {
    added.push(appendBanner(store, 'leaderboard', `${nickname(after.wins)}登上赌神榜头名`, { kind: 'wins', userId: after.wins }));
  }
  if (after.losses && after.losses !== before.losses) {
    added.push(appendBanner(store, 'leaderboard', `${nickname(after.losses)}恭喜登上散财榜头名`, { kind: 'losses', userId: after.losses }));
  }
  for (const userId of after.richest.filter((id) => !before.richest.includes(id))) {
    added.push(appendBanner(store, 'leaderboard', `${nickname(userId)}获得大富翁称号`, { kind: 'wealth', title: '大富翁', userId }, 'wealth_title'));
  }
  for (const userId of after.poorest.filter((id) => !before.poorest.includes(id))) {
    added.push(appendBanner(store, 'leaderboard', `${nickname(userId)}获得穷乞丐称号`, { kind: 'wealth', title: '穷乞丐', userId }, 'wealth_title'));
  }
  return added;
}
