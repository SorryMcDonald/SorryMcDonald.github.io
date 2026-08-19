import { randomInt, randomUUID } from 'node:crypto';
import { allowedActions, blindPositions, calculateTexasPots, evaluateTexasHand, makeDeck, nextSeat } from './rules.js';

const ACTIVE_STREETS = new Set(['preflop', 'flop', 'turn', 'river']);
const DEFAULTS = { smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, defaultBuyIn: 1000, maxPlayers: 9 };
export const TEXAS_TURN_TIMEOUT_MS = 60_000;

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function numeric(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function userBeans(user) { return numeric(user?.beans); }
function shuffledDeck() {
  const cards = makeDeck();
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [cards[index], cards[target]] = [cards[target], cards[index]];
  }
  return cards;
}

function appendEvent(room, eventType, payload = {}) {
  const event = { id: ++room.eventSeq, roomId: room.id, handId: room.hand?.id ?? null, eventType, payload, createdAt: new Date().toISOString() };
  room.events.push(event);
  if (room.events.length > 500) room.events.splice(0, room.events.length - 500);
  return event;
}

function activePlayers(room) { return [...room.players.values()].filter((player) => !player.left && !player.spectating); }
function handPlayers(room) { return [...room.players.values()].filter((player) => player.inHand); }
function contenders(room) { return handPlayers(room).filter((player) => !player.folded); }
function actionable(room) { return contenders(room).filter((player) => !player.allIn && !player.pendingLeave); }
function nextActionSeat(room, fromSeat) { return nextSeat(actionable(room), fromSeat, () => true); }

function takeChips(room, player, amount) {
  const paid = Math.min(Math.max(0, numeric(amount)), player.stack);
  player.stack -= paid;
  player.streetBet += paid;
  player.totalContribution += paid;
  room.pot += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

function revealStreet(room, street) {
  room.deck.pop();
  const count = street === 'flop' ? 3 : 1;
  room.board.push(...room.deck.splice(-count).reverse());
  room.status = street;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  for (const player of handPlayers(room)) {
    player.streetBet = 0;
    player.acted = false;
    player.canRaise = true;
  }
  room.currentTurn = nextActionSeat(room, room.dealerSeat);
  appendEvent(room, `${street}_dealt`, { board: room.board });
}

function cashOut(room, player, user, reason = 'leave') {
  const amount = Math.max(0, numeric(player.stack));
  if (amount > 0) {
    user.beans = userBeans(user) + amount;
    room.pendingLedger.push({ idempotencyKey:`texas:${room.id}:cashout:${player.id}:${room.version}:${reason}`, userId:user.id, roomId:room.id, handId:room.hand?.id ?? null, entryType:'cash_out', amount, balanceAfter:user.beans, metadata:{ reason } });
  }
  player.stack = 0;
  player.left = true;
  player.pendingLeave = false;
  player.inHand = false;
  return amount;
}

export class TexasService {
  constructor({ store, clock, turnTimeoutMs = TEXAS_TURN_TIMEOUT_MS } = {}) {
    this.store = store ?? { users:new Map(), banners:[] };
    if (!this.store.banners) this.store.banners = [];
    this.rooms = new Map();
    this.clock = clock ?? { now: () => Date.now() };
    this.turnTimeoutMs = turnTimeoutMs;
  }

  user(userId) { const user = this.store.users.get(userId); if (!user) throw httpError(404, '用户不存在'); return user; }
  room(roomId) { const room = this.rooms.get(roomId) ?? [...this.rooms.values()].find((value) => value.code === String(roomId)); if (!room) throw httpError(404, '德州房间不存在'); return room; }
  reclaimRoom(roomId) {
    const room = this.room(roomId);
    if (activePlayers(room).length || room.spectators.size) return false;
    for (const player of room.players.values()) {
      player.holeCards = [];
      player.evaluation = null;
    }
    room.players.clear();
    room.spectators.clear();
    room.messages = [];
    room.chatLastAt = new Map();
    room.events = [];
    room.deck = [];
    room.board = [];
    room.hand = null;
    return this.rooms.delete(room.id);
  }
  canAccess(roomId, userId) {
    const room = this.room(roomId);
    return room.spectators.has(userId) || activePlayers(room).some((player) => player.userId === userId);
  }
  now() { return Number(this.clock?.now?.() ?? Date.now()); }
  timestamp() { return new Date(this.now()).toISOString(); }
  touch(room) { room.version += 1; room.updatedAt = this.timestamp(); return room; }
  ledger(room, entry) { room.pendingLedger.push(entry); }

  refreshTurnDeadline(room) {
    if (!ACTIVE_STREETS.has(room.status) || room.currentTurn < 0) {
      room.turnStartedAt = null;
      room.turnDeadlineAt = null;
      return room;
    }
    room.turnStartedAt = this.timestamp();
    room.turnDeadlineAt = new Date(this.now() + this.turnTimeoutMs).toISOString();
    return room;
  }

  createRoom(userId, input = {}) {
    const user = this.user(userId);
    if ([...this.rooms.values()].some((room) => activePlayers(room).some((player) => player.userId === userId))) throw httpError(409, '账号已在德州房间中');
    const smallBlind = Math.max(1, Math.floor(numeric(input.smallBlind, DEFAULTS.smallBlind)));
    const bigBlind = Math.max(smallBlind * 2, Math.floor(numeric(input.bigBlind, DEFAULTS.bigBlind)));
    const minBuyIn = Math.max(bigBlind * 20, Math.floor(numeric(input.minBuyIn, bigBlind * 20)));
    const maxBuyIn = Math.max(minBuyIn, Math.floor(numeric(input.maxBuyIn, bigBlind * 100)));
    const maxPlayers = Math.min(9, Math.max(2, Math.floor(numeric(input.maxPlayers, DEFAULTS.maxPlayers))));
    const id = randomUUID();
    const room = {
      id, code:String(input.code ?? Math.floor(100000 + Math.random() * 900000)), status:'waiting', hostUserId:userId,
      isPublic:input.isPublic !== false, allowSpectators:Boolean(input.allowSpectators), spectatorCards:Boolean(input.allowSpectators),
      smallBlind, bigBlind, minBuyIn, maxBuyIn, maxPlayers, dealerSeat:null, currentTurn:-1, currentBet:0, minRaise:bigBlind,
      pot:0, pots:[], board:[], deck:[], handNumber:0, hand:null, players:new Map(), spectators:new Set(),
      events:[], eventSeq:0, version:0, processedActions:[], pendingLedger:[], pendingClientActions:[],
      messages:[], chatLastAt:new Map(), turnStartedAt:null, turnDeadlineAt:null,
      createdAt:this.timestamp(), updatedAt:this.timestamp()
    };
    this.rooms.set(id, room);
    try {
      this.joinRoom(id, userId, { seat:0, buyIn:input.buyIn });
    } catch (error) {
      this.rooms.delete(id);
      throw error;
    }
    appendEvent(room, 'texas_room_created', { code:room.code, hostNickname:user.nickname });
    return this.touch(room);
  }

  joinRoom(roomId, userId, input = {}) {
    const room = this.room(roomId);
    if (room.status === 'closed') throw httpError(409, '房间已关闭');
    const user = this.user(userId);
    const existing = activePlayers(room).find((player) => player.userId === userId);
    if (existing) return room;
    if ([...this.rooms.values()].some((candidate) => candidate.id !== room.id && activePlayers(candidate).some((player) => player.userId === userId))) throw httpError(409, '账号已在其他德州房间中');
    if (activePlayers(room).length >= room.maxPlayers) throw httpError(409, '房间已满');
    const buyIn = Math.floor(numeric(input.buyIn, Math.min(DEFAULTS.defaultBuyIn, room.maxBuyIn)));
    if (buyIn < room.minBuyIn || buyIn > room.maxBuyIn) throw httpError(400, `买入需在 ${room.minBuyIn}-${room.maxBuyIn} 之间`);
    if (userBeans(user) < buyIn) throw httpError(400, '账户豆子不足以买入');
    const used = new Set(activePlayers(room).map((player) => player.seat));
    const requested = Number(input.seat);
    const seat = Number.isInteger(requested) && requested >= 0 && requested < room.maxPlayers && !used.has(requested)
      ? requested : [...Array(room.maxPlayers).keys()].find((value) => !used.has(value));
    const player = { id:randomUUID(), userId, nickname:user.nickname, seat, stack:buyIn, buyIn, inHand:false, waiting:ACTIVE_STREETS.has(room.status), folded:false, allIn:false, acted:false, canRaise:true, streetBet:0, totalContribution:0, actionSeq:0, lastAction:null, holeCards:[], evaluation:null, pendingLeave:false, left:false, spectating:false };
    user.beans = userBeans(user) - buyIn;
    room.players.set(player.id, player);
    room.spectators.delete(userId);
    this.ledger(room, { idempotencyKey:`texas:${room.id}:buyin:${player.id}`, userId, roomId:room.id, handId:null, entryType:'buy_in', amount:-buyIn, balanceAfter:user.beans, metadata:{ seat } });
    appendEvent(room, 'texas_player_joined', { userId, nickname:user.nickname, seat, waiting:player.waiting });
    return this.touch(room);
  }

  setSpectating(roomId, userId, enabled = true) {
    const room = this.room(roomId);
    if (enabled && room.status === 'closed') throw httpError(409, '房间已关闭');
    if (enabled && !room.allowSpectators) throw httpError(403, '房主未开启观战');
    const player = activePlayers(room).find((value) => value.userId === userId);
    if (enabled && player) {
      if (player.inHand && ACTIVE_STREETS.has(room.status)) throw httpError(409, '当前手牌中不能切换观战');
      cashOut(room, player, this.user(userId), 'spectate');
      if (room.hostUserId === userId) room.hostUserId = activePlayers(room)[0]?.userId ?? null;
    }
    if (enabled) room.spectators.add(userId); else room.spectators.delete(userId);
    if (!activePlayers(room).length) room.status = 'closed';
    appendEvent(room, enabled ? 'texas_spectator_joined' : 'texas_spectator_left', { userId });
    return this.touch(room);
  }

  updateSettings(roomId, userId, input = {}) {
    const room = this.room(roomId);
    if (room.hostUserId !== userId) throw httpError(403, '只有房主可以修改房间设置');
    if (input.allowSpectators !== undefined) room.allowSpectators = Boolean(input.allowSpectators);
    room.spectatorCards = room.allowSpectators;
    appendEvent(room, 'texas_room_settings', { allowSpectators:room.allowSpectators, spectatorCards:room.spectatorCards });
    return this.touch(room);
  }

  rebuy(roomId, userId, amount) {
    const room = this.room(roomId);
    if (!['waiting','settled'].includes(room.status)) throw httpError(409, '只能在两手牌之间补充筹码');
    const player = activePlayers(room).find((value) => value.userId === userId);
    if (!player) throw httpError(404, '玩家不在房间中');
    const value = Math.floor(numeric(amount));
    if (value <= 0 || player.stack + value > room.maxBuyIn) throw httpError(400, `牌桌筹码不能超过 ${room.maxBuyIn}`);
    const user = this.user(userId);
    if (userBeans(user) < value) throw httpError(400, '账户豆子不足');
    user.beans -= value; player.stack += value;
    this.ledger(room, { idempotencyKey:`texas:${room.id}:rebuy:${player.id}:${room.version}`, userId, roomId:room.id, handId:room.hand?.id ?? null, entryType:'rebuy', amount:-value, balanceAfter:user.beans, metadata:{} });
    appendEvent(room, 'texas_player_rebuy', { userId, amount:value, stack:player.stack });
    return this.touch(room);
  }

  startHand(roomId, userId) {
    const room = this.room(roomId);
    if (room.hostUserId !== userId) throw httpError(403, '只有房主可以开始下一手');
    if (!['waiting','settled'].includes(room.status)) throw httpError(409, '当前不能开始下一手');
    const players = activePlayers(room).filter((player) => player.stack > 0);
    if (players.length < 2) throw httpError(409, '至少需要两名有筹码玩家');
    room.dealerSeat = room.dealerSeat === null ? players.sort((a,b) => a.seat-b.seat)[0].seat : nextSeat(players, room.dealerSeat, () => true);
    room.handNumber += 1;
    room.hand = { id:randomUUID(), number:room.handNumber, startedAt:new Date().toISOString() };
    room.status = 'preflop'; room.board = []; room.deck = shuffledDeck(); room.pot = 0; room.pots = []; room.currentBet = 0; room.minRaise = room.bigBlind;
    for (const player of activePlayers(room)) {
      player.inHand = player.stack > 0; player.waiting = player.stack <= 0; player.folded = false; player.allIn = false;
      player.acted = false; player.canRaise = true; player.streetBet = 0; player.totalContribution = 0; player.actionSeq = 0;
      player.lastAction = null; player.holeCards = []; player.evaluation = null; player.pendingLeave = false;
    }
    const ordered = players.sort((a,b) => a.seat-b.seat);
    for (let card = 0; card < 2; card += 1) for (const player of ordered) player.holeCards.push(room.deck.pop());
    const positions = blindPositions(players, room.dealerSeat);
    const small = players.find((player) => player.seat === positions.smallBlindSeat);
    const big = players.find((player) => player.seat === positions.bigBlindSeat);
    const smallPaid = takeChips(room, small, room.smallBlind);
    const bigPaid = takeChips(room, big, room.bigBlind);
    // The live bring-in remains one big blind even when the big blind is short all-in.
    room.currentBet = room.bigBlind;
    room.currentTurn = positions.firstPreflopSeat;
    if (players.find((player) => player.seat === room.currentTurn)?.allIn) room.currentTurn = nextActionSeat(room, room.currentTurn);
    appendEvent(room, 'texas_hand_started', { handId:room.hand.id, handNumber:room.handNumber, dealerSeat:room.dealerSeat, smallBlindSeat:small.seat, bigBlindSeat:big.seat });
    appendEvent(room, 'texas_blinds_posted', { smallBlind:{ seat:small.seat, amount:smallPaid }, bigBlind:{ seat:big.seat, amount:bigPaid } });
    if (actionable(room).length === 0) this.runoutAndSettle(room);
    const updated = this.touch(room);
    this.refreshTurnDeadline(room);
    return updated;
  }

  action(roomId, userId, input = {}) {
    const room = this.room(roomId);
    if (!ACTIVE_STREETS.has(room.status)) throw httpError(409, '当前不能行动');
    const clientActionId = String(input.clientActionId ?? '');
    if (clientActionId.length < 8) throw httpError(400, '缺少有效的客户端动作编号');
    if (room.processedActions.includes(clientActionId)) return room;
    if (input.version !== undefined && Number(input.version) !== room.version) throw httpError(409, '房间状态已更新，请同步后重试');
    if (input.handId && input.handId !== room.hand?.id) throw httpError(409, '该操作不属于当前手牌');
    const player = activePlayers(room).find((value) => value.userId === userId && value.inHand);
    if (!player) throw httpError(403, '玩家不在当前手牌中');
    const actionSeq = Number(input.actionSeq);
    if (!Number.isInteger(actionSeq) || actionSeq !== player.actionSeq + 1) throw httpError(409, '动作序号错误');
    if (room.currentTurn !== player.seat) throw httpError(409, '还没有轮到你');
    const permitted = allowedActions(room, player);
    const type = String(input.type ?? input.action ?? '');
    if (!permitted.actions.includes(type)) throw httpError(400, '当前不能执行该操作');
    const oldCurrentBet = room.currentBet;
    let paid = 0;
    let fullRaise = false;
    if (type === 'fold') player.folded = true;
    else if (type === 'check') player.acted = true;
    else if (type === 'call') { paid = takeChips(room, player, permitted.toCall); player.acted = true; }
    else {
      let target = type === 'all_in' ? player.streetBet + player.stack : Math.floor(numeric(input.amount));
      if (target <= player.streetBet || target > player.streetBet + player.stack) throw httpError(400, '下注金额无效');
      if (type === 'bet' && oldCurrentBet !== 0) throw httpError(400, '已有下注时必须加注');
      if (type === 'raise' && oldCurrentBet === 0) throw httpError(400, '当前应使用下注');
      const increase = target - oldCurrentBet;
      const isAllInTarget = target === player.streetBet + player.stack;
      if (oldCurrentBet === 0 && target < room.bigBlind && !isAllInTarget) throw httpError(400, `最小下注为 ${room.bigBlind}`);
      if (oldCurrentBet > 0 && increase < room.minRaise && !isAllInTarget) throw httpError(400, `最小加注到 ${oldCurrentBet + room.minRaise}`);
      paid = takeChips(room, player, target - player.streetBet);
      if (target > oldCurrentBet) {
        fullRaise = oldCurrentBet === 0 ? target >= room.bigBlind : increase >= room.minRaise;
        room.currentBet = target;
        if (fullRaise) {
          room.minRaise = oldCurrentBet === 0 ? target : increase;
          for (const other of actionable(room)) { other.acted = false; other.canRaise = true; }
        }
      }
      player.acted = true;
      if (!fullRaise && target > oldCurrentBet) {
        for (const other of actionable(room)) if (other.acted) other.canRaise = false;
      }
    }
    player.lastAction = type; player.actionSeq = actionSeq;
    room.processedActions.push(clientActionId);
    room.pendingClientActions ??= [];
    room.pendingClientActions.push({ clientActionId,roomId:room.id,handId:room.hand.id,userId,roomVersion:room.version+1 });
    if (room.processedActions.length > 200) room.processedActions.splice(0, room.processedActions.length - 200);
    appendEvent(room, 'texas_player_action', { userId, nickname:player.nickname, seat:player.seat, action:type, paid, streetBet:player.streetBet, fullRaise });
    this.progress(room, player.seat);
    const updated = this.touch(room);
    this.refreshTurnDeadline(room);
    return updated;
  }

  timeoutFold(roomId, context = {}) {
    const room = this.room(roomId);
    if (!ACTIVE_STREETS.has(room.status)) return room;
    const player = activePlayers(room).find((value) => value.inHand && value.seat === room.currentTurn);
    if (!player) return room;
    if (context.roomVersion !== undefined && Number(context.roomVersion) !== room.version) return room;
    if (context.handId !== undefined && context.handId !== room.hand?.id) return room;
    if (context.currentTurn !== undefined && Number(context.currentTurn) !== room.currentTurn) return room;
    if (context.actionSeq !== undefined && Number(context.actionSeq) !== player.actionSeq) return room;
    player.folded = true;
    player.acted = true;
    player.lastAction = 'timeout';
    player.actionSeq += 1;
    appendEvent(room, 'texas_player_action', { userId:player.userId, nickname:player.nickname, seat:player.seat, action:'timeout', paid:0, streetBet:player.streetBet, fullRaise:false });
    this.progress(room, player.seat);
    const updated = this.touch(room);
    this.refreshTurnDeadline(room);
    return updated;
  }

  progress(room, fromSeat) {
    if (contenders(room).length <= 1) return this.settle(room);
    if (actionable(room).length === 0) return this.runoutAndSettle(room);
    const complete = actionable(room).every((player) => player.acted && player.streetBet === room.currentBet);
    if (complete) {
      if (room.status === 'river') return this.settle(room);
      revealStreet(room, room.status === 'preflop' ? 'flop' : room.status === 'flop' ? 'turn' : 'river');
      if (actionable(room).length === 0) return this.runoutAndSettle(room);
      return room;
    }
    room.currentTurn = nextActionSeat(room, fromSeat);
    if (room.currentTurn < 0) this.runoutAndSettle(room);
    return room;
  }

  runoutAndSettle(room) {
    while (room.board.length < 5) revealStreet(room, room.board.length === 0 ? 'flop' : room.board.length === 3 ? 'turn' : 'river');
    return this.settle(room);
  }

  settle(room) {
    if (room.status === 'settled' || !room.hand) return room;
    if (contenders(room).length > 1 && room.board.length < 5) return this.runoutAndSettle(room);
    for (const player of contenders(room)) {
      const availableCards = [...player.holeCards, ...room.board];
      player.evaluation = availableCards.length >= 5 ? evaluateTexasHand(availableCards) : null;
    }
    const { payouts, pots } = calculateTexasPots(handPlayers(room), room.dealerSeat);
    room.pots = pots;
    const results = [];
    for (const player of handPlayers(room)) {
      const payout = numeric(payouts[player.id]);
      player.stack += payout;
      const net = payout - player.totalContribution;
      const user = this.user(player.userId);
      if (net > 0) user.wins = numeric(user.wins) + 1;
      else if (net < 0) user.losses = numeric(user.losses) + 1;
      results.push({ userId:player.userId, nickname:player.nickname, seat:player.seat, payout, net, folded:player.folded, holeCards:player.holeCards, handType:player.evaluation?.name ?? null, bestCards:player.evaluation?.cards ?? [] });
    }
    room.status = 'settled'; room.currentTurn = -1; room.currentBet = 0; room.pot = 0;
    room.turnStartedAt = null; room.turnDeadlineAt = null;
    room.hand.settledAt = new Date().toISOString(); room.hand.results = results;
    appendEvent(room, 'texas_hand_settled', { handId:room.hand.id, board:room.board, pots, players:results });
    for (const player of [...room.players.values()].filter((value) => value.pendingLeave)) cashOut(room, player, this.user(player.userId), 'after_hand');
    return room;
  }

  leaveRoom(roomId, userId) {
    const room = this.room(roomId);
    const player = activePlayers(room).find((value) => value.userId === userId);
    room.spectators.delete(userId);
    if (player) {
      if (player.inHand && ACTIVE_STREETS.has(room.status)) {
        player.folded = true; player.pendingLeave = true; player.lastAction = 'leave';
        appendEvent(room, 'texas_player_left', { userId, seat:player.seat, pending:true });
        if (contenders(room).length <= 1) this.settle(room);
        else if (actionable(room).length === 0) this.runoutAndSettle(room);
        else if (room.currentTurn === player.seat) this.progress(room, player.seat);
      } else {
        const amount = cashOut(room, player, this.user(userId));
        appendEvent(room, 'texas_player_left', { userId, seat:player.seat, returned:amount });
      }
    }
    if (room.hostUserId === userId) room.hostUserId = activePlayers(room).find((value) => !value.pendingLeave)?.userId ?? null;
    if (!activePlayers(room).length) room.status = 'closed';
    const updated = this.touch(room);
    this.refreshTurnDeadline(room);
    return updated;
  }

  addMessage(roomId, userId, text, { now = this.now() } = {}) {
    const room = this.room(roomId);
    const player = activePlayers(room).find((value) => value.userId === userId);
    if (!player) throw httpError(403, '观战者只能查看聊天');
    const normalized = String(text ?? '').trim();
    if (!normalized) throw httpError(400, '消息不能为空');
    if (normalized.length > 120) throw httpError(400, '消息不能超过120个字符');
    room.chatLastAt ??= new Map();
    const previous = room.chatLastAt.get(userId);
    const timestamp = Number(now);
    if (Number.isFinite(previous) && timestamp - previous < 1000) throw httpError(429, '发送消息过于频繁');
    room.chatLastAt.set(userId, timestamp);
    room.messages ??= [];
    const message = { id:(room.chatSeq = Number(room.chatSeq ?? 0) + 1), userId, nickname:player.nickname, text:normalized, createdAt:new Date(timestamp).toISOString() };
    room.messages.push(message);
    if (room.messages.length > 20) room.messages.splice(0, room.messages.length - 20);
    appendEvent(room, 'texas_chat_message', { message });
    this.touch(room);
    return message;
  }

  listRooms() {
    return [...this.rooms.values()].filter((room) => room.isPublic && room.status !== 'closed').map((room) => ({
      id:room.id, code:room.code, status:room.status, playerCount:activePlayers(room).length, maxPlayers:room.maxPlayers,
      smallBlind:room.smallBlind, bigBlind:room.bigBlind, minBuyIn:room.minBuyIn, maxBuyIn:room.maxBuyIn, allowSpectators:room.allowSpectators,
      hostNickname:this.store.users.get(room.hostUserId)?.nickname ?? '等待房主'
    })).filter((room) => room.playerCount > 0).sort((left,right) => left.code.localeCompare(right.code));
  }

  snapshot(roomId, userId) {
    const room = this.room(roomId);
    const spectator = room.spectators.has(userId);
    const own = activePlayers(room).find((player) => player.userId === userId);
    if (!spectator && !own) throw httpError(403, '请先加入房间或申请观战');
    const settled = room.status === 'settled';
    const players = activePlayers(room).map((player) => {
      const showCards = player.userId === userId || (settled && !player.folded) || spectator;
      return {
        id:player.id, userId:player.userId, nickname:player.nickname, seat:player.seat, stack:player.stack,
        inHand:player.inHand, waiting:player.waiting, folded:player.folded, allIn:player.allIn, pendingLeave:player.pendingLeave,
        streetBet:player.streetBet, totalContribution:player.totalContribution, actionSeq:player.actionSeq, lastAction:player.lastAction,
        holeCards:showCards ? player.holeCards : undefined, handType:showCards && player.evaluation ? player.evaluation.name : undefined
      };
    });
    return {
      id:room.id, code:room.code, status:room.status, hostUserId:room.hostUserId, version:room.version,
      isPublic:room.isPublic, allowSpectators:room.allowSpectators, spectatorCards:room.allowSpectators, isSpectator:spectator,
      smallBlind:room.smallBlind, bigBlind:room.bigBlind, minBuyIn:room.minBuyIn, maxBuyIn:room.maxBuyIn, maxPlayers:room.maxPlayers,
      dealerSeat:room.dealerSeat, currentTurn:room.currentTurn, currentBet:room.currentBet, minRaise:room.minRaise,
      pot:settled ? room.pots.reduce((sum,pot) => sum+numeric(pot.amount),0) : room.pot,
      pots:room.pots, board:room.board, handNumber:room.handNumber, handId:room.hand?.id ?? null,
       turnStartedAt:room.turnStartedAt ?? null, turnDeadlineAt:room.turnDeadlineAt ?? null,
       players, messages:(room.messages ?? []).map((message) => ({ ...message })), allowedActions:own ? allowedActions(room, own) : { actions:[], toCall:0, minRaiseTo:0, maxRaiseTo:0 },
      recentEvents:room.events.slice(-30).map((event) => this.publicEvent(room, event, userId))
    };
  }

  publicEvent(room, event, userId) {
    if (event.eventType !== 'texas_hand_settled') return event;
    const spectator = room.spectators.has(userId);
    return { ...event, payload:{ ...event.payload, players:event.payload.players.map((player) => {
      const showCards = !player.folded || player.userId === userId || spectator;
      return { ...player, holeCards:showCards ? player.holeCards : undefined, bestCards:showCards ? player.bestCards : undefined, handType:showCards ? player.handType : undefined };
    }) } };
  }

  eventsSince(roomId, userId, after = 0) {
    const room = this.room(roomId);
    return room.events.filter((event) => event.id > Number(after)).map((event) => this.publicEvent(room, event, userId));
  }
}

export { DEFAULTS };
