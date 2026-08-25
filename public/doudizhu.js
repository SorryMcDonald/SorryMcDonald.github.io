const state={user:null,room:null,rooms:[],authMode:'login',poll:null,clock:null,selected:new Set(),globalWs:null,bannerQueue:[],bannerTimer:null,seenBanners:new Set(),muted:localStorage.getItem('doudizhu-muted')==='true',audio:null,lastTick:null,busy:false};

const $=(id)=>document.getElementById(id);

const STATUS={waiting:'等待开局',bidding:'叫抢地主',doubling:'选择加倍',playing:'游戏进行中',finished:'本局结束'};

const COMBOS={single:'单张',pair:'对子',triple:'三张','triple-single':'三带一','triple-pair':'三带二',straight:'顺子','pair-straight':'连对',airplane:'飞机','airplane-single':'飞机带单','airplane-pair':'飞机带对','four-two-single':'四带二','four-two-pair':'四带两对',bomb:'炸弹',rocket:'王炸'};

const SUITS={spade:'♠',heart:'♥',club:'♣',diamond:'♦'};

const RANKS={11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'};

const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({
  '&':'&amp'+String.fromCharCode(59),
  '<':'&lt'+String.fromCharCode(59),
  '>':'&gt'+String.fromCharCode(59),
  '"':'&quot'+String.fromCharCode(59),
  "'":'&#39'+String.fromCharCode(59)
}[char]));

async function api(path,options={}){const response=await fetch(path,{credentials:'include',headers:{'content-type':'application/json',...(options.headers??{})},...options,body:options.body===undefined?undefined:JSON.stringify(options.body)});
const data=await response.json().catch(()=>({}));
if(!response.ok){const message=response.status>=500?'服务器暂时不可用，请稍后重试':data.message??data.error??'请求失败';
throw new Error(message)}
return data}
function money(value){return Number(value??0).toLocaleString('zh-CN')}
function show(id,visible){$(id).hidden=!visible}
function setError(message=''){if($('roomError'))$('roomError').textContent=message;
if($('authError'))$('authError').textContent=message;
if($('lobbyError'))$('lobbyError').textContent=message}
function renderUser(){$('accountLabel').textContent=state.user?`${state.user.nickname} · ${money(state.user.beans)} 欢乐豆`:'未登录'}
function audioContext(){state.audio??=new(window.AudioContext||window.webkitAudioContext)();
if(state.audio.state==='suspended')void state.audio.resume();
return state.audio}
function tone(frequency,start,duration,gain=.035,type='sine'){if(state.muted)return;
try{const ctx=audioContext(),osc=ctx.createOscillator(),volume=ctx.createGain();
osc.type=type;
osc.frequency.setValueAtTime(frequency,ctx.currentTime+start);
volume.gain.setValueAtTime(.001,ctx.currentTime+start);
volume.gain.exponentialRampToValueAtTime(gain,ctx.currentTime+start+.015);
volume.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+start+duration);
osc.connect(volume).connect(ctx.destination);
osc.start(ctx.currentTime+start);
osc.stop(ctx.currentTime+start+duration+.02)}catch{}}
function playSound(name){if(name==='click')tone(620,0,.06,.025,'triangle');
if(name==='deal')[760,680,610].forEach((n,i)=>tone(n,i*.045,.08,.025,'triangle'));
if(name==='turn')[920,1160].forEach((n,i)=>tone(n,i*.07,.12,.035,'triangle'));
if(name==='tick')tone(720,0,.045,.018,'square');
if(name==='bomb')[120,80,55].forEach((n,i)=>tone(n,i*.035,.4,.1,'sawtooth'));
if(name==='win')[523,659,784,1047].forEach((n,i)=>tone(n,i*.1,.28,.055));
if(name==='lose')[392,330,262].forEach((n,i)=>tone(n,i*.12,.3,.045,'triangle'));
if(name==='error')[210,165].forEach((n,i)=>tone(n,i*.07,.13,.04,'square'))}
function syncSoundButtons(){for(const id of ['soundButton','soundRoomButton']){const button=$(id);
if(!button)continue;
button.textContent=state.muted?'🔇':'🔊';
button.title=state.muted?'开启音效':'关闭音效';
button.setAttribute('aria-label',button.title)}}
function toggleSound(){state.muted=!state.muted;
localStorage.setItem('doudizhu-muted',String(state.muted));
syncSoundButtons();
if(!state.muted)playSound('click')}
function showNextBanner(){const message=state.bannerQueue.shift();
if(!message){state.bannerTimer=null;
$('globalTicker').textContent='';
return}$('globalTicker').textContent=message;
state.bannerTimer=window.setTimeout(()=>{state.bannerTimer=null;
showNextBanner()},4500)}
function renderGlobalBanner(data){if(data?.type!=='global_banner'||!data.banner?.message)return;
const key=String(data.banner.id??`${data.banner.message}:${data.banner.createdAt??''}`);
if(state.seenBanners.has(key))return;
state.seenBanners.add(key);
state.bannerQueue.push(data.banner.message);
if(!state.bannerTimer)showNextBanner()}
function connectGlobalWs(){if(!state.user||state.globalWs&&[0,1].includes(state.globalWs.readyState))return;
const protocol=location.protocol==='https:'?'wss':'ws';
const socket=new WebSocket(`${protocol}://${location.host}/ws`);
state.globalWs=socket;
socket.onopen=()=>socket.send(JSON.stringify({type:'subscribe_global'}));
socket.onmessage=(message)=>{try{renderGlobalBanner(JSON.parse(message.data))}catch{}};
socket.onclose=()=>{if(state.globalWs===socket)state.globalWs=null;
if(state.user)window.setTimeout(connectGlobalWs,2000)}}
function renderRooms(){const node=$('rooms');
node.replaceChildren();
if(!state.rooms.length){node.innerHTML='<div class="empty-rooms">当前没有等待中的牌桌<br><small>创建一个房间，邀请好友开局</small></div>';
return}for(const room of state.rooms){const card=document.createElement('article');
card.className='room-card';
const available=room.isMember||['waiting','finished'].includes(room.status)&&room.playerCount<room.maxPlayers;
card.innerHTML=`<div class="room-card-head"><h3>房间 ${escapeHtml(room.code)}</h3><span class="room-status">${escapeHtml(STATUS[room.status]??room.status)}</span></div><p>${room.playerCount}/${room.maxPlayers} 人 · 底分 ${money(room.baseScore)} · 经典玩法</p>`;
const button=document.createElement('button');
button.className='gold-button';
button.textContent=room.isMember?'返回牌桌':available?'加入牌桌':'暂不可加入';
button.disabled=!available;
button.onclick=()=>enterRoom(room.id);
card.append(button);
node.append(card)}}
async function loadRooms(){try{const data=await api('/api/doudizhu/rooms');
state.rooms=data.rooms??[];
if(data.currentRoom){applyRoom(data.currentRoom,{initial:true});
return}
renderRooms();
setError()}catch(error){$('lobbyError').textContent=error.message}}
async function enterRoom(roomId){try{playSound('click');
const data=await api(`/api/doudizhu/rooms/${roomId}/join`,{method:'POST',body:{}});
applyRoom(data.room)}catch(error){setError(error.message);
playSound('error')}}
function currentPlayer(){return state.room?.players.find((player)=>player.userId===state.user?.id)}
function playerBySeat(seat){return state.room?.players.find((player)=>player.seat===seat)}
function effect(label){const layer=$('effectLayer');
layer.querySelector('strong').textContent=label;
layer.classList.remove('active');
void layer.offsetWidth;
layer.classList.add('active')}
function applyRoom(room,{initial=false}={}){const previous=state.room;
const sameRoom=previous?.id===room.id;
const previousRound=previous?.game?.roundId;
const previousTurn=previous?.game?.currentSeat;
const previousPlay=previous?.game?.lastPlay?.id;
const previousStatus=previous?.status;
state.room=room;
if(!sameRoom||previousRound!==room.game?.roundId)state.selected.clear();
else{const ids=new Set(room.game?.myHand?.map((card)=>card.id)??[]);
state.selected=new Set([...state.selected].filter((id)=>ids.has(id)))}show('authView',false);
show('lobbyView',false);
show('roomView',true);
renderRoom();
startPolling();
if(initial||!previous)return;
if(previousRound!==room.game?.roundId&&room.game){$('table').classList.add('dealing');
window.setTimeout(()=>$('table').classList.remove('dealing'),700);
playSound('deal')}if(previousTurn!==room.game?.currentSeat&&room.game?.currentSeat===currentPlayer()?.seat){playSound('turn');
effect('轮到你了')}if(previousPlay!==room.game?.lastPlay?.id&&room.game?.lastPlay){const type=room.game.lastPlay.combo?.type;
if(type==='bomb'||type==='rocket'){$('table').classList.add('shake');
window.setTimeout(()=>$('table').classList.remove('shake'),500);
effect(type==='rocket'?'王炸！':'炸弹！');
playSound('bomb')}else playSound('click')}if(previousStatus!=='finished'&&room.status==='finished'){const won=room.game?.result?.winner===currentPlayer()?.role;
effect(won?'胜利':'再接再厉');
playSound(won?'win':'lose')}}
async function refreshRoom(){if(!state.room)return;
try{const data=await api(`/api/doudizhu/rooms/${state.room.id}`);
applyRoom(data.room)}catch(error){setError(error.message)}}
function cardNode(card,small=false){const button=document.createElement(small?'span':'button');
button.className=`card${small?' small':''}${['heart','diamond'].includes(card.suit)||card.rank===17?' red':''}${card.suit==='joker'?' joker':''}`;
if(!small)button.type='button';
const rank=RANKS[card.rank]??card.rank;
const suit=SUITS[card.suit]??(card.rank===16?'♚':card.rank===17?'♛':'');
button.innerHTML=`<span class="card-rank">${rank}</span><span class="card-suit">${suit}</span><span class="card-center">${suit}</span>`;
button.setAttribute('aria-label',`${rank}${suit}`);
return button}
function cardStrip(cards,className='played-cards'){const strip=document.createElement('div');
strip.className=className;
(cards??[]).forEach((card)=>strip.append(cardNode(card,true)));
return strip}
function actionButton(label,action,value,className=''){const button=document.createElement('button');
button.textContent=label;
button.className=className;
button.disabled=state.busy;
button.onclick=()=>sendAction(action,typeof value==='function'?value():value);
return button}
function countdownMarkup(deadline){return deadline?`<span class="countdown" data-deadline="${Number(deadline)}">--</span>`:''}
function renderPlayers(room,me,game){const node=$('players');
node.replaceChildren();
for(const player of room.players){const card=document.createElement('article');
card.className=`player-card ${player.userId===state.user.id?'me':''} ${game?.currentSeat===player.seat?'current':''}`;
const role=player.role==='landlord'?'地主':player.role==='farmer'?'农民':'';
card.innerHTML=`<div class="player-avatar ${player.role??''}">${escapeHtml(player.nickname.slice(0,1))}</div><div class="player-copy"><strong>${escapeHtml(player.nickname)}${player.userId===state.user.id?' · 你':''}</strong><small>${money(player.beans)} 欢乐豆</small></div>${role?`<span class="role-tag">${role}</span>`:''}${player.ready?'<span class="ready-tag">已准备</span>':''}${player.controlledByBot?'<span class="bot-tag">托管</span>':''}${player.double>1?`<span class="double-tag">×${player.double}</span>`:''}${player.cardCount>0?`<span class="card-count">${player.cardCount}</span>`:''}`;
node.append(card)}}
function renderBottomCards(game){const node=$('bottomCards');
const cards=game?.bottomRevealed?game.bottomCards??[]:[];
node.hidden=!cards.length;
const target=node.querySelector('div');
target.replaceChildren();
cards.forEach((card)=>target.append(cardNode(card,true)))}
function phaseIntro(icon,title,copy,deadline=0){return `<div class="phase-card"><span class="phase-icon">${icon}</span><h2>${title}</h2><p>${copy}</p>${countdownMarkup(deadline)}</div>`}
function renderRoom(){const room=state.room;
if(!room)return;
const me=currentPlayer(),game=room.game,panel=$('gamePanel');
$('roomCode').textContent=room.code;
$('baseScoreLabel').textContent=money(room.baseScore);
$('multiplierLabel').textContent=`×${game?.publicMultiplier??1}`;
$('roundLabel').textContent=game?.roundId?'进行中':'等待';
$('phaseLabel').textContent=STATUS[room.status]??room.status;
$('phaseDot').classList.toggle('active',room.status!=='waiting'&&room.status!=='finished');
renderPlayers(room,me,game);
renderBottomCards(game);
panel.replaceChildren();
if(!game){panel.innerHTML=phaseIntro('♠','等待玩家准备',`${room.players.filter((p)=>p.ready).length}/${room.players.length} 位玩家已准备`);
const actions=document.createElement('div');
actions.className='actions';
actions.append(actionButton(me?.ready?'取消准备':'准备','ready',!me?.ready,'primary'));
if(room.hostUserId===state.user.id)actions.append(actionButton('开始游戏','start',undefined,'primary'));
panel.append(actions)}else if(room.status==='bidding'){const actor=playerBySeat(game.currentSeat);
panel.innerHTML=phaseIntro('♛',game.bid?.mode==='rob'?'抢地主':'叫地主',`正在等待 ${escapeHtml(actor?.nickname??'玩家')} 选择`,game.deadlineAt);
if(game.currentSeat===me?.seat){const actions=document.createElement('div');
actions.className='actions';
actions.append(actionButton(game.bid?.mode==='rob'?'抢地主':'叫地主','bid',true,'primary'),actionButton(game.bid?.mode==='rob'?'不抢':'不叫','bid',false,'danger-choice'));
panel.append(actions)}}else if(room.status==='doubling'){panel.innerHTML=phaseIntro('×2','选择加倍','加倍将直接影响本局结算',game.deadlineAt);
if(game.pendingDoubleSeats.includes(me?.seat)){const actions=document.createElement('div');
actions.className='actions';
[1,2,4].forEach((value)=>actions.append(actionButton(value===1?'不加倍':`${value} 倍`,'double',value,value===2?'primary':'')));
panel.append(actions)}}else if(room.status==='playing'){const myTurn=game.currentSeat===me?.seat;
const actor=playerBySeat(game.currentSeat);
if(game.lastPlay){panel.innerHTML=`<span class="last-play-label">${escapeHtml(game.lastPlay.nickname)} · ${COMBOS[game.lastPlay.combo?.type]??'出牌'}</span>`;
panel.append(cardStrip(game.lastPlay.cards))}else panel.innerHTML='<span class="pass-text">自由出牌</span>';
const line=document.createElement('div');
line.className='turn-line';
line.innerHTML=`<span>${myTurn?'请出牌':`等待 ${escapeHtml(actor?.nickname??'玩家')}`}</span>${countdownMarkup(game.deadlineAt)}`;
panel.append(line);
if(myTurn){const actions=document.createElement('div');
actions.className='actions';
actions.append(actionButton('提示','hint'),actionButton('不出','pass',undefined,'danger-choice'),actionButton('出牌','play',()=>[...state.selected],'primary'));
if(!game.lastPlay||game.trickLeaderId===me?.id)actions.children[1].disabled=true;
actions.children[2].disabled=!state.selected.size;
panel.append(actions)}}else if(room.status==='finished'){const result=game.result,won=result?.winner===me?.role;
panel.innerHTML=`<div class="result-panel"><small>本局结算</small><h2>${won?'恭喜获胜':result?.winner==='landlord'?'地主胜利':'农民胜利'}${result?.spring==='spring'?' · 春天':result?.spring==='anti-spring'?' · 反春':''}</h2><div class="result-list"></div></div>`;
const list=panel.querySelector('.result-list');
for(const item of result?.items??[]){const row=document.createElement('div');
row.className='result-item';
row.innerHTML=`<span>${escapeHtml(item.nickname)}</span><b class="${item.delta>=0?'gain':'loss'}">${item.delta>=0?'+':''}${money(item.delta)}</b><small>余额 ${money(item.balance)}</small>`;
list.append(row)}panel.querySelector('.result-panel').append(actionButton(me?.ready?'取消准备':'再来一局','ready',!me?.ready,'primary'))}renderHand();
renderUser();
updateCountdown()}
function renderHand(){const node=$('hand');
node.replaceChildren();
const cards=currentPlayer()&&state.room?.game?.myHand?state.room.game.myHand:[];
for(const card of cards){const button=cardNode(card);
button.classList.toggle('selected',state.selected.has(card.id));
button.setAttribute('aria-pressed',String(state.selected.has(card.id)));
button.onclick=()=>{playSound('click');
state.selected.has(card.id)?state.selected.delete(card.id):state.selected.add(card.id);
renderRoom()};
node.append(button)}$('selectionHint').textContent=state.selected.size?`已选择 ${state.selected.size} 张牌`:''}
function suggestPlay(){const hand=state.room?.game?.myHand??[],last=state.room?.game?.lastPlay?.combo;
const groups=new Map();
for(const card of hand){if(!groups.has(card.rank))groups.set(card.rank,[]);
groups.get(card.rank).push(card)}const ordered=[...groups.entries()].sort(([a],[b])=>a-b);
let cards=[];
if(!last)cards=hand.slice(0,1);
else if(['single','pair','triple','bomb'].includes(last.type)){const need={single:1,pair:2,triple:3,bomb:4}[last.type];
cards=ordered.find(([rank,list])=>rank>last.rank&&list.length>=need)?.[1].slice(0,need)??[]}if(!cards.length&&last?.type!=='rocket'&&last?.type!=='bomb')cards=ordered.find(([,list])=>list.length===4)?.[1]??[];
if(!cards.length&&last?.type!=='rocket'){const jokers=hand.filter((card)=>card.rank>=16);
if(jokers.length===2)cards=jokers}state.selected=new Set(cards.map((card)=>card.id));
$('selectionHint').textContent=cards.length?'已为你选出一手牌':'暂无可用提示，请尝试组合或不出';
renderRoom()}
async function sendAction(action,value){if(!state.room||state.busy)return;
if(action==='hint'){suggestPlay();
return}if(action==='play'&&!value?.length){$('selectionHint').textContent='请先选择要出的牌';
playSound('error');
return}state.busy=true;
setError();
playSound('click');
try{const body={action,version:state.room.version};
if(action==='ready')body.ready=Boolean(value);
if(action==='bid')body.choice=value;
if(action==='double')body.value=value;
if(action==='play')body.cardIds=value;
const data=await api(`/api/doudizhu/rooms/${state.room.id}/actions`,{method:'POST',body});
state.busy=false;
applyRoom(data.room)}catch(error){state.busy=false;
setError(error.message);
playSound('error');
await refreshRoom()}}
function updateCountdown(){document.querySelectorAll('[data-deadline]').forEach((node)=>{const seconds=Math.max(0,Math.ceil((Number(node.dataset.deadline)-Date.now())/1000));
node.textContent=seconds;
node.classList.toggle('urgent',seconds<=5);
if(seconds<=5&&seconds>0&&state.lastTick!==`${node.dataset.deadline}:${seconds}`){state.lastTick=`${node.dataset.deadline}:${seconds}`;
playSound('tick')}})}
function startPolling(){clearInterval(state.poll);
state.poll=setInterval(()=>state.room?refreshRoom():loadRooms(),1200);
if(!state.clock)state.clock=setInterval(updateCountdown,250)}
async function submitAuth(event){event.preventDefault();
setError();
const body={email:$('emailInput').value,password:$('passwordInput').value};
if(state.authMode==='register')body.nickname=$('nicknameInput').value;
try{const data=await api(`/api/auth/${state.authMode==='register'?'register':'login'}`,{method:'POST',body});
state.user=data.user;
renderUser();
connectGlobalWs();
show('authView',false);
show('lobbyView',true);
playSound('deal');
await loadRooms()}catch(error){$('authError').textContent=error.message;
playSound('error')}}
async function logout(){await api('/api/auth/logout',{method:'POST'}).catch(()=>{});
state.user=null;
state.room=null;
clearInterval(state.poll);
show('roomView',false);
show('lobbyView',false);
show('authView',true);
renderUser()}
$('authForm').addEventListener('submit',submitAuth);
$('authModeToggle').addEventListener('click',()=>{state.authMode=state.authMode==='login'?'register':'login';
$('nicknameField').hidden=state.authMode!=='register';
$('authTitle').textContent=state.authMode==='register'?'创建牌局账号':'欢迎回来';
$('authSubmit').textContent=state.authMode==='register'?'注册并进入':'登录';
$('authModeToggle').textContent=state.authMode==='register'?'返回登录':'注册新账号';
$('passwordInput').autocomplete=state.authMode==='register'?'new-password':'current-password'});

$('createButton').addEventListener('click',async()=>{if(state.busy)return;
state.busy=true;
$('createButton').disabled=true;
try{playSound('click');
const data=await api('/api/doudizhu/rooms',{method:'POST',body:{maxPlayers:Number($('maxPlayers').value),baseScore:Number($('baseScore').value)}});
applyRoom(data.room)}catch(error){$('lobbyError').textContent=error.message;
playSound('error')}finally{state.busy=false;
$('createButton').disabled=false}});
$('leaveButton').addEventListener('click',async()=>{if(state.busy)return;
state.busy=true;
$('leaveButton').disabled=true;
try{if(state.room)await api(`/api/doudizhu/rooms/${state.room.id}/leave`,{method:'POST',body:{}});
state.room=null;
state.selected.clear();
show('roomView',false);
show('lobbyView',true);
await loadRooms()}catch(error){setError(error.message);
playSound('error')}finally{state.busy=false;
$('leaveButton').disabled=false}});
$('logoutButton').addEventListener('click',logout);
$('refreshRoomsButton').addEventListener('click',()=>{playSound('click');
void loadRooms()});
$('soundButton').addEventListener('click',toggleSound);
$('soundRoomButton').addEventListener('click',toggleSound);
$('copyRoomButton').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.room?.code??'');
$('copyRoomButton').textContent='已复制';
window.setTimeout(()=>$('copyRoomButton').textContent='复制房号',1200);
playSound('click')}catch{setError('复制失败，请手动记录房号')}});

syncSoundButtons();
(async()=>{try{const data=await api('/api/auth/me');
state.user=data.user;
renderUser();
connectGlobalWs();
show('authView',false);
show('lobbyView',true);
await loadRooms()}catch{show('authView',true)}startPolling()})();
