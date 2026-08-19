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
