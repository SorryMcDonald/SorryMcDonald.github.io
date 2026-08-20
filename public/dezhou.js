import { eventEffects, initialEventCursor } from './dezhou-effects.js';

const state = {
  user:null, room:null, rooms:[], ws:null, poll:null, countdown:null, bannerTimer:null,
  authMode:'login', acting:false, lastEventId:0, eventCursorReady:false,
  leaderboardKind:'wealth', musicEnabled:true, effectsEnabled:true, motionMode:'light'
};
const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['preflop','flop','turn','river']);
const STATUS = { waiting:'等待开局', preflop:'翻牌前', flop:'翻牌', turn:'转牌', river:'河牌', settled:'本手已结算', closed:'已关闭' };
const RANK = { 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10', 11:'J', 12:'Q', 13:'K', 14:'A' };
const SUIT = { S:'♠', H:'♥', C:'♣', D:'♦' };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials:'include', headers:{ 'content-type':'application/json', ...(options.headers ?? {}) }, ...options,
    body:options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? data.message ?? '请求失败');
  return data;
}

function text(id, value) { const node = $(id); if (node) node.textContent = String(value ?? ''); }
function money(value) { return Number(value ?? 0).toLocaleString('zh-CN'); }
function uid() { return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function me() { return state.room?.players.find((player) => player.userId === state.user?.id); }
function setActiveNav(destination) { document.querySelectorAll('[data-nav]').forEach((node) => node.classList.toggle('active', node.dataset.nav === destination)); }
function cardKey(card) { return card ? `${Number(card.rank)}:${card.suit}` : ''; }

function cardNode(card, concealed = false) {
  const node = document.createElement('span');
  node.className = 'poker-card';
  if (!card) {
    node.classList.add(concealed ? 'back' : 'empty');
    node.setAttribute('aria-label', concealed ? '牌背' : '空牌位');
    return node;
  }
  const suit = SUIT[card.suit] ?? card.suit;
  const rank = RANK[Number(card.rank)] ?? card.rank;
  if (['♥','♦'].includes(suit)) node.classList.add('red');
  node.dataset.cardKey = cardKey(card);
  node.setAttribute('aria-label', `${rank}${suit}`);
  const index = document.createElement('span'); index.className = 'card-index';
  const rankNode = document.createElement('span'); rankNode.textContent = rank;
  const suitNode = document.createElement('span'); suitNode.className = 'card-suit'; suitNode.textContent = suit;
  const center = document.createElement('span'); center.className = 'card-center'; center.textContent = suit;
  index.append(rankNode, suitNode); node.append(index, center);
  return node;
}

function seatPosition(index, total) {
  if (total <= 1) return { left:'50%', top:'21%' };
  const angle = (200 + (140 * index) / (total - 1)) * Math.PI / 180;
  return { left:`${50 + 43 * Math.cos(angle)}%`, top:`${46 + 35 * Math.sin(angle)}%` };
}

function projectedSeatSlots(room) {
  const own = me();
  const count = Math.max(2, Number(room.maxPlayers ?? room.players.length));
  const players = new Map(room.players.map((player) => [Number(player.seat), player]));
  const anchor = own ? Number(own.seat) : 0;
  const slots = [];
  let arcIndex = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const seat = (anchor + offset) % count;
    const self = Boolean(own && seat === Number(own.seat));
    const position = self ? { left:'50%', top:'84%' } : seatPosition(arcIndex++, own ? count - 1 : count);
    slots.push({ seat, player:players.get(seat) ?? null, self, position });
  }
  return slots;
}

function badge(label, kind = '') { const node = document.createElement('span'); node.className = `badge ${kind}`; node.textContent = label; return node; }
function lastStartEvent(room) { return [...(room.recentEvents ?? [])].reverse().find((event) => event.eventType === 'texas_hand_started' && event.handId === room.handId); }

function renderBetStack(player) {
  const stack = document.createElement('div');
  stack.className = 'bet-stack';
  stack.dataset.amount = String(Number(player.streetBet ?? 0));
  if (!Number(player.streetBet)) return stack;
  const count = Math.min(5, Math.max(1, Math.ceil(Number(player.streetBet) / Math.max(1, Number(state.room?.bigBlind)))));
  for (let index = 0; index < count; index += 1) {
    const chip = document.createElement('span'); chip.className = 'table-chip'; chip.style.setProperty('--chip-index', String(index)); stack.append(chip);
  }
  const amount = document.createElement('strong'); amount.className = 'bet-amount'; amount.textContent = money(player.streetBet); stack.append(amount);
  return stack;
}

function renderEmptySeat(slot) {
  const seat = document.createElement('article'); seat.className = 'empty-seat'; seat.dataset.seat = String(slot.seat);
  seat.style.setProperty('--seat-left', slot.position.left); seat.style.setProperty('--seat-top', slot.position.top);
  const glow = document.createElement('span'); glow.className = 'empty-seat-glow';
  const label = document.createElement('span'); label.textContent = '空座位'; seat.append(glow, label);
  return seat;
}

function renderPlayerSeat(slot, start) {
  const { player, self, position } = slot;
  const seat = document.createElement('article'); seat.className = 'player-seat'; seat.dataset.userId = player.userId; seat.dataset.seat = String(player.seat);
  seat.style.setProperty('--seat-left', position.left); seat.style.setProperty('--seat-top', position.top);
  if (self) seat.classList.add('self', 'me');
  if (player.folded) seat.classList.add('folded');
  if (player.allIn) seat.classList.add('all-in');
  if (player.seat === state.room.currentTurn) seat.classList.add('current');
  const avatar = document.createElement('span'); avatar.className = 'player-avatar'; avatar.textContent = String(player.nickname ?? '?').slice(0, 1);
  const name = document.createElement('div'); name.className = 'player-name'; name.textContent = `${player.nickname}${self ? '（你）' : ''}`;
  const chips = document.createElement('div'); chips.className = 'player-stack';
  const stackValue = document.createElement('span'); stackValue.className = 'stack-value'; stackValue.textContent = money(player.stack);
  chips.append(stackValue, document.createTextNode(' 筹码'));
  const badges = document.createElement('div'); badges.className = 'player-badges';
  if (player.seat === state.room.dealerSeat) badges.append(badge('D'));
  if (player.seat === start.smallBlindSeat) badges.append(badge('SB','blind'));
  if (player.seat === start.bigBlindSeat) badges.append(badge('BB','blind'));
  if (player.allIn) badges.append(badge('ALL IN','all-in-label'));
  else if (player.folded) badges.append(badge('弃牌','fold-label'));
  else if (player.waiting || !player.inHand) badges.append(badge('等待','waiting'));
  const cards = document.createElement('div'); cards.className = 'hole-cards';
  const visible = !player.folded && Array.isArray(player.holeCards) ? player.holeCards : null;
  const slots = visible ?? (player.inHand ? [null, null] : []);
  slots.forEach((card) => cards.append(cardNode(card, !visible)));
  seat.append(avatar, name, chips, badges, cards, renderBetStack(player));
  return seat;
}

function renderSeats() {
  const container = $('seats'); container.replaceChildren(); if (!state.room) return;
  const start = lastStartEvent(state.room)?.payload ?? {};
  for (const slot of projectedSeatSlots(state.room)) container.append(slot.player ? renderPlayerSeat(slot, start) : renderEmptySeat(slot));
}

function renderBoard() {
  const cards = [...(state.room?.board ?? [])];
  $('communityCards').replaceChildren(...Array.from({ length:5 }, (_, index) => cardNode(cards[index] ?? null, false)));
}

function eventText(event) {
  const payload = event.payload ?? {};
  if (event.eventType === 'texas_player_joined') return `${payload.nickname} 加入座位 ${Number(payload.seat) + 1}${payload.waiting ? '，等待下一手' : ''}`;
  if (event.eventType === 'texas_player_left') return `座位 ${Number(payload.seat) + 1} 离开房间`;
  if (event.eventType === 'texas_hand_started') return `第 ${payload.handNumber} 手开始，庄家位于座位 ${Number(payload.dealerSeat) + 1}`;
  if (event.eventType === 'texas_blinds_posted') return `小盲 ${money(payload.smallBlind?.amount)}，大盲 ${money(payload.bigBlind?.amount)}`;
  if (event.eventType === 'texas_player_action') {
    const action = { fold:'弃牌', check:'过牌', call:'跟注', bet:'下注', raise:'加注', all_in:'全押', timeout:'超时弃牌' }[payload.action] ?? payload.action;
    return `${payload.nickname} ${action}${payload.paid ? ` ${money(payload.paid)}` : ''}`;
  }
  if (event.eventType === 'flop_dealt') return '下注筹码归入底池，发出翻牌';
  if (event.eventType === 'turn_dealt') return '下注筹码归入底池，发出转牌';
  if (event.eventType === 'river_dealt') return '下注筹码归入底池，发出河牌';
  if (event.eventType === 'texas_player_rebuy') return `玩家补充 ${money(payload.amount)} 筹码`;
  if (event.eventType === 'texas_chat_message') return '';
  if (event.eventType === 'texas_hand_settled') {
    if (payload.uncontested) return '无人跟注，底池归最后一名玩家';
    const winners = (payload.players ?? []).filter((player) => player.payout > 0).map((player) => `${player.nickname} +${money(player.payout)}`);
    return `本手结算：${winners.join('，') || '无赢家'}`;
  }
  return '';
}

function renderFeed() {
  const feed = $('eventFeed'); feed.replaceChildren();
  for (const event of [...(state.room?.recentEvents ?? [])].reverse()) {
    const message = eventText(event); if (!message) continue;
    const line = document.createElement('p'); line.textContent = message;
    const stamp = document.createElement('time'); stamp.textContent = new Date(event.createdAt).toLocaleTimeString('zh-CN',{ hour:'2-digit', minute:'2-digit' });
    line.prepend(stamp); feed.append(line);
  }
}

function renderChat() {
  const container = $('chatMessages'); container.replaceChildren();
  for (const message of state.room?.messages ?? []) {
    const line = document.createElement('p'); const name = document.createElement('strong'); name.textContent = `${message.nickname}：`;
    line.append(name, document.createTextNode(message.text)); container.append(line);
  }
  container.scrollTop = container.scrollHeight;
  const readonly = state.room?.isSpectator; $('chatInput').disabled = readonly; $('chatSendButton').disabled = readonly;
  text('chatModeLabel', readonly ? '观战只读' : '最近20条');
}

function renderActions() {
  const room = state.room; if (!room) return;
  const allowed = room.allowedActions ?? { actions:[] }; const actions = new Set(allowed.actions ?? []); const player = me();
  const active = ACTIVE.has(room.status) && !room.isSpectator && player?.inHand; $('actionBar').hidden = !active;
  for (const [id, action] of [['foldButton','fold'],['checkButton','check'],['callButton','call'],['allInButton','all_in']]) $(id).disabled = state.acting || !actions.has(action);
  text('callButton', allowed.toCall ? `跟注 ${money(allowed.toCall)}` : '跟注');
  const canRaise = actions.has('raise') || actions.has('bet'); $('raiseButton').disabled = state.acting || !canRaise;
  $('raiseButton').dataset.action = actions.has('bet') ? 'bet' : 'raise'; text('raiseButton', actions.has('bet') ? '下注' : '加注');
  text('actionCostLabel', allowed.toCall ? `待跟 ${money(allowed.toCall)}` : '等待你的行动'); text('beansLabel', `${money(player?.stack)} 筹码`);
}

function renderCountdown() {
  clearInterval(state.countdown); const node = $('turnCountdown'); const room = state.room;
  if (!room?.turnDeadlineAt || room.currentTurn < 0 || room.status === 'settled') { node.hidden = true; return; }
  node.hidden = false;
  const tick = () => {
    const remain = Math.max(0, Math.ceil((Date.parse(room.turnDeadlineAt) - Date.now()) / 1000)); node.textContent = `${remain}s`;
    node.classList.toggle('danger', remain <= 10); if (remain <= 0) clearInterval(state.countdown);
  };
  tick(); state.countdown = setInterval(tick, 1000);
}

function renderRoom() {
  const room = state.room; if (!room) return renderLobby();
  $('lobbyView').hidden = true; $('tableView').hidden = false; $('createButton').hidden = true; $('joinCodeButton').hidden = true; $('leaveButton').hidden = false;
  $('startButton').hidden = !['waiting','settled'].includes(room.status) || room.hostUserId !== state.user.id;
  const player = me(); $('rebuyButton').hidden = Boolean(room.tournament) || !player || !['waiting','settled'].includes(room.status) || player.stack >= room.maxBuyIn;
  $('roomSettingsButton').hidden = Boolean(room.tournament) || room.hostUserId !== state.user.id; $('refillButton').hidden = Boolean(room.tournament) || Number(state.user?.beans) !== 0;
  text('roomTitle', room.tournament ? `锦标赛 · ${room.tournament.tableNumber} 桌` : `房间 ${room.code}`); text('statusBadge', STATUS[room.status] ?? room.status); text('potValue', money(room.pot)); text('handNumber', room.handNumber);
  text('blindText', `${money(room.smallBlind)} / ${money(room.bigBlind)}`); text('currentBet', money(room.currentBet)); text('minimumRaise', money(room.minRaise));
  const current = room.players.find((value) => value.seat === room.currentTurn);
  text('turnText', current ? (current.userId === state.user.id ? '轮到你行动' : `轮到 ${current.nickname}`) : (['waiting','settled'].includes(room.status) ? '等待房主开始下一手' : '牌局处理中'));
  text('sidePotText', (room.pots ?? []).length > 1 ? room.pots.map((pot,index) => `${index ? '边池' : '主池'} ${money(pot.amount)}`).join(' · ') : '');
  text('roleLabel', room.isSpectator ? '观战' : room.hostUserId === state.user.id ? '房主' : '玩家');
  renderBoard(); renderSeats(); renderActions(); renderFeed(); renderChat(); renderCountdown();
  try { sessionStorage.setItem('texas.roomId', room.id); } catch {}
}

function renderLobby() {
  $('lobbyView').hidden = false; $('tableView').hidden = true; $('createButton').hidden = false; $('joinCodeButton').hidden = false;
  $('leaveButton').hidden = true; $('startButton').hidden = true; $('rebuyButton').hidden = true; $('refillButton').hidden = Number(state.user?.beans) !== 0;
  $('roomSettingsButton').hidden = true; text('roomTitle','公开房间'); text('statusBadge','大厅');
}

function renderRoomList() {
  const list = $('roomList'); list.replaceChildren(); text('roomListStatus', state.rooms.length ? `找到 ${state.rooms.length} 个可用房间` : '暂无公开房间');
  for (const room of state.rooms) {
    const row = document.createElement('article'); row.className = 'room-row';
    const primary = document.createElement('div'); primary.className = 'room-primary';
    const code = document.createElement('strong'); code.textContent = `房间 ${room.code}`;
    const host = document.createElement('span'); host.textContent = `房主 ${room.hostNickname}`; primary.append(code,host);
    const detail = document.createElement('div'); detail.className = 'room-detail'; detail.textContent = `${STATUS[room.status] ?? room.status} · ${room.playerCount}/${room.maxPlayers} · 盲注 ${room.smallBlind}/${room.bigBlind}`;
    const actions = document.createElement('div'); actions.className = 'toolbar-actions';
    const join = document.createElement('button'); join.className = 'primary-button room-join-button'; join.textContent = room.playerCount >= room.maxPlayers ? '已满' : '入座';
    join.disabled = room.playerCount >= room.maxPlayers; join.addEventListener('click', () => openJoin(room)); actions.append(join);
    if (room.allowSpectators) { const watch = document.createElement('button'); watch.className = 'ghost-button'; watch.textContent = '观战'; watch.addEventListener('click', () => spectateRoom(room.id)); actions.append(watch); }
    row.append(primary, detail, actions); list.append(row);
  }
}

function tablePointForSeat(effect) {
  const table = $('pokerTable').getBoundingClientRect();
  const userId = String(effect.userId ?? '');
  const seat = (userId ? document.querySelector(`.player-seat[data-user-id="${CSS.escape(userId)}"]`) : null) ?? document.querySelector(`.player-seat[data-seat="${Number(effect.seat)}"]`);
  if (!seat) return { x:table.width / 2, y:table.height / 2 };
  const box = seat.getBoundingClientRect(); return { x:box.left - table.left + box.width / 2, y:box.top - table.top + box.height / 2 };
}

function appendTransient(node, duration = 1000) { $('tableEffectsLayer').append(node); window.setTimeout(() => node.remove(), duration); return node; }
function notifyTableEffect(effect, event) {
  const detail = { kind:effect.kind, eventId:Number(event?.id ?? 0), userId:effect.userId, seat:effect.seat };
  document.body.dataset.lastTableEffect = effect.kind; window.dispatchEvent(new CustomEvent('texas:table-effect',{ detail }));
}

function playSeatEntry(effect) {
  const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(effect.userId))}"]`); if (!seat) return;
  seat.classList.add('seat-entering','seat-edge-flash');
  const chips = document.createElement('div'); chips.className = 'entry-chip-stack';
  for (let index = 0; index < 4; index += 1) { const chip = document.createElement('span'); chip.className = 'entry-chip'; chip.style.setProperty('--chip-index',String(index)); chips.append(chip); }
  seat.append(chips); window.setTimeout(() => seat.classList.remove('seat-entering','seat-edge-flash'),950); window.setTimeout(() => chips.remove(),1200);
}

function makeChipFlight(className, start, end, label = '') {
  const flight = document.createElement('span'); flight.className = className;
  flight.style.setProperty('--from-x',`${start.x}px`); flight.style.setProperty('--from-y',`${start.y}px`);
  flight.style.setProperty('--to-x',`${end.x}px`); flight.style.setProperty('--to-y',`${end.y}px`); if (label) flight.dataset.label = label;
  return flight;
}

function playBet(effect) {
  const table = $('pokerTable').getBoundingClientRect(); const start = tablePointForSeat(effect);
  const end = { x:start.x + (table.width / 2 - start.x) * .48, y:start.y + (table.height / 2 - start.y) * .48 };
  appendTransient(makeChipFlight('bet-chip-flight',start,end,money(effect.amount)),800);
  const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(effect.userId))}"]`);
  seat?.querySelector('.bet-stack')?.classList.add('bet-stack-drop'); if (effect.allIn) seat?.classList.add('all-in-push');
}

function playCollectPot(effect) {
  const table = $('pokerTable').getBoundingClientRect(); const center = { x:table.width / 2, y:table.height / 2 + 18 };
  for (const bet of effect.bets ?? []) appendTransient(makeChipFlight('chip-to-pot',tablePointForSeat(bet),center,money(bet.amount)),750);
  const target = Number(effect.pot);
  if (Number.isFinite(target)) animateNumber($('potValue'),Math.max(0,target - (effect.bets ?? []).reduce((sum,bet) => sum + Number(bet.amount ?? 0),0)),target,430);
}

function playFold(effect) {
  const table = $('pokerTable').getBoundingClientRect(); const start = tablePointForSeat(effect); const end = { x:table.width / 2 + 28, y:table.height / 2 + 12 };
  const flight = document.createElement('div'); flight.className = 'fold-flight';
  flight.style.setProperty('--from-x',`${start.x}px`); flight.style.setProperty('--from-y',`${start.y}px`);
  flight.style.setProperty('--to-x',`${end.x}px`); flight.style.setProperty('--to-y',`${end.y}px`);
  for (let index = 0; index < 2; index += 1) { const card = cardNode(null,true); card.classList.add('fold-flight-card'); flight.append(card); }
  appendTransient(flight,1150);
}

function playCheck(effect) {
  const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(effect.userId))}"]`); seat?.classList.add('seat-check-flash');
  window.setTimeout(() => seat?.classList.remove('seat-check-flash'),650);
  const toast = document.createElement('span'); toast.className = 'action-toast check-toast'; toast.textContent = '✓ 过牌';
  const point = tablePointForSeat(effect); toast.style.left = `${point.x}px`; toast.style.top = `${point.y}px`; appendTransient(toast,800);
}

function animateNumber(node, from, to, duration = 650) {
  if (!node) return;
  if (state.motionMode === 'disabled') { node.textContent = money(to); return; }
  const startedAt = performance.now();
  const step = (now) => { const progress = Math.min(1,(now - startedAt) / duration); node.textContent = money(Math.round(from + (to - from) * (1 - (1 - progress) ** 3))); if (progress < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function highlightWinningCards(result) {
  const keys = new Set((result.bestCards ?? []).map(cardKey)); if (!keys.size) return;
  const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(result.userId))}"]`);
  seat?.querySelectorAll('[data-card-key]').forEach((card) => card.classList.toggle('winning-card',keys.has(card.dataset.cardKey)));
  $('communityCards').querySelectorAll('[data-card-key]').forEach((card) => card.classList.toggle('winning-card',keys.has(card.dataset.cardKey)));
}

function playPotAward(label, amount, winner) {
  const table = $('pokerTable').getBoundingClientRect(); const start = { x:table.width / 2, y:table.height / 2 + 12 };
  appendTransient(makeChipFlight('pot-award-flight',start,tablePointForSeat(winner),`${label} ${money(amount)}`),1150);
}

function playSettlement(effect) {
  const uncontested = effect.kind === 'uncontested';
  const winners = effect.players.filter((player) => effect.winnerUserIds.includes(player.userId));
  const losers = effect.players.filter((player) => effect.loserUserIds.includes(player.userId));
  const strip = $('settlementStrip');
  strip.textContent = uncontested ? `无人跟注 · ${winners.map((winner) => `${winner.nickname} +${money(winner.payout)}`).join('，')}` : winners.map((winner) => `${winner.nickname} ${winner.handType ?? '胜出'} · +${money(winner.payout)}`).join(' · ');
  strip.classList.add('visible',uncontested ? 'uncontested' : 'showdown'); window.setTimeout(() => strip.classList.remove('visible','uncontested','showdown'),3300);
  for (const winner of winners) {
    const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(winner.userId))}"]`); seat?.classList.add('winner-seat');
    if (!uncontested) highlightWinningCards(winner);
    const stack = seat?.querySelector('.stack-value');
    if (stack) { const finalValue = Number(String(stack.textContent).replace(/,/g,'')); animateNumber(stack,Math.max(0,finalValue - Number(winner.payout ?? 0)),finalValue,900); }
  }
  for (const loser of losers) {
    const seat = document.querySelector(`.player-seat[data-user-id="${CSS.escape(String(loser.userId))}"]`); if (!seat) continue;
    seat.classList.add('loser-seat','loser-animating'); const loss = document.createElement('span'); loss.className = 'net-result loss'; loss.textContent = `本局 ${money(loser.net)}`; seat.append(loss);
    window.setTimeout(() => seat.classList.remove('loser-animating'),850); window.setTimeout(() => { seat.classList.remove('loser-seat'); loss.remove(); },2100);
  }
  const fallbackWinners = winners.map((winner) => ({ userId:winner.userId, seat:winner.seat }));
  const pots = effect.pots.length ? effect.pots : [{ amount:winners.reduce((sum,winner) => sum + Number(winner.payout ?? 0),0) }];
  pots.forEach((pot,index) => {
    const eligible = (pot.winnerIds ?? []).length ? winners.filter((winner) => pot.winnerIds.includes(winner.playerId)) : winners;
    for (const winner of eligible.length ? eligible : fallbackWinners) playPotAward(index ? `边池 ${index}` : '主池',pot.amount,winner);
  });
}

function playTableEvent(event) {
  for (const effect of eventEffects(event)) {
    notifyTableEffect(effect,event);
    if (state.motionMode === 'disabled') { if (effect.kind === 'settlement' || effect.kind === 'uncontested') playSettlement(effect); continue; }
    if (effect.kind === 'seat-entry') playSeatEntry(effect);
    else if (effect.kind === 'bet') playBet(effect);
    else if (effect.kind === 'collect-pot') playCollectPot(effect);
    else if (effect.kind === 'fold') playFold(effect);
    else if (effect.kind === 'check') playCheck(effect);
    else if (effect.kind === 'settlement' || effect.kind === 'uncontested') playSettlement(effect);
  }
}

function applyRoomSnapshot(room, { baseline = false } = {}) {
  const roomChanged = state.room?.id && state.room.id !== room.id;
  if (roomChanged) { state.lastEventId = 0; state.eventCursorReady = false; }
  const events = [...(room.recentEvents ?? [])].sort((left,right) => Number(left.id) - Number(right.id));
  const latestEventId = initialEventCursor(events);
  if (!baseline && state.eventCursorReady && state.room?.id === room.id && Number(room.version) <= Number(state.room.version) && latestEventId <= state.lastEventId) return false;
  let liveEvents = [];
  if (baseline || !state.eventCursorReady) { state.lastEventId = latestEventId; state.eventCursorReady = true; }
  else { liveEvents = events.filter((event) => Number(event.id) > state.lastEventId); state.lastEventId = Math.max(state.lastEventId,latestEventId); }
  state.room = room; renderRoom(); liveEvents.forEach((event) => playTableEvent(event));
  return true;
}

async function loadRooms() { try { const data = await api('/api/texas/rooms'); state.rooms = data.rooms ?? []; renderRoomList(); } catch (error) { text('roomListStatus',error.message); } }
function renderUser() {
  if (!state.user) return;
  state.musicEnabled = state.user.musicEnabled ?? true; state.effectsEnabled = state.user.effectsEnabled ?? true; state.motionMode = state.user.motionMode ?? 'light';
  document.body.dataset.motion = state.motionMode; text('accountLabel',`${state.user.nickname} · ${money(state.user.beans)} 豆`); text('accountTitles',(state.user.titles ?? []).join(' · ')); $('refillButton').hidden = Number(state.user.beans) !== 0;
}
async function refreshUser() {
  try {
    state.user = (await api('/api/auth/me')).user; renderUser();
  } catch {}
}

function disconnectWs() { const socket = state.ws; state.ws = null; if (socket && socket.readyState < 2) { socket.__manual = true; socket.close(); } }
function connectWs() {
  if (!state.room) return; if (state.ws?.__roomId === state.room.id && state.ws.readyState < 2) return; disconnectWs();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; const roomId = state.room.id;
  const socket = new WebSocket(`${protocol}://${location.host}/ws?game=texas&roomId=${encodeURIComponent(roomId)}`); socket.__roomId = roomId; state.ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type:'sync', after:state.lastEventId }));
  socket.onmessage = (message) => { try { const data = JSON.parse(message.data); if (data.type === 'room_event' && data.game === 'texas') { const payload = data.event?.payload ?? {}; if (data.event?.eventType === 'tournament_player_moved' && payload.userId === state.user?.id && payload.toRoomId) { sessionStorage.setItem('texas.roomId',payload.toRoomId); disconnectWs(); state.room = { id:payload.toRoomId,version:-1 }; loadRoom().then(connectWs).catch(() => { location.href='/tournament.html'; }); } else loadRoom().catch(() => {}); } if (data.type === 'global_banner') showBanner(data.banner?.message); } catch {} };
  socket.onclose = () => { if (state.ws === socket) state.ws = null; if (!socket.__manual && state.room?.id === roomId) window.setTimeout(connectWs,1500); };
}

async function loadRoom() {
  if (!state.room) return; const id = state.room.id;
  try { const data = await api(`/api/texas/rooms/${id}`); if (state.room?.id !== id || Number(data.room.version) < Number(state.room.version)) return; applyRoomSnapshot(data.room); await refreshUser(); }
  catch (error) { showBanner(error.message); }
}

function startPolling() { clearInterval(state.poll); state.poll = setInterval(() => state.room ? loadRoom() : loadRooms(),3000); }
function showBanner(message) { if (!message) return; clearTimeout(state.bannerTimer); text('globalTicker',message); state.bannerTimer = setTimeout(() => text('globalTicker',''),4500); }

function openJoin(room = {}) {
  $('joinRoomId').value = room.id ?? ''; $('joinCodeInput').value = room.code ?? ''; $('joinBuyInInput').min = String(room.minBuyIn ?? 1); $('joinBuyInInput').max = String(room.maxBuyIn ?? 100000);
  $('joinBuyInInput').value = String(Math.min(1000,room.maxBuyIn ?? 1000)); $('joinDialog').showModal();
}

async function spectateRoom(roomId) { try { const data = await api(`/api/texas/rooms/${roomId}/spectate`,{ method:'POST', body:{ enabled:true } }); applyRoomSnapshot(data.room,{ baseline:true }); connectWs(); } catch (error) { showBanner(error.message); } }

async function submitAction(type, amount) {
  if (state.acting || !state.room) return; state.acting = true; renderActions();
  try {
    const player = me();
    const data = await api(`/api/texas/rooms/${state.room.id}/actions`,{ method:'POST', body:{ type, amount, handId:state.room.handId, version:state.room.version, actionSeq:Number(player?.actionSeq ?? 0) + 1, clientActionId:uid() } });
    applyRoomSnapshot(data.room); await refreshUser(); if (state.effectsEnabled) playTone(type === 'fold' ? 220 : 560,.08);
  } catch (error) { showBanner(error.message); await loadRoom(); }
  finally { state.acting = false; renderActions(); }
}

function openRaise() {
  const allowed = state.room?.allowedActions ?? {}; if (!allowed.actions?.includes('raise') && !allowed.actions?.includes('bet')) return;
  const input = $('raiseAmount'); input.min = String(allowed.minRaiseTo ?? state.room.bigBlind); input.max = String(allowed.maxRaiseTo ?? 0); input.value = String(allowed.minRaiseTo ?? state.room.bigBlind);
  text('raiseHint',`可加注到 ${money(input.min)} - ${money(input.max)}，当前下注 ${money(state.room.currentBet)}`); $('raiseDialog').showModal();
}

async function loadLeaderboard(kind) {
  state.leaderboardKind = kind; const data = await api(`/api/leaderboards?kind=${encodeURIComponent(kind)}`);
  document.querySelectorAll('[data-rank]').forEach((button) => button.classList.toggle('active',button.dataset.rank === kind));
  const entries = data.entries ?? []; const podium = $('leaderboardPodium'); podium.replaceChildren();
  entries.slice(0,3).forEach((entry,index) => {
    const card = document.createElement('div'); card.className = 'podium-card'; const rank = document.createElement('strong'); rank.className = 'podium-rank'; rank.textContent = `0${index + 1}`;
    const body = document.createElement('div'); const name = document.createElement('span'); name.className = 'podium-name'; name.textContent = entry.nickname;
    const beans = document.createElement('span'); beans.className = 'podium-beans'; beans.textContent = `${money(entry.beans)} 豆 · ${entry.title ?? ''}`; body.append(name,beans); card.append(rank,body); podium.append(card);
  });
  const list = $('leaderboardList'); list.replaceChildren();
  entries.forEach((entry) => {
    const row = document.createElement('div'); row.className = 'leader-row'; const identity = document.createElement('div'); identity.className = 'leader-identity';
    const rank = document.createElement('strong'); rank.className = 'leader-rank'; rank.textContent = entry.rank; const player = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = entry.nickname; const title = document.createElement('span'); title.className = 'leader-title'; title.textContent = (entry.titles ?? [entry.title]).filter(Boolean).join(' · ');
    player.append(name,title); identity.append(rank,player); const record = document.createElement('div'); record.className = 'leader-record'; record.textContent = `${entry.wins} 胜 / ${entry.losses} 负`;
    const beans = document.createElement('div'); beans.className = 'leader-beans'; beans.textContent = `${money(entry.beans)} 豆`; row.append(identity,record,beans); list.append(row);
  });
}

function showLeaderboard() { if (state.room) disconnectWs(); $('gameView').hidden = true; $('authView').hidden = true; $('leaderboardView').hidden = false; setActiveNav('leaderboard'); loadLeaderboard(state.leaderboardKind).catch((error) => showBanner(error.message)); }
function showGame(destination = state.room ? 'holdem' : 'lobby') {
  $('authView').hidden = true; $('gameView').hidden = false; $('leaderboardView').hidden = true; setActiveNav(destination);
  if (state.room) { renderRoom(); connectWs(); } else { renderLobby(); loadRooms(); } startPolling();
}

async function saveSettings(event) {
  event.preventDefault(); const body = { musicEnabled:$('musicToggle').checked, effectsEnabled:$('effectsToggle').checked, motionMode:$('motionSelect').value };
  try { const data = await api('/api/me/settings',{ method:'PATCH', body }); state.user = data.user; state.musicEnabled = body.musicEnabled; state.effectsEnabled = body.effectsEnabled; state.motionMode = body.motionMode; document.body.dataset.motion = body.motionMode; $('settingsDialog').close(); if (state.musicEnabled) startMusic(); else stopMusic(); showBanner('设置已保存'); }
  catch (error) { showBanner(error.message); }
}

let musicNodes = null;
function startMusic() {
  if (musicNodes || !state.musicEnabled) return; const AudioContext = window.AudioContext || window.webkitAudioContext; if (!AudioContext) return;
  const context = new AudioContext(); const gain = context.createGain(); gain.gain.value = .015; gain.connect(context.destination);
  const oscillators = [220,277.18].map((frequency) => { const oscillator = context.createOscillator(); oscillator.type = 'sine'; oscillator.frequency.value = frequency; oscillator.connect(gain); oscillator.start(); return oscillator; });
  musicNodes = { context,gain,oscillators };
}
function stopMusic() { if (!musicNodes) return; musicNodes.oscillators.forEach((oscillator) => oscillator.stop()); musicNodes.gain.disconnect(); musicNodes.context.close(); musicNodes = null; }
function playTone(frequency,duration) {
  if (!state.effectsEnabled) return; const AudioContext = window.AudioContext || window.webkitAudioContext; if (!AudioContext) return;
  const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(.04,context.currentTime); gain.gain.exponentialRampToValueAtTime(.001,context.currentTime + duration); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + duration);
}

async function restoreRoom() {
  try {
    const id = sessionStorage.getItem('texas.roomId'); if (!id) return; const room = (await api(`/api/texas/rooms/${id}`)).room;
    const present = room.players.some((player) => player.userId === state.user.id) || room.isSpectator; if (!present) throw new Error('已离开房间');
    applyRoomSnapshot(room,{ baseline:true }); connectWs();
  } catch { state.room = null; state.lastEventId = 0; state.eventCursorReady = false; try { sessionStorage.removeItem('texas.roomId'); } catch {} renderLobby(); }
}

function setAuthMode(mode) {
  state.authMode = mode; const login = mode === 'login'; $('nicknameField').hidden = login; text('authTitle',login ? '欢迎回来' : '创建账号');
  text('authSubtitle',login ? '登录您的账号以继续' : '注册邮箱账号，初始获得 100,000 豆'); text('authSubmit',login ? '登录' : '注册并进入');
  text('authModePrompt',login ? '还没有账号？' : '已有账号？'); text('authModeToggle',login ? '注册' : '登录'); $('passwordInput').autocomplete = login ? 'current-password' : 'new-password';
}

$('authForm').addEventListener('submit',async(event) => {
  event.preventDefault(); text('authError','');
  try { const body = { email:$('emailInput').value, password:$('passwordInput').value }; if (state.authMode === 'register') body.nickname = $('nicknameInput').value; state.user = (await api(`/api/auth/${state.authMode}`,{ method:'POST', body })).user; renderUser(); showGame('lobby'); await restoreRoom(); }
  catch (error) { text('authError',error.message); }
});
$('authModeToggle').addEventListener('click',() => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
$('refreshButton').addEventListener('click',loadRooms); $('createButton').addEventListener('click',() => $('createDialog').showModal()); $('joinCodeButton').addEventListener('click',() => openJoin());
$('createForm').addEventListener('submit',async(event) => {
  event.preventDefault(); text('createError','');
  try {
    const body = { smallBlind:Number($('smallBlindInput').value), bigBlind:Number($('bigBlindInput').value), buyIn:Number($('createBuyInInput').value), maxPlayers:Number($('maxPlayersInput').value), allowSpectators:$('allowSpectatorsInput').checked };
    const room = (await api('/api/texas/rooms',{ method:'POST', body })).room; $('createDialog').close(); applyRoomSnapshot(room,{ baseline:true });
    const entry = [...(room.recentEvents ?? [])].reverse().find((item) => item.eventType === 'texas_player_joined' && item.payload?.userId === state.user.id); if (entry) playTableEvent(entry);
    connectWs(); await refreshUser();
  } catch (error) { text('createError',error.message); }
});
$('joinForm').addEventListener('submit',async(event) => {
  event.preventDefault(); text('joinError','');
  try {
    const roomId = $('joinRoomId').value || $('joinCodeInput').value.trim(); const room = (await api(`/api/texas/rooms/${encodeURIComponent(roomId)}/join`,{ method:'POST', body:{ buyIn:Number($('joinBuyInInput').value) } })).room;
    $('joinDialog').close(); applyRoomSnapshot(room,{ baseline:true }); const entry = [...(room.recentEvents ?? [])].reverse().find((item) => item.eventType === 'texas_player_joined' && item.payload?.userId === state.user.id); if (entry) playTableEvent(entry);
    connectWs(); await refreshUser();
  } catch (error) { text('joinError',error.message); }
});
$('startButton').addEventListener('click',async() => { try { applyRoomSnapshot((await api(`/api/texas/rooms/${state.room.id}/start`,{ method:'POST', body:{} })).room); } catch (error) { showBanner(error.message); } });
$('leaveButton').addEventListener('click',async() => {
  if (!state.room) return; const id = state.room.id;
  if (state.room.tournament && !window.confirm('退出锦标赛将立即淘汰，且本周无法重新加入。确认退出？')) return;
  try { await api(`/api/texas/rooms/${id}/leave`,{ method:'POST', body:{} }); disconnectWs(); state.room = null; state.lastEventId = 0; state.eventCursorReady = false; try { sessionStorage.removeItem('texas.roomId'); } catch {} renderLobby(); await refreshUser(); await loadRooms(); }
  catch (error) { showBanner(error.message); }
});
$('rebuyButton').addEventListener('click',() => { $('rebuyAmountInput').max = String(Math.max(0,state.room.maxBuyIn - me().stack)); $('rebuyDialog').showModal(); });
$('rebuyForm').addEventListener('submit',async(event) => { event.preventDefault(); text('rebuyError',''); try { applyRoomSnapshot((await api(`/api/texas/rooms/${state.room.id}/rebuy`,{ method:'POST', body:{ amount:Number($('rebuyAmountInput').value) } })).room); $('rebuyDialog').close(); await refreshUser(); } catch (error) { text('rebuyError',error.message); } });
$('refillButton').addEventListener('click',() => $('refillDialog').showModal());
$('refillForm').addEventListener('submit',async(event) => {
  event.preventDefault(); text('refillError','');
  try { const confirmationText = $('refillConfirmation').value.trim(); if (confirmationText !== '黄总是大帅比') throw new Error('请输入“黄总是大帅比”'); const data = await api('/api/me/refill',{ method:'POST', body:{ confirmationText } }); $('refillDialog').close(); $('refillConfirmation').value = ''; await refreshUser(); data.banners?.forEach((banner) => showBanner(banner.message)); }
  catch (error) { text('refillError',error.message); }
});
$('roomSettingsButton').addEventListener('click',() => { $('roomAllowSpectators').checked = state.room.allowSpectators; $('roomSettingsDialog').showModal(); });
$('roomSettingsForm').addEventListener('submit',async(event) => { event.preventDefault(); try { applyRoomSnapshot((await api(`/api/texas/rooms/${state.room.id}/settings`,{ method:'POST', body:{ allowSpectators:$('roomAllowSpectators').checked } })).room); $('roomSettingsDialog').close(); } catch (error) { showBanner(error.message); } });
$('chatForm').addEventListener('submit',async(event) => { event.preventDefault(); const input = $('chatInput'); const value = input.value.trim(); if (!value || state.room?.isSpectator) return; try { await api(`/api/texas/rooms/${state.room.id}/messages`,{ method:'POST', body:{ text:value } }); input.value = ''; await loadRoom(); } catch (error) { showBanner(error.message); } });
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click',() => submitAction(button.dataset.action)));
$('raiseButton').addEventListener('click',openRaise);
$('raiseForm').addEventListener('submit',async(event) => { event.preventDefault(); const amount = Number($('raiseAmount').value); const allowed = state.room?.allowedActions ?? {}; if (!Number.isFinite(amount) || amount < Number(allowed.minRaiseTo) || amount > Number(allowed.maxRaiseTo)) { text('raiseError','请输入有效的加注额度'); return; } $('raiseDialog').close(); await submitAction($('raiseButton').dataset.action,amount); });
$('leaderboardButton').addEventListener('click',showLeaderboard); $('backButton').addEventListener('click',() => showGame('table'));
document.querySelectorAll('[data-rank]').forEach((button) => button.addEventListener('click',() => loadLeaderboard(button.dataset.rank)));
$('settingsButton').addEventListener('click',() => { $('musicToggle').checked = state.musicEnabled; $('effectsToggle').checked = state.effectsEnabled; $('motionSelect').value = state.motionMode; $('settingsDialog').showModal(); });
$('settingsForm').addEventListener('submit',saveSettings); document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click',() => $(button.dataset.close).close()));
document.querySelectorAll('button[data-nav]').forEach((button) => button.addEventListener('click',() => {
  const destination = button.dataset.nav; if (destination === 'leaderboard') return showLeaderboard(); if (destination === 'table') return showGame('table'); if (destination === 'lobby' || destination === 'rooms') return showGame(destination); showBanner(`${button.textContent}入口暂未开放`);
}));
window.addEventListener('resize',() => { if (state.room) renderSeats(); }); document.addEventListener('pointerdown',() => { if (state.musicEnabled) startMusic(); },{ once:true });

setAuthMode('login');
(async() => { try { state.user = (await api('/api/auth/me')).user; renderUser(); showGame('holdem'); await restoreRoom(); } catch { setAuthMode('login'); } })();
