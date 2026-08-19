import { randomUUID } from 'node:crypto';
import { calculateSidePotPayouts, evaluateHand, netChange, selectDealer, shouldSettle, compareHands, buildCompareEvents } from '../game/rules.js';
import { appendEvent, visibleRoom } from '../game/events.js';

const MAX_SEATS = 8;
const SUITS = ['S', 'H', 'C', 'D'];
const STARTING_ANTE = 10;

function deck() { return SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({ rank: index + 2, suit }))); }
function shuffle(cards) { for (let i = cards.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; } return cards; }
function nextSeat(room, seat) { const seats = [...room.players.values()].filter((p) => !p.left && p.inRound && !p.folded && !p.allIn).map((p) => p.seat).sort((a, b) => a - b); return seats.find((value) => value > seat) ?? seats[0] ?? -1; }
function activePlayers(room) { return [...room.players.values()].filter((p) => p.inRound); }
function userBeans(user) { return Number(user.beans ?? 0); }

export class RoomService {
  constructor({ store } = {}) { this.store = store ?? { users: new Map() }; if (!this.store.banners) this.store.banners = []; this.rooms = new Map(); }

  user(userId) { const user = this.store.users.get(userId); if (!user) throw Object.assign(new Error('用户不存在'), { statusCode: 404 }); return user; }
  room(roomId) { const room = this.rooms.get(roomId) ?? [...this.rooms.values()].find((candidate) => candidate.code === String(roomId)); if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 }); return room; }
  ensureUser(userId) { return this.user(userId); }
  promoteDealer(room) { const candidates = (room.lastResults ?? []).map((result) => { const seated = [...room.players.values()].some((player) => player.userId === result.userId && !player.left); return { ...result, active: seated && !room.spectators.has(result.userId), beans: this.user(result.userId).beans }; }); const candidate = selectDealer(candidates); room.dealerUserId = candidate?.userId ?? null; room.dealerSeat = candidate?.seat ?? null; return candidate; }

  createRoom(userId, input = {}) {
    const user = this.ensureUser(userId);
    if ([...this.rooms.values()].some((candidate) => [...candidate.players.values()].some((player) => player.userId === userId && !player.left))) {
      throw Object.assign(new Error('账号已有座位'), { statusCode: 409 });
    }
    const id = randomUUID();
    const room = { id, code: String(input.code ?? Math.floor(100000 + Math.random() * 900000)), hostUserId: userId, status: 'waiting', dealerUserId: null, dealerSeat: null, currentTurn: -1, ante: Number(input.ante ?? STARTING_ANTE), level: 0, pot: 0, roundNumber: 0, allowSpectators: Boolean(input.allowSpectators ?? false), players: new Map(), spectators: new Set(), events: [], eventSeq: 0, round: null };
    this.rooms.set(id, room); this.joinRoom(id, userId, 0); appendEvent(room, 'room_created', { code: room.code }); return room;
  }

  joinRoom(roomId, userId, seat) {
    const room = this.room(roomId); const user = this.ensureUser(userId);
    if ([...this.rooms.values()].some((candidate) => [...candidate.players.values()].some((player) => player.userId === userId && !player.left && candidate.id !== roomId))) throw Object.assign(new Error('账号已有座位'), { statusCode: 409 });
    if ([...room.players.values()].some((player) => player.userId === userId && !player.left)) return [...room.players.values()].find((player) => player.userId === userId && !player.left);
    if ([...room.players.values()].filter((player) => !player.left).length >= MAX_SEATS) throw Object.assign(new Error('房间已满'), { statusCode: 409 });
    const used = new Set([...room.players.values()].filter((player) => !player.left).map((player) => player.seat));
    const chosenSeat = Number.isInteger(seat) && seat >= 0 && seat < MAX_SEATS && !used.has(seat) ? seat : [...Array(MAX_SEATS).keys()].find((value) => !used.has(value));
    if (chosenSeat === undefined) throw Object.assign(new Error('没有可用座位'), { statusCode: 409 });
    const player = { id: randomUUID(), userId, nickname: user.nickname, seat: chosenSeat, inRound: false, folded: false, allIn: false, seen: false, currentBet: 0, totalContribution: 0, actionSeq: 0, lastAction: null, cards: [], handType: null, left: false };
    room.players.set(player.id, player); appendEvent(room, 'player_joined', { userId, nickname: user.nickname, seat: chosenSeat }); return player;
  }

  leaveRoom(roomId, userId) {
    const room = this.room(roomId); const player = [...room.players.values()].find((item) => item.userId === userId && !item.left);
    const leavingActiveRound = Boolean(player?.inRound && ['betting', 'comparing'].includes(room.status));
    if (player) {
      player.left = true;
      if (leavingActiveRound) player.folded = true;
      else player.inRound = false;
      appendEvent(room, 'player_left', { userId, seat: player.seat });
    }
    room.spectators.delete(userId);
    if (room.hostUserId === userId) room.hostUserId = [...room.players.values()].find((item) => !item.left)?.userId ?? null;
    if (leavingActiveRound) {
      const players = activePlayers(room);
      const alive = players.filter((item) => !item.folded).length;
      const actionable = players.filter((item) => !item.folded && !item.allIn && !item.left).length;
      const maxBet = Math.max(...players.map((item) => item.currentBet));
      const allMatched = players.filter((item) => !item.folded).every((item) => item.currentBet === maxBet || item.allIn);
      const allActed = players.filter((item) => !item.folded && !item.allIn && !item.left).every((item) => item.actionSeq > 0);
      if (shouldSettle({ alive, actionable, allMatched, allActed })) this.settle(room);
      else if (room.currentTurn === player.seat) room.currentTurn = nextSeat(room, player.seat);
    } else if (room.dealerUserId === userId) this.promoteDealer(room);
    return room;
  }

  listRooms() {
    return [...this.rooms.values()]
      .map((room) => {
        const players = [...room.players.values()].filter((player) => !player.left);
        const host = this.store.users.get(room.hostUserId);
        return {
          id: room.id,
          code: room.code,
          status: room.status,
          hostNickname: host?.nickname ?? players[0]?.nickname ?? '等待房主',
          playerCount: players.length,
          maxPlayers: MAX_SEATS,
          allowSpectators: room.allowSpectators,
          roundNumber: room.roundNumber
        };
      })
      .filter((room) => room.playerCount > 0)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  setSpectating(roomId, userId, enabled) {
    const room = this.room(roomId); if (enabled && !room.allowSpectators) throw Object.assign(new Error('房主未开启观战'), { statusCode: 403 });
    const player = [...room.players.values()].find((item) => item.userId === userId && !item.left);
    if (enabled && player && room.status !== 'waiting' && room.status !== 'settled') throw Object.assign(new Error('当前阶段不能切换观战'), { statusCode: 409 });
    if (enabled) { if (player) player.left = true; room.spectators.add(userId); if (room.dealerUserId === userId) this.promoteDealer(room); } else room.spectators.delete(userId);
    appendEvent(room, enabled ? 'spectator_joined' : 'spectator_left', { userId }); return room;
  }

  setAllowSpectators(roomId, userId, enabled) {
    const room = this.room(roomId); if (room.hostUserId !== userId) throw Object.assign(new Error('只有房主可以设置观战'), { statusCode: 403 });
    room.allowSpectators = Boolean(enabled); appendEvent(room, 'spectator_setting', { enabled: room.allowSpectators }); return room;
  }

  startNextRound(roomId, userId) {
    const room = this.room(roomId); if (room.status !== 'waiting' && room.status !== 'settled') throw Object.assign(new Error('当前不能开始下一局'), { statusCode: 409 });
    if (room.dealerUserId && ![...room.players.values()].some((player) => !player.left && player.userId === room.dealerUserId && userBeans(this.user(player.userId)) > 0)) this.promoteDealer(room);
    if (room.dealerUserId && room.dealerUserId !== userId) throw Object.assign(new Error('请由庄家开始下一局'), { statusCode: 403 });
    const players = [...room.players.values()].filter((player) => !player.left && !room.spectators.has(player.userId) && userBeans(this.user(player.userId)) > 0);
    if (players.length < 2) throw Object.assign(new Error('至少需要两名有豆玩家'), { statusCode: 409 });
    const dealer = players.find((player) => player.userId === room.dealerUserId) ?? players.sort((a, b) => a.seat - b.seat)[0];
    room.roundNumber += 1; room.status = 'betting'; room.dealerUserId = dealer.userId; room.dealerSeat = dealer.seat; room.currentTurn = dealer.seat; room.pot = 0; room.level = room.ante; room.round = { id: randomUUID(), idempotency: false };
    const cards = shuffle(deck());
    players.forEach((player, index) => { player.inRound = true; player.folded = false; player.allIn = false; player.seen = false; player.currentBet = 0; player.totalContribution = 0; player.actionSeq = 0; player.lastAction = null; player.cards = cards.slice(index * 3, index * 3 + 3); player.handType = evaluateHand(player.cards).name; const user = this.user(player.userId); const ante = Math.min(room.ante, userBeans(user)); user.beans = userBeans(user) - ante; player.currentBet = ante; player.totalContribution = ante; room.pot += ante; });
    appendEvent(room, 'round_started', { roundNumber: room.roundNumber, dealerUserId: room.dealerUserId, dealerSeat: room.dealerSeat, currentTurn: room.currentTurn }); return room;
  }

  action(roomId, userId, input = {}) {
    const room = this.room(roomId); if (room.status !== 'betting' && room.status !== 'comparing') throw Object.assign(new Error('当前不能行动'), { statusCode: 409 });
    const player = [...room.players.values()].find((item) => item.userId === userId && !item.left && item.inRound); if (!player) throw Object.assign(new Error('玩家不在牌局中'), { statusCode: 403 });
    const seq = Number(input.actionSeq); if (!Number.isInteger(seq) || seq !== player.actionSeq + 1) throw Object.assign(new Error('动作序号错误'), { statusCode: 409 });
    if (player.seat !== room.currentTurn) throw Object.assign(new Error('还没有轮到你'), { statusCode: 409 });
    const type = input.type ?? input.action;
    if (type === 'compare') return this.compare(room, player, input.targetSeat ?? input.targetUserId, seq);
    const user = this.user(userId); const maxBet = Math.max(...activePlayers(room).map((item) => item.currentBet));
    if (type === 'fold') player.folded = true;
    else if (type === 'see' || type === 'check') player.seen = true;
    else if (type === 'call') { const amount = Math.min(Math.max(0, maxBet - player.currentBet), userBeans(user)); user.beans -= amount; player.currentBet += amount; player.totalContribution += amount; room.pot += amount; }
    else if (type === 'raise' || type === 'bet') { const amount = Math.max(maxBet - player.currentBet, Number(input.amount ?? room.level)); if (amount <= 0 || userBeans(user) < amount) throw Object.assign(new Error('下注豆子不足'), { statusCode: 400 }); user.beans -= amount; player.currentBet += amount; player.totalContribution += amount; room.pot += amount; room.level = player.currentBet; }
    else if (type === 'all_in') { const amount = userBeans(user); user.beans = 0; player.currentBet += amount; player.totalContribution += amount; room.pot += amount; player.allIn = true; }
    else throw Object.assign(new Error('未知动作'), { statusCode: 400 });
    player.lastAction = type; player.actionSeq = seq; appendEvent(room, 'player_action', { userId, seat: player.seat, action: type, amount: player.currentBet });
    const alive = activePlayers(room).filter((item) => !item.folded).length; const actionable = activePlayers(room).filter((item) => !item.folded && !item.allIn).length; const allMatched = activePlayers(room).filter((item) => !item.folded).every((item) => item.currentBet === Math.max(...activePlayers(room).map((candidate) => candidate.currentBet)) || item.allIn); const allActed = activePlayers(room).filter((item) => !item.folded && !item.allIn).every((item) => item.actionSeq > 0);
    if (shouldSettle({ alive, actionable, allMatched, allActed })) this.settle(room);
    else room.currentTurn = nextSeat(room, player.seat);
    return room;
  }

  compare(room, attacker, target, seq) {
    const targetPlayer = [...room.players.values()].find((player) => !player.left && (player.userId === target || player.seat === Number(target)) && player.inRound && !player.folded);
    if (!targetPlayer || targetPlayer.id === attacker.id) throw Object.assign(new Error('比牌目标无效'), { statusCode: 400 });
    const fee = 20; const user = this.user(attacker.userId); if (userBeans(user) < fee) throw Object.assign(new Error('比牌费用不足'), { statusCode: 400 }); user.beans -= fee; attacker.totalContribution += fee; room.pot += fee;
    room.status = 'comparing'; attacker.lastAction = 'compare'; attacker.actionSeq = seq; const attackerWon = compareHands(attacker.cards, targetPlayer.cards) >= 0; const events = buildCompareEvents({ attacker: attacker.nickname, target: targetPlayer.nickname, fee, attackerWon }); events.forEach((event) => appendEvent(room, event.type, event.type === 'compare_started' ? { attacker: attacker.nickname, target: targetPlayer.nickname, fee } : { winner: event.winner, loser: event.loser }));
    if (!attackerWon) attacker.folded = true; else targetPlayer.folded = true; room.status = 'betting'; room.currentTurn = nextSeat(room, attacker.seat); if (activePlayers(room).filter((player) => !player.folded).length <= 1) this.settle(room); return room;
  }

  settle(room) {
    if (room.status === 'settled' || !room.round || room.round.idempotency) return room;
    room.round.idempotency = true; const players = activePlayers(room); const payouts = calculateSidePotPayouts(players); const results = [];
    for (const player of players) { const payout = Number(payouts[player.id] ?? 0); const user = this.user(player.userId); user.beans = userBeans(user) + payout; const net = netChange({ payout, totalContribution: player.totalContribution }); results.push({ ...player, payout, net, beans: user.beans, settledOrder: player.actionSeq }); player.handType = evaluateHand(player.cards).name; }
    const winner = selectDealer(results); room.dealerUserId = winner?.userId ?? null; room.dealerSeat = winner?.seat ?? null; room.status = 'settled'; room.currentTurn = -1;
    room.lastResults = results;
    results.forEach((result) => { const user = this.user(result.userId); if (result.net > 0) user.wins = Number(user.wins ?? 0) + 1; else if (result.net < 0) user.losses = Number(user.losses ?? 0) + 1; if (user.beans === 0) { user.refill_generation = Number(user.refill_generation ?? 0) + 1; user.last_zero_generation = null; user.zero_banner_generation = user.refill_generation; this.store.banners.push({ id: this.store.banners.length + 1, queueName: 'economy', message: `${user.nickname}：黄总是大帅比！`, createdAt: new Date().toISOString() }); } });
    appendEvent(room, 'round_settled', { winnerUserId: winner?.userId ?? null, dealerUserId: room.dealerUserId, players: results.map((result) => ({ userId: result.userId, seat: result.seat, nickname: result.nickname, payout: result.payout, net: result.net, folded: result.folded, cards: result.cards, handType: result.handType })) }); return room;
  }

  snapshot(roomId, userId) { const room = this.room(roomId); return visibleRoom(room, { userId, spectator: room.spectators.has(userId) }); }
  eventsSince(roomId, userId, after = 0) { const room = this.room(roomId); const spectator = room.spectators.has(userId); return room.events.filter((event) => event.id > Number(after)).map((event) => visibleRoomEvent(event, room, userId, spectator)); }
}

function visibleRoomEvent(event, room, userId, spectator) { return { ...event, payload: event.eventType === 'round_settled' ? event.payload : event.payload, room: event.eventType === 'round_settled' ? undefined : undefined, visibleTo: userId, spectator }; }
