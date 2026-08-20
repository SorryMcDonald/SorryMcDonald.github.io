const state = {
  user: null,
  room: null,
  rooms: [],
  authMode: 'login',
  leaderboardKind: 'wins',
  ws: null,
  musicEnabled: true,
  effectsEnabled: true,
  motionMode: 'light',
  feed: [],
  countdownTimer: null,
  countdownKey: null,
  dangerPlayedKey: null,
  countdownRefreshKey: null,
  refillPrompted: false,
  compareTimer: null
};

const $ = (id) => document.getElementById(id);
const authView = $('authView');
const tableView = $('tableView');
const leaderboardView = $('leaderboardView');
const CARD_RANKS = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CARD_SUITS = { S: '♠', H: '♥', C: '♣', D: '♦', '♠': '♠', '♥': '♥', '♣': '♣', '♦': '♦' };
const RED_CARD_SUITS = new Set(['♥', '♦']);
const ROOM_STATUS_LABELS = { waiting: '等待开局', betting: '下注中', comparing: '比牌中', settled: '本局已结算' };
const REFILL_REWARDS = new Map([
  ['黄总大帅逼', 1_000],
  ['我是菜逼', 10_000]
]);

function makeCard(card) {
  const node = document.createElement('span');
  node.className = 'card';
  if (!card) {
    node.classList.add('back');
    node.setAttribute('aria-label', '牌背');
    const frame = document.createElement('span');
    frame.className = 'card-back-frame';
    const mark = document.createElement('span');
    mark.className = 'card-back-mark';
    mark.textContent = '◆';
    frame.append(mark);
    node.append(frame);
    return node;
  }
  const rank = CARD_RANKS[Number(card.rank)] ?? String(card.rank ?? '');
  const suit = CARD_SUITS[card.suit] ?? String(card.suit ?? '');
  if (RED_CARD_SUITS.has(suit)) node.classList.add('red');
  node.dataset.rank = rank;
  node.setAttribute('aria-label', `${rank}${suit}`);
  const topIndex = document.createElement('span');
  topIndex.className='card-index card-index-top';
  const topRank = document.createElement('span');
  topRank.className = 'card-rank';
  topRank.textContent = rank;
  const topSuit = document.createElement('span');
  topSuit.className = 'card-suit';
  topSuit.textContent = suit;
  topIndex.append(topRank, topSuit);
  const pip = document.createElement('span');
  pip.className='card-pip';
  pip.textContent = suit;
  const bottomIndex = document.createElement('span');
  bottomIndex.className='card-index card-index-bottom';
  const bottomRank = document.createElement('span');
  bottomRank.className = 'card-rank';
  bottomRank.textContent = rank;
  const bottomSuit = document.createElement('span');
  bottomSuit.className = 'card-suit';
  bottomSuit.textContent = suit;
  bottomIndex.append(bottomRank, bottomSuit);
  node.append(topIndex, pip, bottomIndex);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: options.credentials ?? 'include',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}

function titleChip(title) {
  const chip = document.createElement('span');
  chip.className = `title-chip ${title === '穷乞丐' || title === '散财童子' ? 'loss-title' : ''}`;
  chip.textContent = title;
  return chip;
}

function applyUser(user) {
  state.user = user;
  state.musicEnabled = user.musicEnabled ?? true;
  state.effectsEnabled = user.effectsEnabled ?? true;
  state.motionMode = user.motionMode ?? 'light';
  document.body.dataset.motion = state.motionMode;
  renderAccount();
}

function renderAccount() {
  if (!state.user) return;
  const tournamentRoom = Boolean(state.room?.tournament);
  const restoringRoom = !state.room && Boolean(sessionStorage.getItem('zhajinhua.roomId'));
  $('accountLabel').textContent = `${state.user.nickname} · ${Number(state.user.beans || 0).toLocaleString()} 豆`;
  $('accountTitles').replaceChildren(...(state.user.titles ?? []).map(titleChip));
  $('refillButton').hidden = tournamentRoom || Number(state.user.beans ?? 0) !== 0;
  if (Number(state.user.beans ?? 0) > 0) state.refillPrompted = false;
  if (!tournamentRoom && !restoringRoom && Number(state.user.beans ?? 0) === 0 && !state.refillPrompted && !$('refillDialog').open) {
    state.refillPrompted = true;
    $('refillDialog').showModal();
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const login = mode === 'login';
  $('authTitle').textContent = login ? '欢迎回来' : '创建账号';
  $('authSubtitle').textContent = login ? '登录您的账号以继续' : '注册后即可获得 100,000 豆';
  $('authSubmit').textContent = login ? '登录' : '注册并进入牌桌';
  $('nicknameField').hidden = login;
  $('authModePrompt').textContent = login ? '还没有账号？' : '已有账号？';
  $('authModeToggle').textContent = login ? '注册' : '登录';
  $('passwordInput').autocomplete = login ? 'current-password' : 'new-password';
}

async function submitAuth(event) {
  event.preventDefault();
  $('authError').textContent = '';
  try {
    const payload = { email: $('emailInput').value, password: $('passwordInput').value };
    if (state.authMode === 'register') payload.nickname = $('nicknameInput').value;
    const data = await api(`/api/auth/${state.authMode}`, { method: 'POST', body: payload });
    applyUser(data.user);
    showTable();
    await restoreRoom();
  } catch (error) {
    $('authError').textContent = error.message;
  }
}

function showTable() {
  authView.hidden = true;
  leaderboardView.hidden = true;
  tableView.hidden = false;
  setActiveNav(state.room ? 'zjh' : 'lobby');
  renderAccount();
  connectGlobalWs();
  if (state.room) {
    renderRoom();
    connectWs();
  } else {
    renderLobby();
    loadRoomList();
  }
}

function showLeaderboard() {
  tableView.hidden = true;
  authView.hidden = true;
  leaderboardView.hidden = false;
  setActiveNav('leaderboard');
  loadLeaderboard(state.leaderboardKind);
}

function showTableView() {
  leaderboardView.hidden = true;
  tableView.hidden = false;
  setActiveNav(state.room ? 'zjh' : 'lobby');
  if (state.room) renderRoom();
  else {
    renderLobby();
    loadRoomList();
  }
}

function setActiveNav(destination) {
  document.querySelectorAll('[data-nav]').forEach((item) => item.classList.toggle('active', item.dataset.nav === destination));
}

async function refreshUser() {
  const data = await api('/api/auth/me');
  applyUser(data.user);
}

async function loadRoom() {
  const roomId = state.room?.id;
  if (!roomId) return;
  const [roomData, userData] = await Promise.all([api(`/api/rooms/${roomId}`), api('/api/auth/me')]);
  if(!state.room||state.room.id!==roomId)return;
  const stillPresent = roomData.room.players.some((player) => player.userId === state.user.id) || roomData.room.isSpectator;
  if (!stillPresent) {
    disconnectRoomWs();
    state.room = null;
    try { sessionStorage.removeItem('zhajinhua.roomId'); } catch {}
    applyUser(userData.user);
    renderLobby();
    loadRoomList();
    return;
  }
  state.room = roomData.room;
  applyUser(userData.user);
  renderRoom();
}

function upperArcPositions(count) {
  const layouts = {
    1: [{ left: 50, top: 20 }],
    2: [{ left: 28, top: 22 }, { left: 72, top: 22 }],
    3: [{ left: 18, top: 34 }, { left: 50, top: 18 }, { left: 82, top: 34 }],
    4: [{ left: 13, top: 42 }, { left: 36, top: 21 }, { left: 64, top: 21 }, { left: 87, top: 42 }],
    5: [{ left: 11, top: 54 }, { left: 25, top: 20 }, { left: 50, top: 17 }, { left: 75, top: 20 }, { left: 89, top: 54 }]
  };
  return layouts[count] ?? [];
}

function projectSeats(players, userId) {
  const ordered = [...players].sort((left, right) => left.seat - right.seat);
  const selfIndex = ordered.findIndex((player) => player.userId === userId);
  if (selfIndex < 0) {
    const arc = upperArcPositions(ordered.length - 1);
    return ordered.map((player, index) => ({
      player,
      position: index === 0 ? { left: 50, top: 84 } : arc[index - 1] ?? { left: 50, top: 50 },
      self: false
    }));
  }
  const rotated = [...ordered.slice(selfIndex), ...ordered.slice(0, selfIndex)];
  const arc = upperArcPositions(rotated.length - 1);
  return rotated.map((player, index) => ({
    player,
    position: index === 0 ? { left: 50, top: 84 } : arc[index - 1],
    self: index === 0
  }));
}

function renderLobby() {
  setActiveNav('lobby');
  stopCountdown();
  $('roomLobby').hidden = false;
  $('tableLayout').hidden = true;
  $('roomCode').textContent = '房间大厅';
  $('roundStatus').textContent = '选择房间';
  $('createRoomButton').hidden = false;
  $('joinRoomButton').hidden = false;
  $('leaveRoomButton').hidden = true;
  $('startNextButton').hidden = true;
  $('observeButton').hidden = true;
  $('spectateButton').hidden = true;
  $('actionPanel').hidden = true;
  $('players').replaceChildren();
  $('potValue').textContent = '0';
  $('compareNotice').textContent = '';
  $('roleLabel').textContent = '';
}

function renderRoomList(rooms) {
  const list = $('roomList');
  list.replaceChildren();
  $('roomListStatus').textContent = rooms.length ? `当前共有 ${rooms.length} 个房间` : '暂无可加入房间，您可以创建一个新房间';
  for (const room of rooms) {
    const row = document.createElement('article');
    row.className = 'room-row';
    const primary = document.createElement('div');
    primary.className = 'room-primary';
    const code = document.createElement('strong');
    code.textContent = `房间 ${room.code}`;
    const host = document.createElement('span');
    host.textContent = `房主：${room.hostNickname}`;
    primary.append(code, host);
    const detail = document.createElement('div');
    detail.className = 'room-detail';
    detail.textContent = `${ROOM_STATUS_LABELS[room.status] || room.status} · ${room.playerCount}/${room.maxPlayers} 人${room.allowSpectators ? ' · 可观战' : ''}`;
    const join = document.createElement('button');
    join.className = 'ghost-button room-join-button';
    join.textContent = room.playerCount >= room.maxPlayers ? '已满' : '加入';
    join.disabled = room.playerCount >= room.maxPlayers;
    join.addEventListener('click', () => joinRoom(room.id));
    row.append(primary, detail, join);
    list.append(row);
  }
}

async function loadRoomList() {
  if (state.room) return;
  $('roomListStatus').textContent = '正在加载房间...';
  try {
    const data = await api('/api/rooms');
    state.rooms = Array.isArray(data.rooms) ? data.rooms : [];
    renderRoomList(state.rooms);
  } catch (error) {
    state.rooms = [];
    $('roomList').replaceChildren();
    $('roomListStatus').textContent = error.message;
  }
}

function localPlayer() {
  return state.room?.players.find((player) => player.userId === state.user?.id) ?? null;
}

function renderPlayer(projected) {
  const { player, position, self } = projected;
  const room = state.room;
  const seat = document.createElement('article');
  seat.className = 'player-seat';
  seat.dataset.userId = player.userId;
  seat.dataset.seat = String(player.seat);
  if (self) seat.classList.add('self');
  if (player.userId === room.dealerUserId) seat.classList.add('dealer');
  if (player.seat === room.currentTurn) seat.classList.add('current');
  if (player.folded) seat.classList.add('folded');
  seat.style.setProperty('--seat-left', `${position.left}%`);
  seat.style.setProperty('--seat-top', `${position.top}%`);

  const name = document.createElement('div');
  name.className = 'player-name';
  name.textContent = `${player.nickname}${player.userId === room.dealerUserId ? ' · 庄' : ''}`;
  const titles = document.createElement('div');
  titles.className = 'seat-titles';
  titles.replaceChildren(...(player.titles ?? []).map(titleChip));
  const meta = document.createElement('div');
  meta.className = 'player-meta';
  const settledBeans = player.settledBeans === null || player.settledBeans === undefined ? null : Number(player.settledBeans);
  meta.textContent = `${Number(player.totalContribution || 0).toLocaleString()} 豆${player.folded ? ' · 已弃牌' : ''}${player.allIn ? ' · 梭哈' : ''}${player.seen ? ' · 已看牌' : ''}${settledBeans === null ? '' : ` · 结算后 ${settledBeans.toLocaleString()} 豆`}`;
  const cards = document.createElement('div');
  cards.className = 'cards';
  const visibleCards = Array.isArray(player.cards) ? player.cards : null;
  const cardSlots = visibleCards ?? Array.from({ length: player.cardCount || 3 }, () => null);
  cardSlots.forEach((card) => cards.append(makeCard(card)));
  if (player.seat === room.currentTurn && room.status === 'betting') {
    const countdown = $('turnCountdown').content.firstElementChild.cloneNode(true);
    seat.append(countdown);
  }
  seat.append(name, titles, meta, cards);
  return seat;
}

function renderMessages() {
  const messages = state.room?.messages ?? [];
  const nodes = messages.map((message) => {
    const row = document.createElement('p');
    const author = document.createElement('strong');
    author.textContent = `${message.nickname}：`;
    const text = document.createElement('span');
    text.textContent = message.text;
    row.append(author, text);
    return row;
  });
  $('chatMessages').replaceChildren(...nodes);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

function renderActions() {
  const room = state.room;
  const player = localPlayer();
  const spectator = room.isSpectator || !player;
  const canAdvance = Boolean(!spectator && room.status === 'betting' && player.seat === room.currentTurn && !player.folded && !player.allIn);
  const multiplier = player?.seen ? 2 : 1;
  const callCost = Number(room.level || room.ante || 0) * multiplier;
  $('actionPanel').hidden = spectator || room.status !== 'betting';
  $('seeButton').hidden = spectator || room.status !== 'betting' || player.seen || player.folded;
  $('seeButton').disabled = spectator || player?.folded;
  $('revealButton').hidden = !player?.mayReveal || player?.revealed;
  $('actionCostLabel').textContent = spectator ? '观战只读' : `${player?.seen ? '明牌 2 倍' : '暗牌'} · 跟注 ${callCost.toLocaleString()} 豆`;
  for (const button of document.querySelectorAll('[data-action]')) button.disabled = !canAdvance;
  $('raiseButton').disabled = !canAdvance;
  $('compareButton').disabled = !canAdvance || room.players.filter((candidate) => candidate.userId !== state.user.id && !candidate.folded).length === 0;
  $('chatInput').disabled = spectator;
  $('chatSendButton').disabled = spectator;
  $('chatModeLabel').textContent = spectator ? '观战者只读' : '每秒最多 1 条';
  $('chatInput').placeholder = spectator ? '观战状态不能发言' : '说点什么';
}

function renderRoom() {
  const room = state.room;
  if (!room) {
    renderLobby();
    return;
  }
  setActiveNav('zjh');
  $('roomLobby').hidden = true;
  $('tableLayout').hidden = false;
  $('createRoomButton').hidden = true;
  $('joinRoomButton').hidden = true;
  $('leaveRoomButton').hidden = false;
  $('roomCode').textContent = room.tournament ? `锦标赛 · ${room.tournament.tableNumber} 桌` : room.code;
  $('roundStatus').textContent = ROOM_STATUS_LABELS[room.status] || room.status;
  $('potValue').textContent = Number(room.pot || 0).toLocaleString();
  const ownPlayer = room.players.find((player) => player.userId === state.user.id);
  $('beansLabel').textContent = room.tournament ? `${Number(ownPlayer?.tournamentChips || 0).toLocaleString()} 筹码` : `${Number(state.user.beans || 0).toLocaleString()} 豆`;
  $('bettingRoundLabel').textContent = String(Number(room.bettingRound || 0) + (room.status === 'betting' ? 1 : 0));
  $('roleLabel').textContent = room.isSpectator ? '观战视角 · 全局明牌' : room.dealerUserId === state.user.id ? '本局庄家' : '';
  $('startNextButton').hidden = !(room.status === 'waiting' || room.status === 'settled') || Boolean(room.dealerUserId && room.dealerUserId !== state.user.id);
  $('observeButton').hidden = Boolean(room.tournament) || room.hostUserId !== state.user.id;
  $('observeButton').textContent = room.allowSpectators ? '关闭观战' : '开启观战';
  $('spectateButton').hidden = Boolean(room.tournament) || !room.allowSpectators || room.isSpectator;
  $('refillButton').hidden = Boolean(room.tournament) || Number(state.user.beans ?? 0) !== 0;
  $('players').dataset.seatCount = String(room.players.length);
  $('players').replaceChildren(...projectSeats(room.players, state.user.id).map(renderPlayer));
  renderActions();
  renderMessages();
  startCountdown();
  try { sessionStorage.setItem('zhajinhua.roomId', room.id); } catch {}
}

function addFeed(text) {
  state.feed.unshift(text);
  $('roundFeed').replaceChildren(...state.feed.slice(0, 12).map((entry) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = entry;
    return paragraph;
  }));
}

function updateCountdown() {
  const room = state.room;
  const countdown = document.querySelector('.player-seat.current .turn-countdown');
  if (!room || room.status !== 'betting' || !room.turnDeadlineAt || !countdown) return;
  const milliseconds = new Date(room.turnDeadlineAt).getTime() - Date.now();
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  countdown.textContent = `${seconds}s`;
  countdown.classList.toggle('danger', seconds <= 10);
  const key = `${room.roundNumber}:${room.currentTurn}:${room.turnDeadlineAt}`;
  if (seconds <= 10 && seconds > 0 && state.dangerPlayedKey !== key) {
    state.dangerPlayedKey = key;
    playEffect('danger');
  }
  if (seconds === 0 && state.countdownRefreshKey !== key) {
    state.countdownRefreshKey = key;
    window.setTimeout(() => loadRoom().catch(() => {}), 350);
  }
}

function startCountdown() {
  const room = state.room;
  const key = room?.turnDeadlineAt ?? null;
  if (state.countdownKey !== key) {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.countdownKey = key;
    if (key) state.countdownTimer = window.setInterval(updateCountdown, 250);
  }
  updateCountdown();
}

function stopCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownKey = null;
}

function disconnectRoomWs() {
  const socket = state.ws;
  state.ws = null;
  if (socket && socket.readyState < 2) {
    socket.__manualClose = true;
    socket.close();
  }
}

function focusCompareSeats(attackerUserId, targetUserId) {
  for (const seat of document.querySelectorAll('.player-seat')) {
    const involved = seat.dataset.userId === attackerUserId || seat.dataset.userId === targetUserId;
    seat.classList.toggle('compare-focus', involved);
    seat.classList.toggle('compare-attacker', seat.dataset.userId === attackerUserId);
    seat.classList.toggle('compare-target', seat.dataset.userId === targetUserId);
  }
}

function playCompareEffect(result) {
  const message = `${result.winner} 比牌获胜，${result.loser} 出局`;
  $('compareNotice').textContent = message;
  if (state.motionMode === 'disabled') return;
  document.body.dataset.compareEffect = state.motionMode;
  focusCompareSeats(result.attackerUserId, result.targetUserId);
  const overlay = $('compareEffectOverlay');
  overlay.querySelector('span').textContent = `${result.winner} 胜`;
  overlay.classList.add('active');
  if (state.motionMode === 'cinematic') playEffect('compare');
  if (state.compareTimer) clearTimeout(state.compareTimer);
  state.compareTimer = window.setTimeout(() => {
    overlay.classList.remove('active');
    delete document.body.dataset.compareEffect;
    for (const seat of document.querySelectorAll('.player-seat')) seat.classList.remove('compare-focus', 'compare-attacker', 'compare-target');
  }, state.motionMode === 'cinematic' ? 1500 : 900);
}

function handleRoomEvent(event) {
  const payload = event.payload || {};
  if (event.eventType === 'tournament_player_moved' && payload.userId === state.user?.id && payload.toRoomId) {
    sessionStorage.setItem('zhajinhua.roomId', payload.toRoomId);
    disconnectRoomWs();
    state.room = { id:payload.toRoomId };
    loadRoom().then(connectWs).catch(() => { location.href = '/tournament.html'; });
    return;
  }
  if (event.eventType === 'compare_started') {
    const text = `${payload.attacker} 向 ${payload.target} 发起比牌，费用 ${payload.fee}`;
    $('compareNotice').textContent = text;
    addFeed(text);
    focusCompareSeats(payload.attackerUserId, payload.targetUserId);
    return;
  }
  if (event.eventType === 'compare_resolved') {
    addFeed(`${payload.winner} 比牌获胜，${payload.loser} 出局`);
    loadRoom().then(() => playCompareEffect(payload)).catch(() => {});
    return;
  }
  if (event.eventType === 'chat_message') {
    if (state.room && payload.message && !state.room.messages.some((message) => message.id === payload.message.id)) {
      state.room.messages.push(payload.message);
      state.room.messages = state.room.messages.slice(-20);
      renderMessages();
    }
    return;
  }
  if (event.eventType === 'round_settled') {
    addFeed('本局结算完成，全部牌面已公开');
    refreshUser();
  }
  if (event.eventType === 'player_action' && payload.action === 'timeout_fold') addFeed(`${payload.seat + 1} 号位超时弃牌`);
  loadRoom().catch(() => {});
}

function connectWs() {
  if (!state.room) return;
  if (state.ws?.__roomId === state.room.id && state.ws.readyState < 2) return;
  disconnectRoomWs();
  const roomId = state.room.id;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws?roomId=${encodeURIComponent(roomId)}`);
  socket.__roomId = roomId;
  state.ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe_global' }));
  socket.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.type === 'room_event') handleRoomEvent(data.event);
      else if (data.type === 'global_banner') renderGlobalBanner(data);
      else if (data.type === 'error') addFeed(data.error);
    } catch {}
  };
  socket.onclose = () => {
    if (state.ws === socket) state.ws = null;
    if (!socket.__manualClose && state.room?.id === roomId) window.setTimeout(connectWs, 1500);
  };
}

async function joinRoom(roomId) {
  if (!roomId || state.room) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: {} });
    state.room = data.room;
    renderRoom();
    connectWs();
  } catch (error) {
    $('roomListStatus').textContent = error.message;
  }
}

async function leaveCurrentRoom(){if(!state.room)return;if(state.room.tournament&&!window.confirm('退出锦标赛将立即淘汰，且本周无法重新加入。确认退出？'))return;const previousRoom=state.room;const roomId=previousRoom.id;disconnectRoomWs();state.room=null;try{await api(`/api/rooms/${roomId}/leave`,{method:'POST',body:{}});state.feed=[];try{sessionStorage.removeItem('zhajinhua.roomId');}catch{}$('roundFeed').replaceChildren();renderLobby();await refreshUser();await loadRoomList();}catch(error){state.room=previousRoom;renderRoom();connectWs();addFeed(error.message);}}

async function roomAction(action, extra = {}) {
  if (!state.room) return;
  try {
    const player = localPlayer();
    const payload = { action, ...extra };
    if (!['see', 'reveal'].includes(action)) payload.actionSeq = Number(player?.actionSeq || 0) + 1;
    const data = await api(`/api/rooms/${state.room.id}/actions`, { method: 'POST', body: payload });
    state.room = data.room;
    await refreshUser();
    renderRoom();
  } catch (error) {
    addFeed(error.message);
  }
}

function updateRaisePreview() {
  const player = localPlayer();
  const amount = Number($('raiseAmount').value);
  const multiplier = player?.seen ? 2 : 1;
  const charge = amount * multiplier;
  let error = '';
  if (!Number.isSafeInteger(amount) || amount <= Number(state.room?.level ?? 0)) error = `档位必须是大于 ${state.room?.level ?? 0} 的整数`;
  else if (charge > Number(state.user?.beans ?? 0)) error = '余额不足';
  $('raisePreview').textContent = Number.isFinite(charge) ? `实际扣豆：${charge.toLocaleString()}（${multiplier} 倍）` : '';
  $('raiseError').textContent = error;
  return error ? null : amount;
}

function openRaiseDialog() {
  const room = state.room;
  const player = localPlayer();
  if (!room || !player) return;
  const multiplier = player.seen ? 2 : 1;
  $('raiseMultiplier').textContent = `${player.seen ? '已看牌' : '未看牌'}，实际支付为所选档位的 ${multiplier} 倍。当前档位 ${room.level}。`;
  const presets = [1, 2, 5, 10].map((multiple) => ({ multiple, amount: Number(room.ante) * multiple }));
  $('raisePresets').replaceChildren(...presets.map(({ multiple, amount }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-button';
    button.textContent = `${multiple}x · ${amount}`;
    button.disabled = amount <= Number(room.level) || amount * multiplier > Number(state.user.beans);
    button.addEventListener('click', () => {
      $('raiseAmount').value = String(amount);
      updateRaisePreview();
    });
    return button;
  }));
  const firstLegal = presets.find(({ amount }) => amount > Number(room.level) && amount * multiplier <= Number(state.user.beans));
  $('raiseAmount').value = String(firstLegal?.amount ?? Number(room.level) + 1);
  updateRaisePreview();
  $('raiseDialog').showModal();
}

function openCompareDialog() {
  const room = state.room;
  const player = localPlayer();
  if (!room || !player) return;
  const fee = Number(room.level) * (player.seen ? 4 : 2);
  $('compareFee').textContent = `本次比牌费用 ${fee.toLocaleString()} 豆，胜负立即公布，牌面由双方自行决定是否亮出。`;
  const targets = room.players.filter((candidate) => candidate.userId !== state.user.id && !candidate.folded);
  $('compareTargets').replaceChildren(...targets.map((target) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'compare-target-button';
    const name = document.createElement('strong');
    name.textContent = target.nickname;
    const detail = document.createElement('span');
    detail.textContent = `${target.seat + 1} 号位${target.seen ? ' · 已看牌' : ' · 暗牌'}`;
    button.append(name, detail);
    button.addEventListener('click', async () => {
      $('compareDialog').close();
      await roomAction('compare', { targetSeat: target.seat });
    });
    return button;
  }));
  $('compareDialog').showModal();
}

async function sendChat(event) {
  event.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({type:'chat', text}));
  $('chatInput').value = '';
}

async function submitRefill(event) {
  event.preventDefault();
  $('refillError').textContent = '';
  const confirmationText = $('refillConfirmation').value.trim();
  if (!REFILL_REWARDS.has(confirmationText)) {
    $('refillError').textContent = '确认文字不正确';
    return;
  }
  try {
    const data = await api('/api/me/refill', { method: 'POST', body: { confirmationText } });
    applyUser(data.user);
    data.banners?.forEach((banner) => renderGlobalBanner({ type: 'global_banner', banner }));
    $('refillConfirmation').value = '';
    $('refillDialog').close();
    addFeed(`补豆成功，增加 ${Number(data.refillAmount ?? REFILL_REWARDS.get(confirmationText)).toLocaleString()} 豆`);
    if (state.room) await loadRoom();
  } catch (error) {
    $('refillError').textContent = error.message;
  }
}

async function loadLeaderboard(kind) {
  state.leaderboardKind = kind;
  const list = $('leaderboardList');
  const heading = document.querySelector('.leaderboard-head');
  if (heading) {
    const columns = heading.querySelectorAll('span');
    if (columns[1]) columns[1].textContent = kind === 'refills' ? '领取次数' : '对局';
    if (columns[2]) columns[2].textContent = kind === 'refills' ? '次数' : '余额';
  }
  document.querySelectorAll('.tab-button').forEach((button) => {
    const active = button.dataset.kind === kind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  let data;
  try {
    data = await api(`/api/leaderboards?kind=${encodeURIComponent(kind)}`);
  } catch (error) {
    $('leaderboardPodium')?.replaceChildren();
    const notice = document.createElement('p');
    notice.className = 'error-text';
    notice.textContent = error.message;
    list.replaceChildren(notice);
    addFeed(error.message);
    return;
  }
  renderLeaderboardPodium(data.entries);
  list.replaceChildren(...data.entries.map((entry) => {
    const row = document.createElement('article');
    row.className = 'leader-row';
    const identity = document.createElement('div');
    identity.className = 'leader-identity';
    const rank = document.createElement('span');
    rank.className = 'leader-rank';
    rank.textContent = String(entry.rank);
    const profile = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = entry.nickname;
    const titles = document.createElement('div');
    titles.className = 'leader-titles';
    titles.replaceChildren(...(entry.titles ?? []).map(titleChip));
    profile.append(name, titles);
    identity.append(rank, profile);
    const record = document.createElement('div');
    record.className = 'leader-record';
    record.textContent = kind === 'refills' ? `${Number(entry.refillCount ?? 0).toLocaleString()} 次` : `${entry.wins} 胜 / ${entry.losses} 负`;
    const beans = document.createElement('div');
    beans.className = 'leader-beans';
    beans.textContent = kind === 'refills' ? `${Number(entry.refillCount ?? 0).toLocaleString()} 次` : `${Number(entry.beans).toLocaleString()} 豆`;
    row.append(identity, record, beans);
    return row;
  }));
}

function renderLeaderboardPodium(entries) {
  const podium = $('leaderboardPodium');
  if (!podium) return;
  podium.replaceChildren(...(entries ?? []).slice(0, 3).map((entry, index) => {
    const card = document.createElement('article');
    card.className = 'podium-card';
    const rank = document.createElement('span');
    rank.className = 'podium-rank';
    rank.textContent = String(entry.rank ?? index + 1);
    const avatar = document.createElement('span');
    avatar.className = 'podium-avatar';
    avatar.textContent = String(entry.nickname ?? '?').slice(0, 1);
    const profile = document.createElement('div');
    const name = document.createElement('strong');
    name.className = 'podium-name';
    name.textContent = entry.nickname ?? '未命名玩家';
    const beans = document.createElement('span');
    beans.className = 'podium-beans';
    beans.textContent = state.leaderboardKind === 'refills' ? `${Number(entry.refillCount ?? 0).toLocaleString()} 次` : `${Number(entry.beans ?? 0).toLocaleString()} 豆`;
    profile.append(name, beans);
    card.append(rank, avatar, profile);
    return card;
  }));
}

async function saveSettings() {
  const previous = { musicEnabled: state.musicEnabled, effectsEnabled: state.effectsEnabled, motionMode: state.motionMode };
  const body = { musicEnabled: $('musicToggle').checked, effectsEnabled: $('effectsToggle').checked, motionMode: $('motionSelect').value };
  state.musicEnabled = body.musicEnabled;
  state.effectsEnabled = body.effectsEnabled;
  state.motionMode = body.motionMode;
  document.body.dataset.motion = body.motionMode;
  applyAudioSettings();
  try {
    const data = await api('/api/me/settings', { method: 'PATCH', body });
    applyUser(data.user);
  } catch (error) {
    state.musicEnabled = previous.musicEnabled;
    state.effectsEnabled = previous.effectsEnabled;
    state.motionMode = previous.motionMode;
    $('musicToggle').checked = previous.musicEnabled;
    $('effectsToggle').checked = previous.effectsEnabled;
    $('motionSelect').value = previous.motionMode;
    document.body.dataset.motion = previous.motionMode;
    applyAudioSettings();
    addFeed(error.message);
  }
}

async function restoreRoom() {
  try {
    const roomId = sessionStorage.getItem('zhajinhua.roomId');
    if (!roomId || !state.user) return;
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    const stillPresent = data.room.players.some((player) => player.userId === state.user.id) || data.room.isSpectator;
    if (!stillPresent) throw new Error('已离开房间');
    state.room = data.room;
    renderRoom();
    connectWs();
  } catch {
    state.room = null;
    disconnectRoomWs();
    try { sessionStorage.removeItem('zhajinhua.roomId'); } catch {}
    renderLobby();
    loadRoomList();
  }
}

async function restoreSession() {
  try {
    const data = await api('/api/auth/me');
    applyUser(data.user);
    showTable();
    await restoreRoom();
  } catch {}
}

let globalWs = null;
const globalBannerQueue = [];
const seenGlobalBanners = new Set();
let globalBannerTimer = null;

function showNextGlobalBanner() {
  const message = globalBannerQueue.shift();
  if (!message) {
    globalBannerTimer = null;
    return;
  }
  const ticker = document.createElement('span');
  ticker.textContent = message;
  $('globalTicker').replaceChildren(ticker);
  globalBannerTimer = window.setTimeout(showNextGlobalBanner, 3500);
}

function renderGlobalBanner(data) {
  if (data?.type !== 'global_banner' || !data.banner?.message) return;
  const key = String(data.banner.id ?? `${data.banner.queueName || 'global'}:${data.banner.message}:${data.banner.createdAt || ''}`);
  if (seenGlobalBanners.has(key)) return;
  seenGlobalBanners.add(key);
  globalBannerQueue.push(data.banner.message);
  if (!globalBannerTimer) showNextGlobalBanner();
}

function connectGlobalWs() {
  if (!state.user || globalWs && [0, 1].includes(globalWs.readyState)) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  globalWs = new WebSocket(`${protocol}://${location.host}/ws`);
  globalWs.onmessage = (message) => {
    try { renderGlobalBanner(JSON.parse(message.data)); } catch {}
  };
  globalWs.onclose = () => {
    globalWs = null;
    if (state.user) window.setTimeout(connectGlobalWs, 2000);
  };
}

let audioContext = null;
let musicNodes = null;

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  audioContext = new AudioContextClass();
  return audioContext;
}

function stopBackgroundMusic() {
  if (!musicNodes) return;
  for (const oscillator of musicNodes.oscillators) oscillator.stop();
  musicNodes.gain.disconnect();
  musicNodes = null;
}

function startBackgroundMusic() {
  if (!state.musicEnabled || musicNodes) return;
  const context = getAudioContext();
  if (!context) return;
  context.resume?.().catch?.(() => {});
  const gain = context.createGain();
  gain.gain.value = 0.012;
  gain.connect(context.destination);
  const oscillators = [164.81, 220].map((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = index ? 'sine' : 'triangle';
    oscillator.frequency.value = frequency;
    oscillator.detune.value = index ? 3 : -3;
    oscillator.connect(gain);
    oscillator.start();
    return oscillator;
  });
  musicNodes = { gain, oscillators };
}

function playEffect(kind = 'click') {
  if (!state.effectsEnabled) return;
  const context = getAudioContext();
  if (!context) return;
  context.resume?.().catch?.(() => {});
  const frequencies = { compare: 660, all_in: 520, fold: 180, danger: 880, reveal: 740, click: 420 };
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = kind === 'compare' ? 'sawtooth' : 'sine';
  oscillator.frequency.value = frequencies[kind] ?? frequencies.click;
  gain.gain.setValueAtTime(0.04, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.13);
}

function applyAudioSettings() {
  if (state.musicEnabled) startBackgroundMusic();
  else stopBackgroundMusic();
}

$('authForm').addEventListener('submit', submitAuth);
$('authModeToggle').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
$('backToTable').addEventListener('click', showTableView);
$('createRoomButton').addEventListener('click', async () => {
  if (state.room) return;
  try {
    const data = await api('/api/rooms', { method: 'POST', body: {} });
    state.room = data.room;
    renderRoom();
    connectWs();
  } catch (error) {
    $('roomListStatus').textContent = error.message;
  }
});
$('joinRoomButton').addEventListener('click', () => {
  const code = prompt('输入房间号');
  if (code) joinRoom(code.trim());
});
$('leaveRoomButton').addEventListener('click', leaveCurrentRoom);
$('refreshRoomsButton').addEventListener('click', loadRoomList);
$('startNextButton').addEventListener('click', async () => {
  try {
    const data = await api(`/api/rooms/${state.room.id}/start-next`, { method: 'POST', body: {} });
    state.room = data.room;
    await refreshUser();
    renderRoom();
  } catch (error) {
    addFeed(error.message);
  }
});
$('observeButton').addEventListener('click', async () => {
  try {
    const data = await api(`/api/rooms/${state.room.id}/observe`, { method: 'POST', body: { enabled: !state.room.allowSpectators } });
    state.room = data.room;
    renderRoom();
  } catch (error) {
    addFeed(error.message);
  }
});
$('spectateButton').addEventListener('click', async () => {
  try {
    const data = await api(`/api/rooms/${state.room.id}/spectate`, { method: 'POST', body: { enabled: true } });
    state.room = data.room;
    renderRoom();
    connectWs();
  } catch (error) {
    addFeed(error.message);
  }
});
$('seeButton').addEventListener('click', () => roomAction('see'));
$('revealButton').addEventListener('click', () => roomAction('reveal'));
$('raiseButton').addEventListener('click', openRaiseDialog);
$('compareButton').addEventListener('click', openCompareDialog);
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => roomAction(button.dataset.action)));
$('raiseAmount').addEventListener('input', updateRaisePreview);
$('raiseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = updateRaisePreview();
  if (amount === null) return;
  $('raiseDialog').close();
  await roomAction('raise', { amount });
});
$('chatForm').addEventListener('submit', sendChat);
$('refillButton').addEventListener('click', () => $('refillDialog').showModal());
$('refillForm').addEventListener('submit', submitRefill);
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => loadLeaderboard(button.dataset.kind)));
$('settingsButton').addEventListener('click', () => {
  $('musicToggle').checked = state.musicEnabled;
  $('effectsToggle').checked = state.effectsEnabled;
  $('motionSelect').value = state.motionMode;
  $('settingsDialog').showModal();
});
$('musicToggle').addEventListener('change', saveSettings);
$('effectsToggle').addEventListener('change', saveSettings);
$('motionSelect').addEventListener('change', saveSettings);
document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => {
  const destination = button.dataset.nav;
  if (destination === 'leaderboard') {
    showLeaderboard();
    return;
  }
  if (destination === 'table' || destination === 'lobby' || destination === 'rooms' || destination === 'zjh') {
    showTableView();
    setActiveNav(destination);
    if (destination !== 'table' && destination !== 'zjh' && !state.room) {
      renderLobby();
      loadRoomList();
    }
    return;
  }
  $('globalTicker').textContent = `${button.textContent}入口暂未开放，当前仅支持炸金花虚拟娱乐`;
}));
document.addEventListener('click', (event) => {
  startBackgroundMusic();
  const button = event.target.closest?.('button');
  if (button && !button.disabled) playEffect(button.dataset.action || 'click');
});

setAuthMode('login');
restoreSession();
