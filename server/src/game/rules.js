const HAND_NAMES = ['','单张','对子','顺子','金花','顺金','豹子'];

function positiveSafeInteger(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw Object.assign(new Error(`${label}必须是正整数`), { statusCode: 400 });
  }
  return amount;
}

export function actionCost({ level, seen = false, action = 'call' } = {}) {
  const base = positiveSafeInteger(level, '下注档位');
  const charge = base * (action === 'compare' ? 2 : 1) * (seen ? 2 : 1);
  if (!Number.isSafeInteger(charge)) {
    throw Object.assign(new Error('下注金额超出安全范围'), { statusCode: 400 });
  }
  return charge;
}

export function validateRaise({ amount, level, balance, seen = false } = {}) {
  const base = positiveSafeInteger(amount, '加注金额');
  const current = positiveSafeInteger(level, '当前档位');
  if (base <= current) {
    throw Object.assign(new Error('加注档位必须高于当前档位'), { statusCode: 400 });
  }
  const charge = base * (seen ? 2 : 1);
  if (!Number.isSafeInteger(charge)) {
    throw Object.assign(new Error('下注金额超出安全范围'), { statusCode: 400 });
  }
  if (charge > Number(balance ?? 0)) {
    throw Object.assign(new Error('下注豆子不足'), { statusCode: 400 });
  }
  return { base, charge };
}

export function evaluateHand(cards = []) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('炸金花需要三张牌');
  const ranks = cards.map((card) => Number(card.rank)).sort((a, b) => a - b);
  const desc = [...ranks].sort((a, b) => b - a);
  const suits = cards.map((card) => card.suit);
  const flush = suits.every((suit) => suit === suits[0]);
  const aceLow = ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14;
  const straight = aceLow || (ranks[1] === ranks[0] + 1 && ranks[2] === ranks[1] + 1);
  const high = aceLow ? 3 : ranks[2];
  if (desc[0] === desc[2]) return { name: '豹子', typeName: '豹子', lv: 6, cmp: [desc[0]] };
  if (flush && straight) return { name: '顺金', typeName: '顺金', lv: 5, cmp: [high] };
  if (flush) return { name: '金花', typeName: '金花', lv: 4, cmp: desc };
  if (straight) return { name: '顺子', typeName: '顺子', lv: 3, cmp: [high] };
  if (desc[0] === desc[1]) return { name: '对子', typeName: '对子', lv: 2, cmp: [desc[0], desc[2]] };
  if (desc[1] === desc[2]) return { name: '对子', typeName: '对子', lv: 2, cmp: [desc[1], desc[0]] };
  return { name: '单张', typeName: '单张', lv: 1, cmp: desc };
}

export function compareHands(left, right) {
  const a = left?.lv === undefined ? evaluateHand(left) : left;
  const b = right?.lv === undefined ? evaluateHand(right) : right;
  if (a.lv !== b.lv) return a.lv - b.lv;
  const length = Math.max(a.cmp?.length ?? 0, b.cmp?.length ?? 0);
  for (let index = 0; index < length; index += 1) {
    const delta = (a.cmp?.[index] ?? 0) - (b.cmp?.[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function calculateSidePotPayouts(players = []) {
  const contributionOf = (player) => Number(player.contribution ?? player.totalContribution ?? player.totalBet ?? 0);
  const active = players.filter((player) => contributionOf(player) > 0);
  const levels = [...new Set(active.map(contributionOf))].sort((a, b) => a - b);
  const payouts = Object.fromEntries(players.map((player) => [player.id ?? player.seat, 0]));
  let previous = 0;
  for (const level of levels) {
    const contributors = active.filter((player) => contributionOf(player) >= level);
    const pot = (level - previous) * contributors.length;
    const eligible = contributors.filter((player) => !player.folded && !player.eliminated);
    if (pot > 0 && eligible.length) {
      let winners = eligible;
      if (eligible.some((player) => player.hand || player.cards)) {
        winners = eligible.reduce((best, player) => {
          if (!best.length) return [player];
          const result = compareHands(player.hand ?? player.cards, best[0].hand ?? best[0].cards);
          if (result > 0) return [player];
          if (result === 0) return [...best, player];
          return best;
        }, []);
      }
      const share = Math.floor(pot / winners.length);
      let remainder = pot - share * winners.length;
      for (const winner of [...winners].sort((a, b) => Number(a.seat ?? 0) - Number(b.seat ?? 0))) {
        payouts[winner.id ?? winner.seat] += share + (remainder-- > 0 ? 1 : 0);
      }
    }
    previous = level;
  }
  return payouts;
}

export function netChange({ payout = 0, totalContribution = 0, totalBet = 0 } = {}) {
  return Number(payout) - Number(totalContribution || totalBet || 0);
}

export function selectDealer(results = []) {
  return [...results]
    .filter((result) => result && result.active !== false && result.beans !== 0 && result.spectating !== true)
    .sort((a, b) => Number(b.net ?? 0) - Number(a.net ?? 0) || Number(b.settledOrder ?? 0) - Number(a.settledOrder ?? 0) || Number(a.seat ?? 0) - Number(b.seat ?? 0))[0] ?? null;
}

export function shouldSettle({ alive = 0, actionable = 0, allMatched = false, allActed = false } = {}) {
  if (alive <= 1) return true;
  if (actionable === 0) return true;
  return Boolean(allMatched && allActed);
}

export function buildCompareEvents({ attacker, target, fee = 0, attackerWon } = {}) {
  return [
    { type: 'compare_started', attacker, target, fee },
    { type: 'compare_resolved', winner: attackerWon ? attacker : target, loser: attackerWon ? target : attacker }
  ];
}

export function handName(level) { return HAND_NAMES[level] ?? '未知'; }
