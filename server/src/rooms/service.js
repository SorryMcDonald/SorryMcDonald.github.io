import { randomInt, randomUUID } from 'node:crypto';
import {
  actionCost,
  calculateSidePotPayouts,
  compareHands,
  evaluateHand,
  netChange,
  selectDealer,
  shouldSettle,
  validateRaise
} from '../game/rules.js';
import { appendEvent, publicEvent, visibleRoom } from '../game/events.js';
import { appendRankingChanges, resolveUserTitles, snapshotRanking } from '../leaderboard/ranking.js';

export const MAX_SEATS = 6;
export const TURN_TIMEOUT_MS = 60_000;
const SUITS = ['S', 'H', 'C', 'D'];
const STARTING_ANTE = 10;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function roomAnte(value) {
  const ante = Number(value ?? STARTING_ANTE);
  if (!Number.isSafeInteger(ante) || ante <= 0) throw httpError(400, '底注必须是正安全整数');
  return ante;
}

function deck() {
  return SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({ rank: index + 2, suit })));
}

function shuffle(cards, randomInteger) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const target = randomInteger(0, index + 1);
    [cards[index], cards[target]] = [cards[target], cards[index]];
  }
  return cards;
}

function userBeans(user) {
  return Number(user.beans ?? 0);
}

function seatedPlayers(room) {
  return [...room.players.values()].filter((player) => !player.left);
}

function roundPlayers(room) {
  return [...room.players.values()].filter((player) => player.inRound);
}

function alivePlayers(room) {
  return roundPlayers(room).filter((player) => !player.folded);
}

function actionablePlayers(room) {
  return alivePlayers(room).filter((player) => !player.allIn && !player.left);
}

function nextSeat(room, seat) {
  const seats = actionablePlayers(room).map((player) => player.seat).sort((left, right) => left - right);
  return seats.find((value) => value > seat) ?? seats[0] ?? -1;
}

function nowMs(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function touch(room) {
  room.version = Number(room.version ?? 0) + 1;
}

function setTurn(room, seat, now) {
  room.currentTurn = seat;
  if (seat < 0 || room.status !== 'betting') {
    room.turnStartedAt = null;
    room.turnDeadlineAt = null;
    return;
  }
  const startedAt = nowMs(now);
  room.turnStartedAt = new Date(startedAt).toISOString();
  room.turnDeadlineAt = new Date(startedAt + TURN_TIMEOUT_MS).toISOString();
}

function debit(room, player, user, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw httpError(400, '下注金额无效');
  const balance = userBeans(user);
  if (amount > balance) throw httpError(400, '下注豆子不足');
  user.beans = balance - amount;
  if (balance > 0 && user.beans === 0) user.refill_generation = Number(user.refill_generation ?? 0) + 1;
  player.currentBet += amount;
  player.totalContribution += amount;
  room.pot += amount;
  return amount;
}

export class RoomService {
  constructor({ store, randomInteger = randomInt } = {}) {
    this.store = store ?? { users: new Map() };
    if (!this.store.banners) this.store.banners = [];
    this.rooms = new Map();
    this.randomInteger = randomInteger;
  }

  user(userId) {
    const user = this.store.users.get(userId);
    if (!user) throw httpError(404, '用户不存在');
    return user;
  }

  room(roomId) {
    const room = this.rooms.get(roomId) ?? [...this.rooms.values()].find((candidate) => candidate.code === String(roomId));
    if (!room) throw httpError(404, '房间不存在');
    return room;
  }

  ensureUser(userId) {
    return this.user(userId);
  }

  promoteDealer(room) {
    const candidates = (room.lastResults ?? []).map((result) => {
      const seated = seatedPlayers(room).some((player) => player.userId === result.userId);
      return {
        ...result,
        active: seated && !room.spectators.has(result.userId),
        beans: this.user(result.userId).beans
      };
    });
    const candidate = selectDealer(candidates);
    room.dealerUserId = candidate?.userId ?? null;
    room.dealerSeat = candidate?.seat ?? null;
    return candidate;
  }

  createRoom(userId, input = {}) {
    this.ensureUser(userId);
    if ([...this.rooms.values()].some((room) => seatedPlayers(room).some((player) => player.userId === userId))) {
      throw httpError(409, '账号已有座位');
    }
    const ante = roomAnte(input.ante);
    let code;
    if (input.code !== undefined && input.code !== null) {
      code = String(input.code);
      if (!/^\d{6}$/.test(code)) throw httpError(400, '房间码必须是 6 位数字');
      if ([...this.rooms.values()].some((room) => room.code === code)) throw httpError(409, '房间码已存在');
    } else {
      for (let attempts = 0; attempts < 1000; attempts += 1) {
        const candidate = String(this.randomInteger(100000, 1000000));
        if (![...this.rooms.values()].some((room) => room.code === candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) throw httpError(503, '暂时无法生成房间码');
    }
    const id = randomUUID();
    const room = {
      id,
      code,
      version: 1,
      hostUserId: userId,
      status: 'waiting',
      dealerUserId: null,
      dealerSeat: null,
      currentTurn: -1,
      ante,
      level: 0,
      pot: 0,
      roundNumber: 0,
      bettingRound: 0,
      roundActedSeats: [],
      turnStartedAt: null,
      turnDeadlineAt: null,
      allowSpectators: Boolean(input.allowSpectators ?? false),
      players: new Map(),
      spectators: new Set(),
      events: [],
      eventSeq: 0,
      messages: [],
      chatLastAt: new Map(),
      round: null,
      lastWinnerUserId: null
    };
    this.rooms.set(id, room);
    appendEvent(room, 'room_created', { code: room.code });
    this.joinRoom(id, userId, 0);
    return room;
  }

  joinRoom(roomId, userId, seat) {
    const room = this.room(roomId);
    const user = this.ensureUser(userId);
    const alreadySeated = seatedPlayers(room).find((player) => player.userId === userId);
    if (alreadySeated) {
      if (Number.isInteger(seat) && seat !== alreadySeated.seat) throw httpError(409, '玩家不可切换座位');
      return alreadySeated;
    }
    if ([...this.rooms.values()].some((candidate) => candidate.id !== room.id && seatedPlayers(candidate).some((player) => player.userId === userId))) {
      throw httpError(409, '账号已有座位');
    }
    if (seatedPlayers(room).length >= MAX_SEATS) throw httpError(409, '房间已满');
    const used = new Set(seatedPlayers(room).map((player) => player.seat));
    const preferred = Number.isInteger(seat) && seat >= 0 && seat < MAX_SEATS && !used.has(seat) ? seat : undefined;
    const chosenSeat = preferred ?? [...Array(MAX_SEATS).keys()].find((value) => !used.has(value));
    if (chosenSeat === undefined) throw httpError(409, '没有可用座位');
    const player = {
      id: randomUUID(),
      userId,
      nickname: user.nickname,
      seat: chosenSeat,
      inRound: false,
      waiting: true,
      ready: false,
      participated: false,
      roundDecision: null,
      folded: false,
      allIn: false,
      seen: false,
      revealed: false,
      mayReveal: false,
      currentBet: 0,
      totalContribution: 0,
      actionSeq: 0,
      lastAction: null,
      cards: [],
      handType: null,
      startingBeans: userBeans(user),
      left: false
    };
    room.players.set(player.id, player);
    room.spectators.delete(userId);
    touch(room);
    appendEvent(room, 'player_joined', { userId, nickname: user.nickname, seat: chosenSeat });
    return player;
  }

  setReady(roomId, userId, ready = true, { decision } = {}) {
    const room = this.room(roomId);
    const player = seatedPlayers(room).find((item) => item.userId === userId);
    if (!player || room.spectators.has(userId)) throw httpError(403, '观战者不能准备');
    if (player.inRound && room.status === 'betting') throw httpError(409, '当前牌局尚未结束');
    if (room.status !== 'waiting' && room.status !== 'settled' && player.participated) throw httpError(409, '请等待本局结算');
    if (decision !== undefined && decision !== 'spectate') throw httpError(400, '无效的牌局选择');
    player.ready = decision === 'spectate' ? false : Boolean(ready);
    if (decision === 'spectate') player.roundDecision = 'spectate';
    else if (player.participated && room.status === 'settled') player.roundDecision = player.ready ? 'next' : 'pending';
    else if (player.ready) player.roundDecision = null;
    player.waiting = !player.inRound;
    touch(room);
    appendEvent(room, 'player_ready', { userId, ready:player.ready, decision:player.roundDecision, roundNumber:room.roundNumber });
    return room;
  }

  leaveRoom(roomId, userId, { now } = {}) {
    const room = this.room(roomId);
    const player = seatedPlayers(room).find((item) => item.userId === userId);
    const active = Boolean(player?.inRound && room.status === 'betting');
    if (player) {
      player.left = true;
      if (active) player.folded = true;
      else player.inRound = false;
      appendEvent(room, 'player_left', { userId, seat: player.seat });
    }
    room.spectators.delete(userId);
    if (room.hostUserId === userId) room.hostUserId = seatedPlayers(room)[0]?.userId ?? null;
    if (active) {
      if (this.shouldSettleRoom(room)) this.settle(room);
      else if (room.currentTurn === player.seat) setTurn(room, nextSeat(room, player.seat), now);
    } else if (room.dealerUserId === userId) {
      this.promoteDealer(room);
    }
    touch(room);
    if (seatedPlayers(room).length === 0 && room.spectators.size === 0) this.reclaimRoom(room.id);
    return room;
  }

  reclaimRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.messages.length = 0;
    room.chatLastAt.clear();
    this.rooms.delete(roomId);
    return true;
  }

  listRooms() {
    return [...this.rooms.values()]
      .map((room) => {
        const players = seatedPlayers(room);
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
    const room = this.room(roomId);
    const player = seatedPlayers(room).find((item) => item.userId === userId);
    if (enabled && !room.allowSpectators && !player) throw httpError(403, '房主未开启观战');
    if (enabled && player && player.inRound && !['waiting', 'settled'].includes(room.status)) throw httpError(409, '当前牌局中不能切换观战');
    if (enabled) {
      if (player) player.left = true;
      room.spectators.add(userId);
      if (room.dealerUserId === userId) this.promoteDealer(room);
    } else {
      room.spectators.delete(userId);
    }
    touch(room);
    appendEvent(room, enabled ? 'spectator_joined' : 'spectator_left', { userId });
    if (seatedPlayers(room).length === 0 && room.spectators.size === 0) this.reclaimRoom(room.id);
    return room;
  }

  setAllowSpectators(roomId, userId, enabled) {
    const room = this.room(roomId);
    if (room.hostUserId !== userId) throw httpError(403, '只有房主可以设置观战');
    room.allowSpectators = Boolean(enabled);
    touch(room);
    appendEvent(room, 'spectator_setting', { enabled: room.allowSpectators });
    return room;
  }

  startNextRound(roomId, userId, { now } = {}) {
    const room = this.room(roomId);
    if (!['waiting', 'settled'].includes(room.status)) throw httpError(409, '当前不能开始下一局');
    if (room.dealerUserId && !seatedPlayers(room).some((player) => player.userId === room.dealerUserId && userBeans(this.user(player.userId)) > 0)) {
      this.promoteDealer(room);
    }
    const previousWinner = seatedPlayers(room).find((player) => player.userId === room.lastWinnerUserId && !room.spectators.has(player.userId));
    const winnerControlsNextRound = previousWinner && previousWinner.roundDecision !== 'spectate';
    const canStart = room.roundNumber === 0
      ? room.hostUserId === userId
      : winnerControlsNextRound ? previousWinner.userId === userId : room.hostUserId === userId;
    if (!canStart) throw httpError(403, winnerControlsNextRound ? '只有上一局赢家可以开始下一局' : '只有房主可以开始下一局');
    if (winnerControlsNextRound && (!previousWinner.ready || previousWinner.roundDecision !== 'next')) {
      throw httpError(409, '上一局赢家请先选择下一局或观战');
    }
    const players = seatedPlayers(room).filter((player) => !room.spectators.has(player.userId) && player.ready && userBeans(this.user(player.userId)) > 0);
    if (players.length < 2) throw httpError(409, '准备至少两名有豆玩家');
    if (players.length > MAX_SEATS) throw httpError(409, '房间人数超过上限');
    const ordered = players.sort((left, right) => left.seat - right.seat);
    const dealer = ordered.find((player) => player.userId === room.dealerUserId) ?? ordered[0];
    room.roundNumber += 1;
    room.status = 'betting';
    room.dealerUserId = dealer.userId;
    room.dealerSeat = dealer.seat;
    room.pot = 0;
    room.level = room.ante;
    room.bettingRound = 0;
    room.roundActedSeats = [];
    room.round = { id: randomUUID(), idempotency: false };
    const cards = shuffle(deck(), this.randomInteger);
    for (const player of seatedPlayers(room)) {
      const participating = players.includes(player);
      player.participated = participating;
      if (!participating) { player.inRound = false; player.waiting = true; }
    }
    ordered.forEach((player, index) => {
      const user = this.user(player.userId);
      player.inRound = true;
      player.waiting = false;
      player.roundDecision = null;
      player.folded = false;
      player.allIn = false;
      player.seen = false;
      player.revealed = false;
      player.mayReveal = false;
      player.currentBet = 0;
      player.totalContribution = 0;
      player.actionSeq = 0;
      player.lastAction = null;
      player.cards = cards.slice(index * 3, index * 3 + 3);
      player.handType = evaluateHand(player.cards).name;
      player.startingBeans = userBeans(user);
      const ante = Math.min(room.ante, userBeans(user));
      debit(room, player, user, ante);
      if (userBeans(user) === 0) player.allIn = true;
    });
    setTurn(room, dealer.allIn ? nextSeat(room, dealer.seat) : dealer.seat, now);
    touch(room);
    appendEvent(room, 'round_started', {
      roundNumber: room.roundNumber,
      dealerUserId: room.dealerUserId,
      dealerSeat: room.dealerSeat,
      currentTurn: room.currentTurn,
      turnDeadlineAt: room.turnDeadlineAt
    });
    if (this.shouldSettleRoom(room)) this.settle(room);
    return room;
  }

  findRoundPlayer(room, userId) {
    const player = roundPlayers(room).find((item) => item.userId === userId && !item.left);
    if (!player) throw httpError(403, '玩家不在牌局中');
    return player;
  }

  action(roomId, userId, input = {}) {
    const room = this.room(roomId);
    if (room.status !== 'betting') throw httpError(409, '当前不能行动');
    const player = this.findRoundPlayer(room, userId);
    const type = input.type ?? input.action;
    if (type === 'see') return this.see(room, player);
    if (type === 'reveal') return this.reveal(room, player);
    if (player.folded || player.allIn) throw httpError(409, '当前玩家不能继续行动');
    const seq = Number(input.actionSeq);
    if (!Number.isInteger(seq) || seq !== player.actionSeq + 1) throw httpError(409, '动作序号错误');
    if (player.seat !== room.currentTurn) throw httpError(409, '还没有轮到你');
    if (type === 'compare') return this.compare(room, player, input.targetSeat ?? input.targetUserId, seq, input.now);

    const user = this.user(userId);
    let amount = 0;
    if (type === 'fold') {
      player.folded = true;
    } else if (type === 'call') {
      amount = debit(room, player, user, actionCost({ level: room.level, seen: player.seen, action: 'call' }));
    } else if (type === 'raise') {
      const raise = validateRaise({ amount: input.amount, level: room.level, balance: userBeans(user), seen: player.seen });
      amount = debit(room, player, user, raise.charge);
      room.level = raise.base;
      room.roundActedSeats = [];
    } else if (type === 'all_in') {
      amount = debit(room, player, user, userBeans(user));
      player.allIn = true;
    } else {
      throw httpError(400, '未知动作');
    }
    player.lastAction = type;
    player.actionSeq = seq;
    appendEvent(room, 'player_action', { userId, seat: player.seat, action: type, amount, level: room.level });
    this.advance(room, player, input.now);
    touch(room);
    return room;
  }

  see(room, player) {
    if (player.folded) throw httpError(409, '弃牌后不能看牌');
    if (player.seen) return room;
    player.seen = true;
    touch(room);
    appendEvent(room, 'hand_seen', { userId: player.userId, seat: player.seat }, `user:${player.userId}`);
    return room;
  }

  reveal(room, player) {
    if (player.revealed) return room;
    if (!player.mayReveal) throw httpError(409, '当前没有亮牌权限');
    player.revealed = true;
    player.mayReveal = false;
    touch(room);
    appendEvent(room, 'hand_revealed', {
      userId: player.userId,
      seat: player.seat,
      nickname: player.nickname,
      cards: player.cards,
      handType: player.handType
    });
    return room;
  }

  compare(room, attacker, target, seq, now) {
    const targetPlayer = alivePlayers(room).find((player) => player.userId === target || player.seat === Number(target));
    if (!targetPlayer || targetPlayer.id === attacker.id) throw httpError(400, '比牌目标无效');
    const user = this.user(attacker.userId);
    const fee = actionCost({ level: room.level, seen: attacker.seen, action: 'compare' });
    debit(room, attacker, user, fee);
    attacker.lastAction = 'compare';
    attacker.actionSeq = seq;
    const attackerWon = compareHands(attacker.cards, targetPlayer.cards) > 0;
    const winner = attackerWon ? attacker : targetPlayer;
    const loser = attackerWon ? targetPlayer : attacker;
    loser.folded = true;
    attacker.mayReveal = true;
    targetPlayer.mayReveal = true;
    appendEvent(room, 'compare_started', {
      attackerUserId: attacker.userId,
      attackerSeat: attacker.seat,
      attacker: attacker.nickname,
      targetUserId: targetPlayer.userId,
      targetSeat: targetPlayer.seat,
      target: targetPlayer.nickname,
      fee
    });
    appendEvent(room, 'compare_resolved', {
      attackerUserId: attacker.userId,
      attackerSeat: attacker.seat,
      targetUserId: targetPlayer.userId,
      targetSeat: targetPlayer.seat,
      winnerUserId: winner.userId,
      winnerSeat: winner.seat,
      winner: winner.nickname,
      loserUserId: loser.userId,
      loserSeat: loser.seat,
      loser: loser.nickname
    });
    this.advance(room, attacker, now);
    touch(room);
    return room;
  }

  shouldSettleRoom(room) {
    return shouldSettle({ alive: alivePlayers(room).length, actionable: actionablePlayers(room).length });
  }

  advance(room, player, now) {
    const acted = new Set(room.roundActedSeats);
    acted.add(player.seat);
    room.roundActedSeats = [...acted].sort((left, right) => left - right);
    if (this.shouldSettleRoom(room)) {
      this.settle(room);
      return;
    }
    const required = actionablePlayers(room).map((candidate) => candidate.seat);
    if (required.every((seat) => acted.has(seat))) {
      room.bettingRound += 1;
      room.roundActedSeats = [];
      if (room.bettingRound >= 20) {
        this.settle(room);
        return;
      }
    }
    setTurn(room, nextSeat(room, player.seat), now);
  }

  timeoutFold(roomId, expected = {}) {
    const room = this.room(roomId);
    if (room.status !== 'betting' || room.currentTurn !== expected.seat || room.round?.id !== expected.roundId) return room;
    const player = actionablePlayers(room).find((candidate) => candidate.seat === room.currentTurn);
    if (!player || player.actionSeq !== expected.actionSeq) return room;
    player.folded = true;
    player.lastAction = 'timeout_fold';
    player.actionSeq += 1;
    appendEvent(room, 'player_action', { userId: player.userId, seat: player.seat, action: 'timeout_fold', amount: 0, level: room.level });
    this.advance(room, player, expected.now);
    touch(room);
    return room;
  }

  settle(room) {
    if (room.status === 'settled' || !room.round || room.round.idempotency) return room;
    room.round.idempotency = true;
    const beforeRanking = snapshotRanking(this.store.users.values());
    const players = roundPlayers(room);
    const payouts = calculateSidePotPayouts(players);
    const results = [];
    for (const player of players) {
      const payout = Number(payouts[player.id] ?? 0);
      const user = this.user(player.userId);
      user.beans = userBeans(user) + payout;
      const net = netChange({ payout, totalContribution: player.totalContribution });
      player.revealed = true;
      player.mayReveal = false;
      player.handType = evaluateHand(player.cards).name;
      results.push({ ...player, payout, net, beans: user.beans, settledOrder: player.actionSeq });
    }
    const winner = selectDealer(results.map((result) => ({
      ...result,
      active: !result.left && !room.spectators.has(result.userId)
    })));
    room.dealerUserId = winner?.userId ?? null;
    room.dealerSeat = winner?.seat ?? null;
    room.lastWinnerUserId = winner?.userId ?? null;
    room.status = 'settled';
    setTurn(room, -1);
    room.lastResults = results;
    for (const player of seatedPlayers(room)) {
      player.inRound = false;
      player.waiting = true;
      if (player.participated) {
        player.ready = false;
        player.roundDecision = 'pending';
      } else if (player.roundDecision === 'spectate') {
        player.roundDecision = null;
      }
    }
    for (const result of results) {
      const user = this.user(result.userId);
      if (result.net > 0) user.wins = Number(user.wins ?? 0) + 1;
      else if (result.net < 0) user.losses = Number(user.losses ?? 0) + 1;
    }
    appendRankingChanges(this.store, beforeRanking, snapshotRanking(this.store.users.values()));
    appendEvent(room, 'round_settled', {
      winnerUserId: winner?.userId ?? null,
      dealerUserId: room.dealerUserId,
      players: results.map((result) => ({
        userId: result.userId,
        seat: result.seat,
        nickname: result.nickname,
        payout: result.payout,
        net: result.net,
        folded: result.folded,
        cards: result.cards,
        handType: result.handType
      }))
    });
    touch(room);
    return room;
  }

  addMessage(roomId, userId, text, { now } = {}) {
    const room = this.room(roomId);
    const player = seatedPlayers(room).find((candidate) => candidate.userId === userId);
    const viewOnly = player?.roundDecision === 'spectate';
    if (!player || room.spectators.has(userId) || viewOnly) throw httpError(403, '观战视角只能读取聊天');
    const body = String(text ?? '').trim();
    if (!body || [...body].length > 120) throw httpError(400, '消息长度需为 1-120 个字符');
    const createdAtMs = nowMs(now);
    const previous = room.chatLastAt.get(userId) ?? 0;
    if (createdAtMs - previous < 1000) throw httpError(429, '消息发送过快');
    room.chatLastAt.set(userId, createdAtMs);
    const message = {
      id: randomUUID(),
      userId,
      nickname: player.nickname,
      text: body,
      createdAt: new Date(createdAtMs).toISOString()
    };
    room.messages.push(message);
    if (room.messages.length > 20) room.messages.splice(0, room.messages.length - 20);
    appendEvent(room, 'chat_message', { message });
    return message;
  }

  snapshot(roomId, userId) {
    const room = this.room(roomId);
    return visibleRoom(room, {
      userId,
      spectator: room.spectators.has(userId),
      titles: resolveUserTitles(this.store.users.values())
    });
  }

  eventsSince(roomId, userId, after = 0) {
    const room = this.room(roomId);
    const own = seatedPlayers(room).find((player) => player.userId === userId);
    const spectator = room.spectators.has(userId) || Boolean(own && !own.inRound && own.roundDecision === 'spectate');
    return room.events
      .filter((event) => event.id > Number(after))
      .filter((event) => event.audience === 'room' || event.audience === `user:${userId}`)
      .map((event) => publicEvent(event, {
        spectator,
        settled: event.eventType === 'round_settled',
        revealed: event.eventType === 'hand_revealed'
      }));
  }
}
