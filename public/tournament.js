const $ = (id) => document.getElementById(id);
const state = { user:null, tournament:null, permanentTournament:null, serverOffset:0, timer:null };

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

function trackDescription(track) {
  if (track.variant === 'laizi') return '6 人桌 · 20 万虚拟筹码 · 底注/最低加注 1000';
  if (track.variant === 'ghost') return '9 人桌 · 10-A 双牌组 · 8 张王 · 最低加注 1000';
  if (track.variant === 'wild') return '9 人桌 · 每人每手 1 张技能 · 最低加注 1000';
  return track.game === 'texas' ? '9 人桌 · 100 / 200 盲注' : '6 人桌 · 10 豆底注';
}

function renderAccount() {
  $('accountName').textContent = state.user?.nickname ?? '未登录';
  $('accountBeans').textContent = `${formatNumber(state.user?.beans)} 豆`;
}

function enterRoom(gamePath, roomId) {
  sessionStorage.setItem(gamePath === '/dezhou.html' ? 'texas.roomId' : 'zhajinhua.roomId', roomId);
  location.href = gamePath;
}

async function submitEntry(game, input, button) {
  button.disabled = true;
  $('pageError').textContent = '';
  try {
    const data = await api(`/api/tournaments/${game}/enter`, { method:'POST', body:{ buyIn:Number(input.value) } });
    state.tournament = data.edition;
    state.user = (await api('/api/auth/me')).user;
    renderAccount();
    enterRoom(data.gamePath, data.roomId);
  } catch (error) {
    $('pageError').textContent = error.message;
    button.disabled = false;
    await loadTournament().catch(() => {});
  }
}

function renderTracks(tournament = state.tournament, listId = 'trackList') {
  const list = $(listId);
  list.replaceChildren();
  for (const track of tournament.tracks) {
    const card = document.createElement('section');
    card.className = 'track-card';
    card.dataset.game = track.game;
    const head = document.createElement('div');
    head.className = 'track-head';
    head.innerHTML = `<div><h2>${track.label}</h2><p>${trackDescription(track)}</p></div><span class="track-state">${statusText(track.status)}</span>`;
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
        button.addEventListener('click', () => enterRoom(track.gamePath, track.entry.roomId)); entry.append(button);
      }
      card.append(entry);
    } else {
      const form = document.createElement('form'); form.className = 'entry-form';
      const label = document.createElement('label'); label.textContent = '带入筹码';
      const input = document.createElement('input'); input.type = 'number'; input.min = String(track.minimumBuyIn); input.max = String(track.maximumBuyIn);
      const virtual = Boolean(track.virtualChips);
      input.value = String(virtual ? track.virtualChips : Math.max(track.minimumBuyIn, Math.min(10000, Number(state.user.beans ?? 0))));
      input.readOnly = virtual;
      const button = document.createElement('button'); button.className = 'primary-button'; button.type = 'submit'; button.textContent = '报名并入桌';
      button.disabled = track.status !== 'registration_open' || (!virtual && Number(state.user.beans ?? 0) < track.minimumBuyIn);
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
  const [weeklyData, permanentData] = await Promise.all([
    api('/api/tournaments/current'),
    api('/api/tournaments/current?kind=permanent')
  ]);
  state.tournament = weeklyData.tournament;
  state.permanentTournament = permanentData.tournament;
  state.serverOffset = Date.parse(state.tournament.serverTime) - Date.now();
  $('statusBadge').textContent = statusText(state.tournament.status);
  $('scheduleDate').textContent = `${state.tournament.key.replace('weekly:', '')} 12:00 开放 · 12:30 停止报名`;
  $('permanentStatusBadge').textContent = statusText(state.permanentTournament.status);
  $('permanentScheduleDate').textContent = `${state.permanentTournament.key.replace('permanent:', '')} 场 · 全天报名，上海时间每两小时开赛`;
  renderTracks(state.tournament, 'trackList'); renderTracks(state.permanentTournament, 'trackListPermanent'); updateCountdown();
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
