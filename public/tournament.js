const $ = (id) => document.getElementById(id);
const state = { user:null, tournament:null, serverOffset:0, timer:null };

async function api(path, options = {}) {
  const response = await fetch(path, {
    method:options.method ?? 'GET', credentials:'same-origin',
    headers:options.body ? { 'content-type':'application/json' } : undefined,
    body:options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? data.error ?? '请求失败');
  return data;
}

function formatNumber(value) { return Number(value ?? 0).toLocaleString('zh-CN'); }
function statusText(status) {
  return ({ scheduled:'等待开放', registration_open:'报名开放', running:'比赛进行中', completed:'已结束', cancelled:'已取消' })[status] ?? status;
}

function entryStatusText(status) {
  return ({ active:'参赛中', eliminated:'筹码归零，已淘汰', left:'已退出，不可重入', champion:'本周冠军' })[status] ?? status;
}

function renderAccount() {
  $('accountName').textContent = state.user?.nickname ?? '未登录';
  $('accountBeans').textContent = `${formatNumber(state.user?.beans)} 豆`;
}

function enterRoom(game, roomId) {
  sessionStorage.setItem(game === 'texas' ? 'texas.roomId' : 'zhajinhua.roomId', roomId);
  location.href = game === 'texas' ? '/dezhou.html' : '/';
}

async function submitEntry(game, input, button) {
  button.disabled = true;
  $('pageError').textContent = '';
  try {
    const data = await api(`/api/tournaments/${game}/enter`, { method:'POST', body:{ buyIn:Number(input.value) } });
    state.tournament = data.edition;
    state.user = (await api('/api/auth/me')).user;
    renderAccount();
    enterRoom(game, data.roomId);
  } catch (error) {
    $('pageError').textContent = error.message;
    button.disabled = false;
    await loadTournament().catch(() => {});
  }
}

function renderTracks() {
  const list = $('trackList');
  list.replaceChildren();
  for (const track of state.tournament.tracks) {
    const card = document.createElement('section');
    card.className = 'track-card';
    card.dataset.game = track.game;
    const head = document.createElement('div');
    head.className = 'track-head';
    head.innerHTML = `<div><h2>${track.label}</h2><p>${track.game === 'texas' ? '9 人桌 · 10 / 20 盲注' : '6 人桌 · 10 豆底注'}</p></div><span class="track-state">${statusText(track.status)}</span>`;
    const stats = document.createElement('div');
    stats.className = 'track-stats';
    stats.innerHTML = `<div><span>参赛玩家</span><strong>${track.playerCount}</strong></div><div><span>当前牌桌</span><strong>${track.tableCount}</strong></div><div><span>最低带入</span><strong>${formatNumber(track.minimumBuyIn)}</strong></div><div><span>最高带入</span><strong>${formatNumber(track.maximumBuyIn)}</strong></div>`;
    card.append(head, stats);

    if (track.champion) {
      const champion = document.createElement('div'); champion.className = 'champion';
      champion.innerHTML = `<strong>${track.champion.nickname}</strong><span>冠军结算 ${formatNumber(track.champion.prize)} 豆</span>`;
      card.append(champion);
    } else if (track.entry) {
      const entry = document.createElement('div'); entry.className = 'entry-state';
      entry.innerHTML = `<p><strong>${entryStatusText(track.entry.status)}</strong><br>带入 ${formatNumber(track.entry.buyIn)} · 当前筹码 ${formatNumber(track.entry.chips)}</p>`;
      if (track.entry.status === 'active') {
        const button = document.createElement('button'); button.className = 'primary-button'; button.type = 'button'; button.textContent = '进入牌桌';
        button.addEventListener('click', () => enterRoom(track.game, track.entry.roomId)); entry.append(button);
      }
      card.append(entry);
    } else {
      const form = document.createElement('form'); form.className = 'entry-form';
      const label = document.createElement('label'); label.textContent = '带入筹码';
      const input = document.createElement('input'); input.type = 'number'; input.min = String(track.minimumBuyIn); input.max = String(track.maximumBuyIn);
      input.value = String(Math.max(track.minimumBuyIn, Math.min(10000, Number(state.user.beans ?? 0))));
      const button = document.createElement('button'); button.className = 'primary-button'; button.type = 'submit'; button.textContent = '报名并入桌';
      button.disabled = track.status !== 'registration_open' || Number(state.user.beans ?? 0) < track.minimumBuyIn;
      form.append(label, input, button); form.addEventListener('submit', (event) => { event.preventDefault(); submitEntry(track.game, input, button); });
      card.append(form);
    }
    list.append(card);
  }
}

function updateCountdown() {
  if (!state.tournament) return;
  const now = Date.now() + state.serverOffset;
  const target = state.tournament.status === 'scheduled' ? Date.parse(state.tournament.opensAt) : Date.parse(state.tournament.registrationClosesAt);
  const remaining = Math.max(0, target - now);
  if (['running','completed'].includes(state.tournament.status)) {
    $('countdown').textContent = state.tournament.status === 'completed' ? '本周已结束' : '比赛进行中';
    return;
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  $('countdown').textContent = `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

async function loadTournament() {
  const data = await api('/api/tournaments/current');
  state.tournament = data.tournament;
  state.serverOffset = Date.parse(data.tournament.serverTime) - Date.now();
  $('statusBadge').textContent = statusText(data.tournament.status);
  $('scheduleDate').textContent = `${data.tournament.key} 12:00 开放 · 12:30 停止报名`;
  renderTracks(); updateCountdown();
}

$('refreshButton').addEventListener('click', async () => {
  $('refreshButton').disabled = true; $('pageError').textContent = '';
  try { await loadTournament(); } catch (error) { $('pageError').textContent = error.message; }
  finally { $('refreshButton').disabled = false; }
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    state.user = (await api('/api/auth/login', { method:'POST', body:{ email:$('emailInput').value, password:$('passwordInput').value } })).user;
    $('authView').hidden = true; $('tournamentView').hidden = false; renderAccount(); await loadTournament();
  } catch (error) { $('loginError').textContent = error.message; }
});

(async () => {
  try {
    state.user = (await api('/api/auth/me')).user;
    renderAccount(); $('tournamentView').hidden = false; await loadTournament();
  } catch {
    $('authView').hidden = false;
  }
  state.timer = window.setInterval(updateCountdown, 1000);
})();
