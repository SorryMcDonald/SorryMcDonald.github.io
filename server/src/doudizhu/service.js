import { randomInt, randomUUID } from 'node:crypto';

const SUITS = ['spade', 'heart', 'club', 'diamond'];
const BID_TIMEOUT_MS = 15_000;
const DOUBLE_TIMEOUT_MS = 10_000;
const PLAY_TIMEOUT_MS = 30_000;
const BASE_SCORES = new Set([10, 50, 100, 200, 500, 1000]);

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function numeric(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function sortCards(cards) { return cards.sort((left, right) => left.rank - right.rank || left.suit.localeCompare(right.suit)); }
function createDeck() {
  const deck = [];
  for (let rank = 3; rank <= 15; rank += 1) for (const suit of SUITS) deck.push({ id: `${rank}-${suit}`, rank, suit });
  deck.push({ id: '16-joker', rank: 16, suit: 'joker' }, { id: '17-joker', rank: 17, suit: 'joker' });
  return deck;
}
function shuffledDeck() {
  const deck = createDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) { const target = randomInt(index + 1); [deck[index], deck[target]] = [deck[target], deck[index]]; }
  return deck;
}
function deal(players) {
  const deck = shuffledDeck();
  const bottomCount = players.length === 3 ? 3 : 2;
  const bottomCards = deck.splice(deck.length - bottomCount, bottomCount);
  const hands = Object.fromEntries(players.map((player) => [player.id, []]));
  deck.forEach((card, index) => hands[players[index % players.length].id].push(card));
  Object.values(hands).forEach(sortCards);
  return { hands, bottomCards: sortCards(bottomCards) };
}
function groups(cards) {
  const result = new Map();
  for (const card of cards) result.set(card.rank, [...(result.get(card.rank) ?? []), card]);
  return result;
}
function consecutive(ranks) { return ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1); }
function combo(type, rank, length, chain = 1) { return { type, rank, length, chain }; }
function analyzeCombo(input) {
  const cards = sortCards([...(input ?? [])]);
  if (!cards.length) return null;
  const entries = [...groups(cards).entries()].sort(([left], [right]) => left - right);
  const counts = entries.map(([, value]) => value.length);
  const ranks = entries.map(([rank]) => rank);
  if (cards.length === 2 && ranks[0] === 16 && ranks[1] === 17) return combo('rocket', 17, 2);
  if (entries.length === 1) {
    if (cards.length === 1) return combo('single', ranks[0], 1);
    if (cards.length === 2) return combo('pair', ranks[0], 2);
    if (cards.length === 3) return combo('triple', ranks[0], 3);
    if (cards.length === 4) return combo('bomb', ranks[0], 4);
  }
  if (cards.length === 4 && counts.includes(3)) return combo('triple-single', entries.find(([, value]) => value.length === 3)[0], 4);
  if (cards.length === 5 && counts.includes(3) && counts.includes(2)) return combo('triple-pair', entries.find(([, value]) => value.length === 3)[0], 5);
  if (cards.length === 6 && counts.includes(4)) {
    const four = entries.find(([, value]) => value.length === 4);
    return combo('four-two-single', four[0], 6);
  }
  if (cards.length === 8 && counts.includes(4)) {
    const four = entries.find(([, value]) => value.length === 4);
    const wings = entries.filter(([rank]) => rank !== four[0]);
    if (wings.length === 2 && wings.every(([, value]) => value.length === 2)) return combo('four-two-pair', four[0], 8);
  }
  if (cards.length >= 5 && counts.every((count) => count === 1) && ranks.at(-1) < 15 && consecutive(ranks)) return combo('straight', ranks.at(-1), cards.length, cards.length);
  if (cards.length >= 6 && cards.length % 2 === 0 && counts.every((count) => count === 2) && ranks.at(-1) < 15 && consecutive(ranks)) return combo('pair-straight', ranks.at(-1), cards.length, ranks.length);
  const tripleRanks = entries.filter(([rank, value]) => rank < 15 && value.length >= 3).map(([rank]) => rank);
  for (let chain = tripleRanks.length; chain >= 2; chain -= 1) {
    for (let start = 0; start <= tripleRanks.length - chain; start += 1) {
      const run = tripleRanks.slice(start, start + chain);
      if (!consecutive(run)) continue;
      const main = new Set(run);
      const remainder = entries.flatMap(([rank, value]) => main.has(rank) ? value.slice(3) : value);
      if (remainder.some((card) => main.has(card.rank))) continue;
      if (remainder.length === 0 && cards.length === chain * 3) return combo('airplane', run.at(-1), cards.length, chain);
      if (remainder.length === chain && cards.length === chain * 4) return combo('airplane-single', run.at(-1), cards.length, chain);
      const wingGroups = groups(remainder);
      if (remainder.length === chain * 2 && cards.length === chain * 5 && [...wingGroups.values()].every((value) => value.length === 2)) return combo('airplane-pair', run.at(-1), cards.length, chain);
    }
  }
  return null;
}
function canBeat(next, previous) {
  if (!previous) return true;
  if (next.type === 'rocket') return previous.type !== 'rocket';
  if (previous.type === 'rocket') return false;
  if (next.type === 'bomb' && previous.type !== 'bomb') return true;
  return next.type === previous.type && next.length === previous.length && next.chain === previous.chain && next.rank > previous.rank;
}
function nextSeat(room, seat) {
  const seats = room.players.filter((player) => !player.left).map((player) => player.seat).sort((left, right) => left - right);
  return seats[(seats.indexOf(seat) + 1) % seats.length];
}
function playerAt(room, seat) { const player = room.players.find((candidate) => candidate.seat === seat); if (!player) throw httpError(409, '斗地主座位状态异常'); return player; }
function appendEvent(room, eventType, payload = {}) { room.events.push({ id: ++room.eventSeq, eventType, payload, createdAt: new Date().toISOString() }); if (room.events.length > 200) room.events.splice(0, room.events.length - 200); }

function freshGame(room, now) {
  const ordered = [...room.players].sort((left, right) => left.seat - right.seat);
  const dealt = deal(ordered);
  const first = ordered[randomInt(ordered.length)].seat;
  ordered.forEach((player) => { player.role = null; player.double = 1; player.controlledByBot = false; });
  return { roundId: randomUUID(), phase: 'bidding', hands: dealt.hands, bottomCards: dealt.bottomCards, bottomRevealed: false, landlordPlayerId: null,
    currentSeat: first, bid: { mode: 'call', actingSeat: first, pendingSeats: ordered.map((player) => player.seat), candidateSeat: null, redeals: 0 },
    pendingDoubleSeats: [], publicMultiplier: 1, lastPlay: null, trickLeaderId: null, history: [], nonPassPlays: Object.fromEntries(ordered.map((player) => [player.id, 0])), deadlineAt: now + BID_TIMEOUT_MS, result: null };
}

function finalizeLandlord(room, now) {
  const game = room.game;
  const landlord = playerAt(room, game.bid.candidateSeat);
  landlord.role = 'landlord';
  room.players.filter((player) => player.id !== landlord.id).forEach((player) => { player.role = 'farmer'; });
  game.landlordPlayerId = landlord.id;
  game.hands[landlord.id].push(...game.bottomCards);
  sortCards(game.hands[landlord.id]);
  game.bottomRevealed = true;
  game.phase = 'doubling';
  room.status = 'doubling';
  game.currentSeat = landlord.seat;
  game.pendingDoubleSeats = room.players.map((player) => player.seat);
  game.bid = null;
  game.deadlineAt = now + DOUBLE_TIMEOUT_MS;
}

function settle(room, store, winner) {
  const game = room.game;
  const landlord = room.players.find((player) => player.id === game.landlordPlayerId);
  const farmers = room.players.filter((player) => player.role === 'farmer');
  const totalBefore = room.players.reduce((sum, player) => sum + numeric(store.users.get(player.userId)?.beans), 0);
  const before = new Map(room.players.map((player) => [player.id, numeric(store.users.get(player.userId)?.beans)]));
  const farmerPlays = farmers.reduce((sum, player) => sum + numeric(game.nonPassPlays[player.id]), 0);
  const landlordPlays = numeric(game.nonPassPlays[landlord.id]);
  let spring = null;
  if (winner === 'landlord' && farmerPlays === 0) spring = 'spring';
  if (winner === 'farmer' && landlordPlays <= 1) spring = 'anti-spring';
  if (spring) game.publicMultiplier *= 2;
  const due = farmers.map((farmer) => ({ farmer, amount: room.baseScore * game.publicMultiplier * numeric(landlord.double, 1) * numeric(farmer.double, 1) }));
  const payments = [];
  if (winner === 'landlord') {
    for (const item of due) {
      const user = store.users.get(item.farmer.userId); const landlordUser = store.users.get(landlord.userId);
      const paid = Math.min(item.amount, Math.max(0, numeric(user?.beans)));
      user.beans = numeric(user.beans) - paid; landlordUser.beans = numeric(landlordUser.beans) + paid;
      payments.push({ fromUserId: item.farmer.userId, toUserId: landlord.userId, due: item.amount, paid, unpaid: item.amount - paid });
    }
  } else {
    const landlordUser = store.users.get(landlord.userId);
    const totalDue = due.reduce((sum, item) => sum + item.amount, 0);
    const available = Math.min(Math.max(0, numeric(landlordUser?.beans)), totalDue);
    let distributed = 0;
    due.forEach((item, index) => {
      const share = index === due.length - 1 ? available - distributed : Math.floor(available * item.amount / Math.max(1, totalDue));
      store.users.get(item.farmer.userId).beans = numeric(store.users.get(item.farmer.userId).beans) + share;
      distributed += share;
      payments.push({ fromUserId: landlord.userId, toUserId: item.farmer.userId, due: item.amount, paid: share, unpaid: item.amount - share });
    });
    landlordUser.beans = numeric(landlordUser.beans) - distributed;
  }
  const paymentByUser = new Map();
  for (const payment of payments) {
    for (const [userId, amount] of [[payment.fromUserId, payment], [payment.toUserId, payment]]) {
      const current = paymentByUser.get(userId) ?? { due: 0, paid: 0, unpaid: 0 };
      if (userId === payment.fromUserId) { current.due += payment.due; current.paid += payment.paid; current.unpaid += payment.unpaid; }
      else current.paid += payment.paid;
      paymentByUser.set(userId, current);
    }
  }
  const items = room.players.map((player) => {
    const user = store.users.get(player.userId);
    const payment = paymentByUser.get(player.userId) ?? { due: 0, paid: 0, unpaid: 0 };
    return { playerId: player.id, userId: player.userId, nickname: player.nickname, role: player.role, delta: numeric(user?.beans) - numeric(before.get(player.id)), balance: numeric(user?.beans), due: payment.due, paid: payment.paid, unpaid: payment.unpaid };
  });
  const totalAfter = room.players.reduce((sum, player) => sum + numeric(store.users.get(player.userId)?.beans), 0);
  if (totalAfter !== totalBefore) throw new Error(`斗地主结算账户不守恒: before=${totalBefore}, after=${totalAfter}`);
  const dueTotal = payments.reduce((sum, payment) => sum + payment.due, 0);
  const paidTotal = payments.reduce((sum, payment) => sum + payment.paid, 0);
  game.result = { winner, spring, multiplier: game.publicMultiplier, due: dueTotal, paid: paidTotal, unpaid: dueTotal - paidTotal, items };
  game.phase = 'finished'; game.deadlineAt = 0; room.status = 'finished'; room.players.forEach((player) => { player.ready = false; });
  appendEvent(room, 'doudizhu_settled', game.result);
}

function removeCards(hand, cardIds) {
  const wanted = new Set(cardIds);
  if (wanted.size !== cardIds.length || cardIds.some((id) => !hand.some((card) => card.id === id))) throw httpError(400, '所选牌不在你的手牌中');
  return hand.filter((card) => !wanted.has(card.id));
}

export class DoudizhuService {
  constructor({ store, clock } = {}) { this.store = store ?? { users: new Map() }; this.rooms = new Map(); this.clock = clock ?? { now: () => Date.now() }; }
  now() { return numeric(this.clock?.now?.(), Date.now()); }
  user(userId) { const user = this.store.users.get(userId); if (!user) throw httpError(404, '用户不存在'); return user; }
  room(roomId) { const room = this.rooms.get(roomId) ?? [...this.rooms.values()].find((candidate) => candidate.code === String(roomId)); if (!room) throw httpError(404, '斗地主房间不存在'); return room; }
  activeRoomsForUser(userId) { return [...this.rooms.values()].filter((room) => room.status !== 'closed' && room.players.some((player) => player.userId === userId && !player.left)); }
  activeRoomForUser(userId) {
    const rooms = this.activeRoomsForUser(userId);
    if (rooms.length > 1) throw Object.assign(httpError(409, '账号存在多个斗地主房间，请联系管理员处理'), { code: 'DOUDIZHU_MEMBERSHIP_CONFLICT' });
    return rooms[0] ?? null;
  }
  touch(room) { room.version += 1; room.updatedAt = new Date(this.now()).toISOString(); return room; }
  createRoom(userId, input = {}) {
    this.user(userId);
    const existing = this.activeRoomForUser(userId);
    if (existing) return existing;
    const maxPlayers = Math.floor(numeric(input.maxPlayers, 3));
    const baseScore = Math.floor(numeric(input.baseScore, 100));
    if (![2, 3, 4].includes(maxPlayers)) throw httpError(400, '斗地主人数上限必须为 2～4 人');
    if (!BASE_SCORES.has(baseScore)) throw httpError(400, '斗地主底分无效');
    let code;
    for (let attempt = 0; attempt < 100; attempt += 1) { const candidate = String(randomInt(100000, 1000000)); if (![...this.rooms.values()].some((room) => room.code === candidate)) { code = candidate; break; } }
    if (!code) throw httpError(503, '暂时无法生成斗地主房间号');
    const id = randomUUID();
    const room = { id, code, version: 1, gameType: 'doudizhu', maxPlayers, baseScore, status: 'waiting', hostUserId: userId, players: [], spectators: new Set(), game: null, events: [], eventSeq: 0, updatedAt: new Date(this.now()).toISOString() };
    this.rooms.set(id, room);
    try { this.joinRoom(id, userId); appendEvent(room, 'doudizhu_room_created', { code }); return room; }
    catch (error) { this.rooms.delete(id); throw error; }
  }
  joinRoom(roomId, userId) {
    const room = this.room(roomId); const user = this.user(userId);
    if (room.players.some((player) => player.userId === userId && !player.left)) return room;
    if (room.status !== 'waiting' && room.status !== 'finished') throw httpError(409, '斗地主对局已经开始');
    if (room.players.filter((player) => !player.left).length >= room.maxPlayers) throw httpError(409, '斗地主房间已满');
    if ([...this.rooms.values()].some((candidate) => candidate.id !== room.id && candidate.players.some((player) => player.userId === userId && !player.left))) throw httpError(409, '账号已在其他斗地主房间');
    const seat = [...Array(room.maxPlayers).keys()].find((candidate) => !room.players.some((player) => player.seat === candidate && !player.left));
    room.players.push({ id: randomUUID(), userId, nickname: user.nickname, seat, ready: false, role: null, double: 1, left: false, controlledByBot: false });
    this.touch(room); return room;
  }
  leaveRoom(roomId, userId) { const room = this.room(roomId); const player = room.players.find((entry) => entry.userId === userId && !entry.left); if (!player) return room; player.left = true; player.ready = false; if (room.status !== 'waiting' && room.status !== 'finished') player.controlledByBot = true; if (room.hostUserId === userId) room.hostUserId = room.players.find((entry) => !entry.left)?.userId ?? null; this.touch(room); return room; }
  beginGame(roomId, userId) { const room = this.room(roomId); if (room.hostUserId !== userId) throw httpError(403, '只有房主可以开始斗地主'); const players = room.players.filter((player) => !player.left); if (players.length < 2) throw httpError(409, '至少需要 2 名玩家'); if (!players.every((player) => player.ready)) throw httpError(409, '仍有玩家没有准备'); room.status = 'bidding'; room.game = freshGame({ ...room, players }, this.now()); this.touch(room); return room; }
  setReady(roomId, userId, ready) { const room = this.room(roomId); const player = room.players.find((entry) => entry.userId === userId && !entry.left); if (!player) throw httpError(403, '玩家不在房间中'); if (room.status === 'finished') { room.status = 'waiting'; room.game = null; room.players.forEach((entry) => { entry.role = null; entry.double = 1; entry.ready = false; }); } if (room.status !== 'waiting') throw httpError(409, '当前不能准备'); player.ready = Boolean(ready); this.touch(room); return room; }
  bid(roomId, userId, choice) { const room = this.room(roomId); const game = room.game; const player = room.players.find((entry) => entry.userId === userId); if (!game?.bid || room.status !== 'bidding' || game.bid.actingSeat !== player?.seat) throw httpError(409, '当前不能叫地主'); const state = game.bid; state.pendingSeats.shift(); if (state.mode === 'call') { if (!choice) { if (!state.pendingSeats.length) { room.game = freshGame(room, this.now()); this.touch(room); return room; } } else { state.candidateSeat = player.seat; state.mode = 'rob'; state.pendingSeats = room.players.filter((entry) => !entry.left && entry.seat !== player.seat).map((entry) => entry.seat); } } else if (choice) { state.candidateSeat = player.seat; game.publicMultiplier *= 2; } if (!state.pendingSeats.length) finalizeLandlord(room, this.now()); else { state.actingSeat = state.pendingSeats[0]; game.currentSeat = state.actingSeat; game.deadlineAt = this.now() + BID_TIMEOUT_MS; } this.touch(room); return room; }
  double(roomId, userId, value) { const room = this.room(roomId); const game = room.game; const player = room.players.find((entry) => entry.userId === userId); if (!game || room.status !== 'doubling' || !player || !game.pendingDoubleSeats.includes(player.seat)) throw httpError(409, '当前不能加倍'); if (![1, 2, 4].includes(Number(value))) throw httpError(400, '无效的加倍选项'); player.double = Number(value); game.pendingDoubleSeats = game.pendingDoubleSeats.filter((seat) => seat !== player.seat); if (!game.pendingDoubleSeats.length) { room.status = 'playing'; game.phase = 'playing'; game.currentSeat = room.players.find((entry) => entry.id === game.landlordPlayerId).seat; game.deadlineAt = this.now() + PLAY_TIMEOUT_MS; } else { game.currentSeat = game.pendingDoubleSeats[0]; } this.touch(room); return room; }
  play(roomId, userId, cardIds) { const room = this.room(roomId); const game = room.game; const player = room.players.find((entry) => entry.userId === userId); if (!game || room.status !== 'playing' || !player || game.currentSeat !== player.seat) throw httpError(409, '当前不能出牌'); const hand = game.hands[player.id] ?? []; const cards = cardIds.map((id) => hand.find((card) => card.id === id)).filter(Boolean); const nextCombo = analyzeCombo(cards); if (!nextCombo || !canBeat(nextCombo, game.lastPlay?.combo ?? null)) throw httpError(400, '所选牌型不能压过上一手'); game.hands[player.id] = removeCards(hand, cardIds); game.nonPassPlays[player.id] += 1; const record = { id: randomUUID(), playerId: player.id, nickname: player.nickname, cards: sortCards(cards), combo: nextCombo, passed: false, at: this.now() }; game.lastPlay = record; game.trickLeaderId = player.id; game.history.push(record); if (nextCombo.type === 'bomb' || nextCombo.type === 'rocket') game.publicMultiplier *= 2; if (!game.hands[player.id].length) settle(room, this.store, player.role === 'landlord' ? 'landlord' : 'farmer'); else { game.currentSeat = nextSeat(room, player.seat); game.deadlineAt = this.now() + PLAY_TIMEOUT_MS; } this.touch(room); return room; }
  pass(roomId, userId) { const room = this.room(roomId); const game = room.game; const player = room.players.find((entry) => entry.userId === userId); if (!game || room.status !== 'playing' || !player || game.currentSeat !== player.seat || !game.lastPlay || game.trickLeaderId === player.id) throw httpError(409, '当前不能不出'); game.history.push({ id: randomUUID(), playerId: player.id, nickname: player.nickname, cards: [], combo: null, passed: true, at: this.now() }); const next = nextSeat(room, player.seat); game.currentSeat = next; if (playerAt(room, next).id === game.trickLeaderId) { game.lastPlay = null; game.trickLeaderId = null; } game.deadlineAt = this.now() + PLAY_TIMEOUT_MS; this.touch(room); return room; }
  autoProgress(roomId) { const room = this.room(roomId); const game = room.game; if (!game || game.phase === 'finished' || game.deadlineAt > this.now()) return room; const player = room.status === 'doubling' ? room.players.find((entry) => entry.seat === game.pendingDoubleSeats[0]) : playerAt(room, game.currentSeat); player.controlledByBot = true; if (room.status === 'bidding') this.bid(room.id, player.userId, false); else if (room.status === 'doubling') this.double(room.id, player.userId, 1); else if (room.status === 'playing') { const hand = game.hands[player.id] ?? []; if (!game.lastPlay && hand.length) this.play(room.id, player.userId, [sortCards(hand)[0].id]); else this.pass(room.id, player.userId); } return room; }
  snapshot(roomId, userId) { const room = this.room(roomId); const viewer = room.players.find((player) => player.userId === userId && !player.left); if (!viewer) throw httpError(403, '请先加入斗地主房间'); const game = room.game; return { id: room.id, code: room.code, version: room.version, maxPlayers: room.maxPlayers, baseScore: room.baseScore, hostUserId: room.hostUserId, status: room.status, players: room.players.filter((player) => !player.left).map((player) => ({ ...player, beans: numeric(this.store.users.get(player.userId)?.beans), cardCount: game?.hands[player.id]?.length ?? 0 })), game: game ? { ...game, hands: undefined, myHand: game.hands[viewer.id] ?? [] } : null, events: room.events.slice(-30), viewer: { id: viewer.id, userId, kind: 'player' } }; }
}

export { analyzeCombo };
