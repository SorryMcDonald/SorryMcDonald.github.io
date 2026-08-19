const state={ user:null,room:null,rooms:[],ws:null,poll:null,bannerTimer:null,authMode:'login',acting:false,lastEventId:0,leaderboardKind:'wins' };
const $=(id)=>document.getElementById(id);
const ACTIVE=new Set(['preflop','flop','turn','river']);
const STATUS={waiting:'等待开局',preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',showdown:'摊牌',settled:'本手已结算',closed:'已关闭'};
const RANK={2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
const SUIT={S:'♠',H:'♥',C:'♣',D:'♦'};

async function api(path,options={}) {
  const response=await fetch(path,{ credentials:'include',headers:{ 'content-type':'application/json',...(options.headers??{}) },...options,body:options.body===undefined?undefined:JSON.stringify(options.body) });
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error??data.message??'请求失败');
  return data;
}

function setText(id,value){$(id).textContent=String(value??'');}
function money(value){return Number(value??0).toLocaleString('zh-CN');}
function uid(){return crypto.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
function ownPlayer(){return state.room?.players.find((player)=>player.userId===state.user?.id);}

function cardNode(card,concealed=true) {
  const node=document.createElement('span'); node.className='poker-card';
  if (!card) { node.classList.add(concealed?'back':'empty'); node.setAttribute('aria-label',concealed?'牌背':'空牌位'); return node; }
  const suit=SUIT[card.suit]??card.suit; const rank=RANK[Number(card.rank)]??card.rank;
  if (['♥','♦'].includes(suit)) node.classList.add('red');
  node.setAttribute('aria-label',`${rank}${suit}`);
  const index=document.createElement('span'); index.className='card-index';
  const rankNode=document.createElement('span'); rankNode.textContent=rank;
  const suitNode=document.createElement('span'); suitNode.className='card-suit'; suitNode.textContent=suit;
  const center=document.createElement('span'); center.className='card-center'; center.textContent=suit;
  index.append(rankNode,suitNode); node.append(index,center); return node;
}

function seatPosition(index,total) {
  const angle=(90+index*360/Math.max(1,total))*Math.PI/180;
  const mobile=matchMedia('(max-width:620px)').matches;
  return { left:`${50+(mobile?38:42)*Math.cos(angle)}%`,top:`${50+(mobile?40:39)*Math.sin(angle)}%` };
}

function badge(text,className='') { const value=document.createElement('span');value.className=`badge ${className}`;value.textContent=text;return value; }
function lastStartEvent(room) { return [...(room.recentEvents??[])].reverse().find((event)=>event.eventType==='texas_hand_started'&&event.handId===room.handId); }

function renderSeats() {
  const room=state.room; const container=$('seats'); container.replaceChildren();
  const ordered=[...room.players].sort((left,right)=>left.userId===state.user.id?-1:right.userId===state.user.id?1:left.seat-right.seat);
  const start=lastStartEvent(room)?.payload??{};
  ordered.forEach((player,index)=>{
    const seat=document.createElement('article'); seat.className='player-seat'; Object.assign(seat.style,seatPosition(index,ordered.length));
    if (player.userId===state.user.id) seat.classList.add('me'); if(player.folded)seat.classList.add('folded'); if(player.seat===room.currentTurn)seat.classList.add('current');
    const name=document.createElement('div');name.className='player-name';name.textContent=`${player.nickname}${player.userId===state.user.id?'（你）':''}`;
    const stack=document.createElement('div');stack.className='player-stack';stack.textContent=`${money(player.stack)} 筹码${player.streetBet?` · 下注 ${money(player.streetBet)}`:''}`;
    const badges=document.createElement('div');badges.className='player-badges';
    if(player.seat===room.dealerSeat)badges.append(badge('D','dealer'));
    if(player.seat===start.smallBlindSeat)badges.append(badge('SB','blind'));
    if(player.seat===start.bigBlindSeat)badges.append(badge('BB','blind'));
    if(player.allIn)badges.append(badge('全押'));
    else if(player.folded)badges.append(badge('弃牌'));
    else if(player.waiting||!player.inHand)badges.append(badge('等待','waiting'));
    const cards=document.createElement('div');cards.className='hole-cards';
    const visible=Array.isArray(player.holeCards)?player.holeCards:null;
    const slots=visible??(player.inHand?[null,null]:[]); slots.forEach((card)=>cards.append(cardNode(card)));
    seat.append(name,stack,badges,cards);container.append(seat);
  });
}

function eventText(event) {
  const p=event.payload??{};
  if(event.eventType==='texas_player_joined')return `${p.nickname} 加入座位 ${Number(p.seat)+1}${p.waiting?'，等待下一手':''}`;
  if(event.eventType==='texas_player_left')return `座位 ${Number(p.seat)+1} 离开房间`;
  if(event.eventType==='texas_hand_started')return `第 ${p.handNumber} 手开始，庄家位于座位 ${Number(p.dealerSeat)+1}`;
  if(event.eventType==='texas_blinds_posted')return `小盲 ${money(p.smallBlind?.amount)}，大盲 ${money(p.bigBlind?.amount)}`;
  if(event.eventType==='texas_player_action'){
    const action={fold:'弃牌',check:'过牌',call:'跟注',bet:'下注',raise:'加注',all_in:'全押'}[p.action]??p.action;
    return `${p.nickname} ${action}${p.paid?` ${money(p.paid)}`:''}`;
  }
  if(event.eventType==='flop_dealt')return '发出翻牌';
  if(event.eventType==='turn_dealt')return '发出转牌';
  if(event.eventType==='river_dealt')return '发出河牌';
  if(event.eventType==='texas_player_rebuy')return `玩家补充 ${money(p.amount)} 筹码`;
  if(event.eventType==='texas_hand_settled'){
    const winners=(p.players??[]).filter((player)=>!player.folded&&player.payout>0).map((player)=>`${player.nickname} +${money(player.payout)}`);
    return `本手结算：${winners.join('，')||'无赢家'}`;
  }
  return '';
}

function renderFeed() {
  const feed=$('eventFeed');feed.replaceChildren();
  for(const event of [...(state.room?.recentEvents??[])].reverse()){
    const text=eventText(event);if(!text)continue;
    const line=document.createElement('p');line.textContent=text;
    const time=document.createElement('time');time.textContent=new Date(event.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});line.prepend(time);feed.append(line);
  }
}

function renderActions() {
  const room=state.room;const allowed=room.allowedActions??{actions:[]};const actions=new Set(allowed.actions??[]);
  const active=ACTIVE.has(room.status)&&!room.isSpectator&&ownPlayer()?.inHand;
  $('actionBar').hidden=!active;
  for(const [id,action] of [['foldButton','fold'],['checkButton','check'],['callButton','call'],['allInButton','all_in']])$(id).disabled=state.acting||!actions.has(action);
  setText('callButton',allowed.toCall?`跟注 ${money(allowed.toCall)}`:'跟注');
  const raiseType=actions.has('raise')?'raise':actions.has('bet')?'bet':null;
  const min=Math.max(0,Number(allowed.minRaiseTo??room.bigBlind));const max=Math.max(0,Number(allowed.maxRaiseTo??0));
  $('raiseSlider').min=String(Math.min(min,max));$('raiseSlider').max=String(max);$('raiseAmount').min=String(Math.min(min,max));$('raiseAmount').max=String(max);
  const current=Number($('raiseAmount').value);if(current<min||current>max){$('raiseAmount').value=String(Math.min(min,max));$('raiseSlider').value=$('raiseAmount').value;}
  $('raiseButton').dataset.action=raiseType??'';$('raiseButton').textContent=raiseType==='bet'?'下注':'加注';$('raiseButton').disabled=state.acting||!raiseType||max<min;
}

function renderRoom() {
  const room=state.room;if(!room){renderLobby();return;}
  $('lobbyView').hidden=true;$('tableView').hidden=false;$('createButton').hidden=true;$('joinCodeButton').hidden=true;$('leaveButton').hidden=false;
  $('startButton').hidden=!['waiting','settled'].includes(room.status)||room.hostUserId!==state.user.id;
  const me=ownPlayer();$('rebuyButton').hidden=!me||!['waiting','settled'].includes(room.status)||me.stack>=room.maxBuyIn;
  $('roomSettingsButton').hidden=room.hostUserId!==state.user.id;
  setText('roomTitle',`房间 ${room.code}`);setText('statusBadge',STATUS[room.status]??room.status);setText('potValue',money(room.pot));
  setText('blindText',`${money(room.smallBlind)} / ${money(room.bigBlind)}`);setText('handNumber',room.handNumber);setText('currentBet',money(room.currentBet));setText('minimumRaise',money(room.minRaise));
  const current=room.players.find((player)=>player.seat===room.currentTurn);
  setText('turnText',current?current.userId===state.user.id?'轮到你行动':`轮到 ${current.nickname}`:['waiting','settled'].includes(room.status)?'等待房主开始下一手':'牌局处理中');
  setText('sidePotText',(room.pots??[]).length>1?room.pots.map((pot,index)=>`${index?'边池':'主池'} ${money(pot.amount)}`).join(' · '):'');
  setText('roleLabel',room.isSpectator?'观战':room.hostUserId===state.user.id?'房主':'玩家');
  const board=$('board');board.replaceChildren();for(let index=0;index<5;index++)board.append(cardNode(room.board[index]??null,false));
  renderSeats();renderActions();renderFeed();
  state.lastEventId=Math.max(state.lastEventId,...(room.recentEvents??[]).map((event)=>Number(event.id)),0);
  try{sessionStorage.setItem('texas.roomId',room.id);}catch{}
}

function renderLobby() {
  $('lobbyView').hidden=false;$('tableView').hidden=true;$('createButton').hidden=false;$('joinCodeButton').hidden=false;$('leaveButton').hidden=true;$('startButton').hidden=true;$('rebuyButton').hidden=true;$('roomSettingsButton').hidden=true;
  setText('roomTitle','公开房间');setText('statusBadge','大厅');
}

function renderRoomList() {
  const list=$('roomList');list.replaceChildren();
  setText('roomListStatus',state.rooms.length?`找到 ${state.rooms.length} 个可用房间`:'暂无公开房间');
  for(const room of state.rooms){
    const row=document.createElement('article');row.className='room-row';
    const primary=document.createElement('div');const code=document.createElement('strong');code.textContent=`房间 ${room.code}`;const host=document.createElement('span');host.textContent=`房主 ${room.hostNickname}`;primary.append(code,host);
    const meta=document.createElement('div');meta.className='room-meta';meta.textContent=`${STATUS[room.status]??room.status} · ${room.playerCount}/${room.maxPlayers} · 盲注 ${room.smallBlind}/${room.bigBlind}`;
    const actions=document.createElement('div');actions.className='toolbar-actions';const join=document.createElement('button');join.textContent=room.playerCount>=room.maxPlayers?'已满':'入座';join.disabled=room.playerCount>=room.maxPlayers;join.addEventListener('click',()=>openJoin(room));actions.append(join);
    if(room.allowSpectators){const watch=document.createElement('button');watch.textContent='观战';watch.addEventListener('click',()=>spectateRoom(room.id));actions.append(watch);}
    row.append(primary,meta,actions);list.append(row);
  }
}

async function loadRooms(){try{const data=await api('/api/texas/rooms');state.rooms=data.rooms??[];renderRoomList();}catch(error){setText('roomListStatus',error.message);}}
async function refreshUser(){try{state.user=(await api('/api/auth/me')).user;setText('accountLabel',`${state.user.nickname} · ${money(state.user.beans)} 豆`);$('refillButton').hidden=Number(state.user.beans)!==0;}catch{}}

function disconnectWs(){if(state.ws&&state.ws.readyState<2)state.ws.close();state.ws=null;setText('connectionState','离线');}
function connectWs(){
  if(!state.room)return;disconnectWs();const protocol=location.protocol==='https:'?'wss':'ws';const roomId=state.room.id;
  const socket=new WebSocket(`${protocol}://${location.host}/ws?game=texas&roomId=${encodeURIComponent(roomId)}`);state.ws=socket;
  socket.onopen=()=>{setText('connectionState','已连接');socket.send(JSON.stringify({type:'sync',after:state.lastEventId}));};
  socket.onmessage=async(message)=>{try{const data=JSON.parse(message.data);if(data.type==='room_event'&&data.game==='texas')await loadRoom();if(data.type==='global_banner')showBanner(data.banner?.message);}catch{}};
  socket.onclose=()=>{if(state.ws!==socket)return;state.ws=null;if(state.room?.id===roomId){setText('connectionState','重连中');setTimeout(()=>{if(state.room?.id===roomId&&!state.ws)connectWs();},2000);}};
}

async function loadRoom(){if(!state.room)return;const id=state.room.id;try{const data=await api(`/api/texas/rooms/${id}`);if(state.room?.id!==id||Number(data.room.version)<Number(state.room.version))return;state.room=data.room;renderRoom();await refreshUser();}catch(error){showBanner(error.message);}}
function startPolling(){clearInterval(state.poll);state.poll=setInterval(()=>{if(state.room)loadRoom();},3000);}
function showBanner(message){if(!message)return;clearTimeout(state.bannerTimer);setText('globalTicker',message);state.bannerTimer=setTimeout(()=>setText('globalTicker',''),4500);}

function openJoin(room={}){$('joinRoomId').value=room.id??'';$('joinCodeInput').value=room.code??'';$('joinBuyInInput').min=String(room.minBuyIn??1);$('joinBuyInInput').max=String(room.maxBuyIn??100000);$('joinBuyInInput').value=String(Math.min(1000,room.maxBuyIn??1000));$('joinDialog').showModal();}
async function spectateRoom(roomId){try{const data=await api(`/api/texas/rooms/${roomId}/spectate`,{method:'POST',body:{enabled:true}});state.room=data.room;renderRoom();connectWs();}catch(error){showBanner(error.message);}}

async function submitAction(type,amount) {
  if(state.acting||!state.room)return;state.acting=true;renderActions();
  try{const player=ownPlayer();const data=await api(`/api/texas/rooms/${state.room.id}/actions`,{method:'POST',body:{ type,amount,handId:state.room.handId,version:state.room.version,actionSeq:Number(player?.actionSeq??0)+1,clientActionId:uid() }});state.room=data.room;renderRoom();await refreshUser();}
  catch(error){showBanner(error.message);await loadRoom();}
  finally{state.acting=false;renderActions();}
}

function showGame(){ $('authView').hidden=true;$('gameView').hidden=false;$('leaderboardView').hidden=true;refreshUser();if(state.room){renderRoom();connectWs();}else{renderLobby();loadRooms();}startPolling(); }
function setAuthMode(mode){state.authMode=mode;const login=mode==='login';$('nicknameField').hidden=login;setText('authTitle',login?'登录牌桌':'创建账号');setText('authSubmit',login?'登录':'注册并进入');setText('authModeToggle',login?'没有账号？注册':'已有账号？登录');$('passwordInput').autocomplete=login?'current-password':'new-password';}

$('authForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('authError','');try{const body={email:$('emailInput').value,password:$('passwordInput').value};if(state.authMode==='register')body.nickname=$('nicknameInput').value;state.user=(await api(`/api/auth/${state.authMode}`,{method:'POST',body})).user;showGame();await restoreRoom();}catch(error){setText('authError',error.message);}});
$('authModeToggle').addEventListener('click',()=>setAuthMode(state.authMode==='login'?'register':'login'));
$('refreshButton').addEventListener('click',loadRooms);$('createButton').addEventListener('click',()=>$('createDialog').showModal());$('joinCodeButton').addEventListener('click',()=>openJoin());
$('createForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('createError','');try{const body={smallBlind:Number($('smallBlindInput').value),bigBlind:Number($('bigBlindInput').value),buyIn:Number($('createBuyInInput').value),maxPlayers:Number($('maxPlayersInput').value),allowSpectators:$('allowSpectatorsInput').checked,spectatorCards:$('spectatorCardsInput').checked};state.room=(await api('/api/texas/rooms',{method:'POST',body})).room;$('createDialog').close();renderRoom();connectWs();await refreshUser();}catch(error){setText('createError',error.message);}});
$('joinForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('joinError','');try{const roomId=$('joinRoomId').value||$('joinCodeInput').value.trim();state.room=(await api(`/api/texas/rooms/${encodeURIComponent(roomId)}/join`,{method:'POST',body:{buyIn:Number($('joinBuyInInput').value)}})).room;$('joinDialog').close();renderRoom();connectWs();await refreshUser();}catch(error){setText('joinError',error.message);}});
$('startButton').addEventListener('click',async()=>{try{state.room=(await api(`/api/texas/rooms/${state.room.id}/start`,{method:'POST',body:{}})).room;renderRoom();}catch(error){showBanner(error.message);}});
$('leaveButton').addEventListener('click',async()=>{if(!state.room)return;const id=state.room.id;try{await api(`/api/texas/rooms/${id}/leave`,{method:'POST',body:{}});disconnectWs();state.room=null;try{sessionStorage.removeItem('texas.roomId');}catch{}renderLobby();await refreshUser();await loadRooms();}catch(error){showBanner(error.message);}});
$('rebuyButton').addEventListener('click',()=>{$('rebuyAmountInput').max=String(Math.max(0,state.room.maxBuyIn-ownPlayer().stack));$('rebuyDialog').showModal();});
$('rebuyForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('rebuyError','');try{state.room=(await api(`/api/texas/rooms/${state.room.id}/rebuy`,{method:'POST',body:{amount:Number($('rebuyAmountInput').value)}})).room;$('rebuyDialog').close();renderRoom();await refreshUser();}catch(error){setText('rebuyError',error.message);}});
$('roomSettingsButton').addEventListener('click',()=>{$('roomAllowSpectators').checked=state.room.allowSpectators;$('roomSpectatorCards').checked=state.room.spectatorCards;$('roomSettingsDialog').showModal();});
$('roomSettingsForm').addEventListener('submit',async(event)=>{event.preventDefault();state.room=(await api(`/api/texas/rooms/${state.room.id}/settings`,{method:'POST',body:{allowSpectators:$('roomAllowSpectators').checked,spectatorCards:$('roomSpectatorCards').checked}})).room;$('roomSettingsDialog').close();renderRoom();});
document.querySelectorAll('[data-close]').forEach((button)=>button.addEventListener('click',()=>$(button.dataset.close).close()));
document.querySelectorAll('[data-action]').forEach((button)=>button.addEventListener('click',()=>button.dataset.action==='all_in'&&!confirm('确认全押全部牌桌筹码？')?null:submitAction(button.dataset.action)));
$('raiseSlider').addEventListener('input',()=>{$('raiseAmount').value=$('raiseSlider').value;});$('raiseAmount').addEventListener('input',()=>{$('raiseSlider').value=$('raiseAmount').value;});$('raiseButton').addEventListener('click',()=>submitAction($('raiseButton').dataset.action,Number($('raiseAmount').value)));
$('leaderboardButton').addEventListener('click',()=>{$('gameView').hidden=true;$('leaderboardView').hidden=false;loadLeaderboard(state.leaderboardKind);});$('backButton').addEventListener('click',showGame);
document.querySelectorAll('[data-rank]').forEach((button)=>button.addEventListener('click',()=>loadLeaderboard(button.dataset.rank)));
async function loadLeaderboard(kind){state.leaderboardKind=kind;const data=await api(`/api/leaderboards?kind=${kind}`);document.querySelectorAll('[data-rank]').forEach((button)=>button.classList.toggle('active',button.dataset.rank===kind));const list=$('leaderboardList');list.replaceChildren();for(const entry of data.entries){const row=document.createElement('div');row.className='leader-row';for(const [className,text] of [['leader-rank',entry.rank],['',entry.nickname],['leader-title',entry.title],['',`${entry.wins} 胜 / ${entry.losses} 负`],['',`${money(entry.beans)} 豆`]]){const value=document.createElement('div');value.className=className;value.textContent=text;row.append(value);}list.append(row);}}
$('refillButton').addEventListener('click',async()=>{try{await api('/api/me/refill',{method:'POST',body:{}});await refreshUser();showBanner('补给已到账');}catch(error){showBanner(error.message);}});
addEventListener('resize',()=>{if(state.room)renderSeats();});

async function restoreRoom(){try{const id=sessionStorage.getItem('texas.roomId');if(!id)return;state.room=(await api(`/api/texas/rooms/${id}`)).room;const present=state.room.players.some((player)=>player.userId===state.user.id)||state.room.isSpectator;if(!present)throw new Error('已离开房间');renderRoom();connectWs();}catch{state.room=null;try{sessionStorage.removeItem('texas.roomId');}catch{}renderLobby();}}
async function restoreSession(){try{state.user=(await api('/api/auth/me')).user;showGame();await restoreRoom();}catch{setAuthMode('login');}}
setAuthMode('login');restoreSession();
