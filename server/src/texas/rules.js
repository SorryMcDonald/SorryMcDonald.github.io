const HAND_NAMES = ['', '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function rankCounts(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(Number(card.rank), (counts.get(Number(card.rank)) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks.map(Number))].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique.slice(index, index + 5).every((rank, offset) => rank === unique[index] - offset)) return unique[index];
  }
  return 0;
}

export function evaluateFive(cards = []) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error('德州五张牌判定需要五张牌');
  const ranks = cards.map((card) => Number(card.rank)).sort((a, b) => b - a);
  const groups = rankCounts(cards);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(ranks);
  if (flush && straight) return { level: 9, name: HAND_NAMES[9], values: [straight], cards };
  if (groups[0][1] === 4) return { level: 8, name: HAND_NAMES[8], values: [groups[0][0], groups[1][0]], cards };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { level: 7, name: HAND_NAMES[7], values: [groups[0][0], groups[1][0]], cards };
  if (flush) return { level: 6, name: HAND_NAMES[6], values: ranks, cards };
  if (straight) return { level: 5, name: HAND_NAMES[5], values: [straight], cards };
  if (groups[0][1] === 3) return { level: 4, name: HAND_NAMES[4], values: [groups[0][0], ...groups.filter((entry) => entry[1] === 1).map((entry) => entry[0]).sort((a, b) => b - a)], cards };
  const pairs = groups.filter((entry) => entry[1] === 2).map((entry) => entry[0]).sort((a, b) => b - a);
  if (pairs.length === 2) return { level: 3, name: HAND_NAMES[3], values: [...pairs, groups.find((entry) => entry[1] === 1)[0]], cards };
  if (pairs.length === 1) return { level: 2, name: HAND_NAMES[2], values: [pairs[0], ...groups.filter((entry) => entry[1] === 1).map((entry) => entry[0]).sort((a, b) => b - a)], cards };
  return { level: 1, name: HAND_NAMES[1], values: ranks, cards };
}

export function compareEvaluations(left, right) {
  if (left.level !== right.level) return left.level - right.level;
  for (let index = 0; index < Math.max(left.values.length, right.values.length); index += 1) {
    const delta = Number(left.values[index] ?? 0) - Number(right.values[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function combinations(cards, count, start = 0, prefix = [], result = []) {
  if (prefix.length === count) { result.push(prefix); return result; }
  for (let index = start; index <= cards.length - (count - prefix.length); index += 1) combinations(cards, count, index + 1, [...prefix, cards[index]], result);
  return result;
}

export function evaluateTexasHand(cards = []) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new Error('德州牌型需要五至七张牌');
  return combinations(cards, 5).map(evaluateFive).reduce((best, value) => compareEvaluations(value, best) > 0 ? value : best);
}

export function calculateTexasPots(players = [], dealerSeat = 0) {
  const contributed = players.filter((player) => Number(player.totalContribution ?? 0) > 0);
  const levels = [...new Set(contributed.map((player) => Number(player.totalContribution)))].sort((a, b) => a - b);
  const payouts = Object.fromEntries(players.map((player) => [player.id, 0]));
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = contributed.filter((player) => Number(player.totalContribution) >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (amount <= 0) continue;
    // A single contributor cannot form a contestable layer. Return their
    // unmatched excess instead of recording it as a pot.
    if (contributors.length === 1) {
      payouts[contributors[0].id] += amount;
      continue;
    }
    const eligible = contributors.filter((player) => !player.folded && !player.left);
    if (!eligible.length) {
      const share = Math.floor(amount / contributors.length);
      let remainder = amount % contributors.length;
      for (const contributor of contributors) {
        const value = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        payouts[contributor.id] += value;
      }
      continue;
    }
    let winners = [eligible[0]];
    for (const player of eligible.slice(1)) {
      const comparison = compareEvaluations(player.evaluation, winners[0].evaluation);
      if (comparison > 0) winners = [player];
      else if (comparison === 0) winners.push(player);
    }
    const share = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;
    const clockwise = [...winners].sort((left, right) => {
      const leftDistance = (Number(left.seat) - Number(dealerSeat) + 9) % 9 || 9;
      const rightDistance = (Number(right.seat) - Number(dealerSeat) + 9) % 9 || 9;
      return leftDistance - rightDistance;
    });
    for (const winner of clockwise) {
      const value = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      payouts[winner.id] += value;
    }
    pots.push({ amount, eligiblePlayerIds: eligible.map((player) => player.id), winnerIds: clockwise.map((player) => player.id) });
  }
  return { payouts, pots };
}

export function nextSeat(players, fromSeat, predicate = () => true) {
  const seats = players.filter(predicate).map((player) => Number(player.seat)).sort((a, b) => a - b);
  return seats.find((seat) => seat > Number(fromSeat)) ?? seats[0] ?? -1;
}

export function blindPositions(players, dealerSeat) {
  const active = players.filter((player) => !player.left && player.stack > 0).sort((a, b) => a.seat - b.seat);
  if (active.length < 2) throw new Error('至少需要两名有筹码玩家');
  if (active.length === 2) {
    return { smallBlindSeat: dealerSeat, bigBlindSeat: nextSeat(active, dealerSeat), firstPreflopSeat: dealerSeat };
  }
  const smallBlindSeat = nextSeat(active, dealerSeat);
  const bigBlindSeat = nextSeat(active, smallBlindSeat);
  return { smallBlindSeat, bigBlindSeat, firstPreflopSeat: nextSeat(active, bigBlindSeat) };
}

export function allowedActions(room, player) {
  if (!room || !player || player.folded || player.allIn || !player.inHand || player.left || room.currentTurn !== player.seat) return { actions: [], toCall: 0, minRaiseTo: 0, maxRaiseTo: 0 };
  const toCall = Math.max(0, Number(room.currentBet) - Number(player.streetBet));
  const maxRaiseTo = Number(player.streetBet) + Number(player.stack);
  const minRaiseTo = Number(room.currentBet) + Number(room.minRaise);
  const actions = ['fold'];
  if (toCall === 0) actions.push('check');
  else actions.push('call');
  if (player.stack > 0) actions.push('all_in');
  if (room.currentBet === 0 && maxRaiseTo >= room.bigBlind) actions.push('bet');
  if (room.currentBet > 0 && player.canRaise !== false && maxRaiseTo >= minRaiseTo) actions.push('raise');
  return { actions, toCall, minRaiseTo, maxRaiseTo };
}

export function makeDeck() {
  return ['S', 'H', 'C', 'D'].flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({ rank: index + 2, suit })));
}
