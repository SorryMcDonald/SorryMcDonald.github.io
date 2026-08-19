import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const supabase=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
const state={user:null,room:null,rooms:[],channel:null,bannerTimer:null,acting:false,lastEventId:0,renderedRoomId:null,leaderboardKind:'wins'};
const $=(id)=>document.getElementById(id);
const ACTIVE=new Set(['preflop','flop','turn','river']);
const STATUS={waiting:'等待开局',preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',showdown:'摊牌',settled:'本手已结算',closed:'已关闭'};
const RANK={2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
const SUIT={S:'♠',H:'♥',C:'♣',D:'♦'};
const ERROR_TEXT={
  AUTH_REQUIRED:'登录状态已失效，请刷新页面',ROOM_NOT_FOUND:'房间不存在',ROOM_ACCESS_REQUIRED:'你已不在这个房间',ROOM_CLOSED:'房间已关闭',
  ALREADY_IN_ROOM:'你已经在一个房间中',ALREADY_IN_OTHER_ROOM:'请先退出当前房间',ROOM_FULL:'房间已满',INSUFFICIENT_BEANS:'账户豆子不足',
  PLAYER_NOT_IN_ROOM:'你不在这个房间',PLAYER_NOT_IN_HAND:'你没有参与本手',HOST_ONLY:'只有房主可以操作',HAND_NOT_READY:'当前不能开始下一手',
  NEED_TWO_PLAYERS:'至少需要两名有筹码的玩家',NOT_YOUR_TURN:'还没有轮到你',ACTION_NOT_ALLOWED:'当前操作不合法',STALE_ROOM_VERSION:'牌桌状态已更新，请重试',
  INVALID_ACTION_SEQUENCE:'行动状态已更新，请重试',CLIENT_ACTION_ID_REQUIRED:'行动请求标识无效',REBUY_BETWEEN_HANDS_ONLY:'只能在两手之间补充筹码',
  INVALID_REBUY:'补充数量超出房间限制',SPECTATORS_DISABLED:'房间未开放观战',CANNOT_SPECTATE_DURING_HAND:'本手进行中不能切换为观战',NICKNAME_TOO_LONG:'昵称不能超过 24 个字符'
};

function readableError(error){
  const raw=String(error?.message??error??'请求失败');
  for(const [code,message] of Object.entries(ERROR_TEXT))if(raw.includes(code))return message;
  const range=raw.match(/BUY_IN_RANGE:(\d+)-(\d+)/);if(range)return`买入范围为 ${money(range[1])} - ${money(range[2])}`;
  const minimum=raw.match(/MIN_(?:BET|RAISE_TO):(\d+)/);if(minimum)return`最少需要下注到 ${money(minimum[1])}`;
  return raw;
}
async function rpc(name,args={}){const{data,error}=await supabase.rpc(name,args);if(error)throw new Error(readableError(error));return data;}
function setText(id,value){$(id).textContent=String(value??'');}
function money(value){return Number(value??0).toLocaleString('zh-CN');}
function actionId(){return crypto.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
function ownPlayer(){return state.room?.players.find((player)=>player.userId===state.user?.id);}

function cardNode(card,concealed=true){
  const node=document.createElement('span');node.className='poker-card';
  if(!card){node.classList.add(concealed?'back':'empty');node.setAttribute('aria-label',concealed?'牌背':'空牌位');return node;}
  const suit=SUIT[card.suit]??card.suit;const rank=RANK[Number(card.rank)]??card.rank;
  if(['♥','♦'].includes(suit))node.classList.add('red');node.setAttribute('aria-label',`${rank}${suit}`);
  const index=document.createElement('span');index.className='card-index';const rankNode=document.createElement('span');rankNode.textContent=rank;
  const suitNode=document.createElement('span');suitNode.className='card-suit';suitNode.textContent=suit;const center=document.createElement('span');center.className='card-center';center.textContent=suit;
  index.append(rankNode,suitNode);node.append(index,center);return node;
}
function seatPosition(index,total){const angle=(90+index*360/Math.max(1,total))*Math.PI/180;const mobile=matchMedia('(max-width:620px)').matches;return{left:`${50+(mobile?38:42)*Math.cos(angle)}%`,top:`${50+(mobile?40:39)*Math.sin(angle)}%`};}
function badge(text,className=''){const value=document.createElement('span');value.className=`badge ${className}`;value.textContent=text;return value;}
function lastStartEvent(room){return[...(room.recentEvents??[])].reverse().find((event)=>event.eventType==='texas_hand_started'&&event.handId===room.handId);}

function renderSeats({entrance=false,joinedUserIds=new Set()}={}){
  const room=state.room;const container=$('seats');container.replaceChildren();
  const ordered=[...room.players].sort((left,right)=>left.userId===state.user.id?-1:right.userId===state.user.id?1:left.seat-right.seat);const start=lastStartEvent(room)?.payload??{};
  ordered.forEach((player,index)=>{
    const seat=document.createElement('article');seat.className='player-seat';seat.dataset.userId=player.userId;seat.dataset.seat=String(player.seat);Object.assign(seat.style,seatPosition(index,ordered.length));
    if(entrance||joinedUserIds.has(player.userId)){seat.classList.add('seat-enter');seat.style.setProperty('--seat-delay',`${entrance?index*70:0}ms`);}
    if(player.userId===state.user.id)seat.classList.add('me');if(player.folded)seat.classList.add('folded');if(player.seat===room.currentTurn)seat.classList.add('current');
    const name=document.createElement('div');name.className='player-name';name.textContent=`${player.nickname}${player.userId===state.user.id?'（你）':''}`;
    const stack=document.createElement('div');stack.className='player-stack';stack.textContent=`${money(player.stack)} 筹码${player.streetBet?` · 下注 ${money(player.streetBet)}`:''}`;
    const badges=document.createElement('div');badges.className='player-badges';if(player.seat===room.dealerSeat)badges.append(badge('D','dealer'));if(player.seat===start.smallBlindSeat)badges.append(badge('SB','blind'));if(player.seat===start.bigBlindSeat)badges.append(badge('BB','blind'));
    if(player.allIn)badges.append(badge('全押'));else if(player.folded)badges.append(badge('弃牌'));else if(player.waiting||!player.inHand)badges.append(badge('等待','waiting'));
    const cards=document.createElement('div');cards.className='hole-cards';const visible=Array.isArray(player.holeCards)?player.holeCards:null;const slots=visible??(player.inHand?[null,null]:[]);slots.forEach((card)=>cards.append(cardNode(card)));
    seat.append(name,stack,badges,cards);container.append(seat);
  });
}

function findSeat({userId,seat}={}){
  return[...document.querySelectorAll('.player-seat')].find((node)=>userId?node.dataset.userId===String(userId):node.dataset.seat===String(seat));
}
function animateClass(node,className,duration=2400){if(!node)return;node.classList.remove(className);void node.offsetWidth;node.classList.add(className);setTimeout(()=>node.isConnected&&node.classList.remove(className),duration);}
function animateChips(target,amount,{fromPot=false,delay=0,roomId=state.room?.id}={}){
  setTimeout(()=>{
    if(!target?.isConnected||state.room?.id!==roomId)return;const table=$('pokerTable');const source=fromPot?$('potValue').closest('.pot-line'):target;const destination=fromPot?target:$('potValue').closest('.pot-line');
    if(!table||!source||!destination)return;const tableRect=table.getBoundingClientRect();const from=source.getBoundingClientRect();const to=destination.getBoundingClientRect();
    const chip=document.createElement('div');chip.className=`chip-flight${fromPot?' payout':''}`;chip.setAttribute('aria-hidden','true');
    const disc=document.createElement('span');disc.className='chip-disc';const label=document.createElement('strong');label.textContent=money(amount);chip.append(disc,label);
    const startX=from.left+from.width/2-tableRect.left;const startY=from.top+from.height/2-tableRect.top;const endX=to.left+to.width/2-tableRect.left;const endY=to.top+to.height/2-tableRect.top;
    chip.style.left=`${startX}px`;chip.style.top=`${startY}px`;chip.style.setProperty('--chip-x',`${endX-startX}px`);chip.style.setProperty('--chip-y',`${endY-startY}px`);table.append(chip);chip.addEventListener('animationend',()=>chip.remove(),{once:true});
  },delay);
}
function showSettlement(players,roomId){
  if(state.room?.id!==roomId)return;const winners=players.filter((player)=>!player.folded&&Number(player.payout)>0);const losers=players.filter((player)=>Number(player.net)<0||player.folded);
  winners.forEach((player,index)=>{const seat=findSeat({userId:player.userId});animateClass(seat,'round-winner',3000);animateChips(seat,player.payout,{fromPot:true,delay:index*140,roomId});});
  losers.filter((player)=>!winners.some((winner)=>winner.userId===player.userId)).forEach((player)=>animateClass(findSeat({userId:player.userId}),'round-loser',2600));
  const table=$('pokerTable');if(!table||!winners.length)return;table.querySelector('.settlement-burst')?.remove();const result=document.createElement('div');result.className='settlement-burst';result.setAttribute('role','status');
  const title=document.createElement('strong');title.textContent=winners.length>1?'平分底池':'本手赢家';const names=document.createElement('span');names.textContent=winners.map((winner)=>winner.nickname).join('、');result.append(title,names);table.append(result);result.addEventListener('animationend',()=>result.remove(),{once:true});
}
function playRoomEvents(events,roomId){
  [...events].sort((left,right)=>Number(left.id)-Number(right.id)).forEach((event,index)=>{
    const payload=event.payload??{};const delay=index*140;
    if(event.eventType==='texas_player_action'&&Number(payload.paid)>0)animateChips(findSeat({userId:payload.userId}),payload.paid,{delay,roomId});
    if(event.eventType==='texas_blinds_posted'){
      animateChips(findSeat({seat:payload.smallBlind?.seat}),payload.smallBlind?.amount,{delay,roomId});
      animateChips(findSeat({seat:payload.bigBlind?.seat}),payload.bigBlind?.amount,{delay:delay+120,roomId});
    }
    if(event.eventType==='texas_hand_settled')setTimeout(()=>showSettlement(payload.players??[],roomId),delay+220);
  });
}
function eventText(event){
  const p=event.payload??{};
  if(event.eventType==='texas_player_joined')return`${p.nickname} 加入座位 ${Number(p.seat)+1}${p.waiting?'，等待下一手':''}`;
  if(event.eventType==='texas_player_left')return`座位 ${Number(p.seat)+1} 离开房间`;
  if(event.eventType==='texas_hand_started')return`第 ${p.handNumber} 手开始，庄家位于座位 ${Number(p.dealerSeat)+1}`;
  if(event.eventType==='texas_blinds_posted')return`小盲 ${money(p.smallBlind?.amount)}，大盲 ${money(p.bigBlind?.amount)}`;
  if(event.eventType==='texas_player_action'){const action={fold:'弃牌',check:'过牌',call:'跟注',bet:'下注',raise:'加注',all_in:'全押'}[p.action]??p.action;return`${p.nickname} ${action}${p.paid?` ${money(p.paid)}`:''}`;}
  if(event.eventType==='flop_dealt')return'发出翻牌';if(event.eventType==='turn_dealt')return'发出转牌';if(event.eventType==='river_dealt')return'发出河牌';
  if(event.eventType==='texas_player_rebuy')return`玩家补充 ${money(p.amount)} 筹码`;
  if(event.eventType==='texas_hand_settled'){const winners=(p.players??[]).filter((player)=>!player.folded&&player.payout>0).map((player)=>`${player.nickname} +${money(player.payout)}`);return`本手结算：${winners.join('，')||'无赢家'}`;}
  return'';
}
function renderFeed(){const feed=$('eventFeed');feed.replaceChildren();for(const event of[...(state.room?.recentEvents??[])].reverse()){const text=eventText(event);if(!text)continue;const line=document.createElement('p');line.textContent=text;const time=document.createElement('time');time.textContent=new Date(event.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});line.prepend(time);feed.append(line);}}
function renderActions(){
  const room=state.room;const allowed=room.allowedActions??{actions:[]};const actions=new Set(allowed.actions??[]);const active=ACTIVE.has(room.status)&&!room.isSpectator&&ownPlayer()?.inHand;$('actionBar').hidden=!active;
  for(const[id,action]of[['foldButton','fold'],['checkButton','check'],['callButton','call'],['allInButton','all_in']])$(id).disabled=state.acting||!actions.has(action);
  setText('callButton',allowed.toCall?`跟注 ${money(allowed.toCall)}`:'跟注');const raiseType=actions.has('raise')?'raise':actions.has('bet')?'bet':null;
  const min=Math.max(0,Number(allowed.minRaiseTo??room.bigBlind));const max=Math.max(0,Number(allowed.maxRaiseTo??0));$('raiseSlider').min=String(Math.min(min,max));$('raiseSlider').max=String(max);$('raiseAmount').min=String(Math.min(min,max));$('raiseAmount').max=String(max);
  const current=Number($('raiseAmount').value);if(current<min||current>max){$('raiseAmount').value=String(Math.min(min,max));$('raiseSlider').value=$('raiseAmount').value;}$('raiseButton').dataset.action=raiseType??'';$('raiseButton').textContent=raiseType==='bet'?'下注':'加注';$('raiseButton').disabled=state.acting||!raiseType||max<min;
}
function renderRoom(){
  const room=state.room;if(!room){renderLobby();return;}const firstRender=state.renderedRoomId!==room.id;const newEvents=firstRender?[]:(room.recentEvents??[]).filter((event)=>Number(event.id)>state.lastEventId);const joinedUserIds=new Set(newEvents.filter((event)=>event.eventType==='texas_player_joined').map((event)=>event.payload?.userId).filter(Boolean));state.renderedRoomId=room.id;
  $('lobbyView').hidden=true;$('tableView').hidden=false;$('createButton').hidden=true;$('joinCodeButton').hidden=true;$('leaveButton').hidden=false;
  $('startButton').hidden=!['waiting','settled'].includes(room.status)||room.hostUserId!==state.user.id;const me=ownPlayer();$('rebuyButton').hidden=!me||!['waiting','settled'].includes(room.status)||me.stack>=room.maxBuyIn;$('roomSettingsButton').hidden=room.hostUserId!==state.user.id;
  setText('roomTitle',`房间 ${room.code}`);setText('statusBadge',STATUS[room.status]??room.status);setText('potValue',money(room.pot));setText('blindText',`${money(room.smallBlind)} / ${money(room.bigBlind)}`);setText('handNumber',room.handNumber);setText('currentBet',money(room.currentBet));setText('minimumRaise',money(room.minRaise));
  const current=room.players.find((player)=>player.seat===room.currentTurn);setText('turnText',current?current.userId===state.user.id?'轮到你行动':`轮到 ${current.nickname}`:['waiting','settled'].includes(room.status)?'等待房主开始下一手':'牌局处理中');
  setText('sidePotText',(room.pots??[]).length>1?room.pots.map((pot,index)=>`${index?'边池':'主池'} ${money(pot.amount)}`).join(' · '):'');setText('roleLabel',room.isSpectator?'观战':room.hostUserId===state.user.id?'房主':'玩家');
  const board=$('board');board.replaceChildren();for(let index=0;index<5;index++)board.append(cardNode(room.board[index]??null,false));renderSeats({entrance:firstRender,joinedUserIds});renderActions();renderFeed();playRoomEvents(newEvents,room.id);state.lastEventId=Math.max(state.lastEventId,...(room.recentEvents??[]).map((event)=>Number(event.id)),0);try{sessionStorage.setItem('texas.roomId',room.id);}catch{}
}
function renderLobby(){state.renderedRoomId=null;$('lobbyView').hidden=false;$('tableView').hidden=true;$('createButton').hidden=false;$('joinCodeButton').hidden=false;$('leaveButton').hidden=true;$('startButton').hidden=true;$('rebuyButton').hidden=true;$('roomSettingsButton').hidden=true;setText('roomTitle','公开房间');setText('statusBadge','大厅');}
function renderRoomList(){const list=$('roomList');list.replaceChildren();setText('roomListStatus',state.rooms.length?`找到 ${state.rooms.length} 个可用房间`:'暂无公开房间');for(const room of state.rooms){const row=document.createElement('article');row.className='room-row';const primary=document.createElement('div');const code=document.createElement('strong');code.textContent=`房间 ${room.code}`;const host=document.createElement('span');host.textContent=`房主 ${room.hostNickname}`;primary.append(code,host);const meta=document.createElement('div');meta.className='room-meta';meta.textContent=`${STATUS[room.status]??room.status} · ${room.playerCount}/${room.maxPlayers} · 盲注 ${room.smallBlind}/${room.bigBlind}`;const actions=document.createElement('div');actions.className='toolbar-actions';const join=document.createElement('button');join.textContent=room.playerCount>=room.maxPlayers?'已满':'入座';join.disabled=room.playerCount>=room.maxPlayers;join.addEventListener('click',()=>openJoin(room));actions.append(join);if(room.allowSpectators){const watch=document.createElement('button');watch.textContent='观战';watch.addEventListener('click',()=>spectateRoom(room.id));actions.append(watch);}row.append(primary,meta,actions);list.append(row);}}

async function loadRooms(){setText('roomListStatus','正在刷新…');try{state.rooms=(await rpc('texas_sb_list_rooms'))??[];renderRoomList();}catch(error){setText('roomListStatus',readableError(error));}}
async function refreshUser(){try{state.user=await rpc('texas_sb_me');setText('accountLabel',`${state.user.nickname} · ${money(state.user.beans)} 豆`);}catch(error){showBanner(readableError(error));}}
async function disconnectRealtime(){const channel=state.channel;state.channel=null;if(channel)await supabase.removeChannel(channel);setText('connectionState','离线');}
async function connectRealtime(){
  if(!state.room)return;await disconnectRealtime();const roomId=state.room.id;
  state.channel=supabase.channel(`texas-room-${roomId}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'texas_sb_rooms',filter:`id=eq.${roomId}`},(payload)=>{if(state.room?.id===roomId&&Number(payload.new?.version)>Number(state.room.version))loadRoom();}).subscribe((status)=>setText('connectionState',status==='SUBSCRIBED'?'已连接':status==='CHANNEL_ERROR'||status==='TIMED_OUT'?'连接异常':'连接中'));
}
async function loadRoom(){if(!state.room)return;const id=state.room.id;try{const room=await rpc('texas_sb_snapshot',{p_room:id});if(state.room?.id!==id||Number(room.version)<Number(state.room.version))return;state.room=room;renderRoom();await refreshUser();}catch(error){showBanner(readableError(error));}}
function showBanner(message){if(!message)return;clearTimeout(state.bannerTimer);setText('globalTicker',message);state.bannerTimer=setTimeout(()=>setText('globalTicker',''),4500);}
function openJoin(room={}){$('joinRoomId').value=room.id??'';$('joinCodeInput').value=room.code??'';$('joinBuyInInput').min=String(room.minBuyIn??1);$('joinBuyInInput').max=String(room.maxBuyIn??100000);$('joinBuyInInput').value=String(Math.min(1000,room.maxBuyIn??1000));$('joinDialog').showModal();}
async function spectateRoom(roomId){try{state.room=await rpc('texas_sb_spectate',{p_room:roomId,p_enabled:true});renderRoom();await connectRealtime();}catch(error){showBanner(readableError(error));}}
async function submitAction(type,amount){if(state.acting||!state.room)return;state.acting=true;renderActions();try{const player=ownPlayer();state.room=await rpc('texas_sb_action',{p_room:state.room.id,p_type:type,p_amount:amount??null,p_expected_version:state.room.version,p_action_seq:Number(player?.actionSeq??0)+1,p_client_action_id:actionId()});renderRoom();await refreshUser();}catch(error){showBanner(readableError(error));await loadRoom();}finally{state.acting=false;renderActions();}}
function showGame(){$('authView').hidden=true;$('gameView').hidden=false;$('leaderboardView').hidden=true;refreshUser();if(state.room){renderRoom();connectRealtime();}else{renderLobby();loadRooms();}}

$('authForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('authError','');try{const{data:{session}}=await supabase.auth.getSession();if(!session){const result=await supabase.auth.signInAnonymously();if(result.error)throw result.error;}const nickname=$('nicknameInput').value.trim();state.user=await rpc('texas_sb_bootstrap',{p_nickname:nickname});localStorage.setItem('texas.nickname',nickname);showGame();await restoreRoom();}catch(error){setText('authError',readableError(error));}});
$('refreshButton').addEventListener('click',loadRooms);$('createButton').addEventListener('click',()=>$('createDialog').showModal());$('joinCodeButton').addEventListener('click',()=>openJoin());
$('createForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('createError','');try{state.room=await rpc('texas_sb_create_room',{p_small_blind:Number($('smallBlindInput').value),p_big_blind:Number($('bigBlindInput').value),p_buy_in:Number($('createBuyInInput').value),p_max_players:Number($('maxPlayersInput').value),p_allow_spectators:$('allowSpectatorsInput').checked,p_spectator_cards:$('spectatorCardsInput').checked,p_is_public:true});$('createDialog').close();renderRoom();await connectRealtime();await refreshUser();}catch(error){setText('createError',readableError(error));}});
$('joinForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('joinError','');try{const roomId=$('joinRoomId').value||$('joinCodeInput').value.trim();state.room=await rpc('texas_sb_join_room',{p_room:roomId,p_buy_in:Number($('joinBuyInInput').value)});$('joinDialog').close();renderRoom();await connectRealtime();await refreshUser();}catch(error){setText('joinError',readableError(error));}});
$('startButton').addEventListener('click',async()=>{try{state.room=await rpc('texas_sb_start_hand',{p_room:state.room.id});renderRoom();}catch(error){showBanner(readableError(error));}});
$('leaveButton').addEventListener('click',async()=>{if(!state.room)return;const id=state.room.id;try{await rpc('texas_sb_leave_room',{p_room:id});await disconnectRealtime();state.room=null;try{sessionStorage.removeItem('texas.roomId');}catch{}renderLobby();await refreshUser();await loadRooms();}catch(error){showBanner(readableError(error));}});
$('rebuyButton').addEventListener('click',()=>{$('rebuyAmountInput').max=String(Math.max(0,state.room.maxBuyIn-ownPlayer().stack));$('rebuyDialog').showModal();});
$('rebuyForm').addEventListener('submit',async(event)=>{event.preventDefault();setText('rebuyError','');try{state.room=await rpc('texas_sb_rebuy',{p_room:state.room.id,p_amount:Number($('rebuyAmountInput').value)});$('rebuyDialog').close();renderRoom();await refreshUser();}catch(error){setText('rebuyError',readableError(error));}});
$('roomSettingsButton').addEventListener('click',()=>{$('roomAllowSpectators').checked=state.room.allowSpectators;$('roomSpectatorCards').checked=state.room.spectatorCards;$('roomSettingsDialog').showModal();});
$('roomSettingsForm').addEventListener('submit',async(event)=>{event.preventDefault();try{state.room=await rpc('texas_sb_update_settings',{p_room:state.room.id,p_allow_spectators:$('roomAllowSpectators').checked,p_spectator_cards:$('roomSpectatorCards').checked});$('roomSettingsDialog').close();renderRoom();}catch(error){showBanner(readableError(error));}});
document.querySelectorAll('[data-close]').forEach((button)=>button.addEventListener('click',()=>$(button.dataset.close).close()));document.querySelectorAll('[data-action]').forEach((button)=>button.addEventListener('click',()=>button.dataset.action==='all_in'&&!confirm('确认全押全部牌桌筹码？')?null:submitAction(button.dataset.action)));
$('raiseSlider').addEventListener('input',()=>{$('raiseAmount').value=$('raiseSlider').value;});$('raiseAmount').addEventListener('input',()=>{$('raiseSlider').value=$('raiseAmount').value;});$('raiseButton').addEventListener('click',()=>submitAction($('raiseButton').dataset.action,Number($('raiseAmount').value)));
$('leaderboardButton').addEventListener('click',()=>{$('gameView').hidden=true;$('leaderboardView').hidden=false;loadLeaderboard(state.leaderboardKind);});$('backButton').addEventListener('click',showGame);document.querySelectorAll('[data-rank]').forEach((button)=>button.addEventListener('click',()=>loadLeaderboard(button.dataset.rank)));
async function loadLeaderboard(kind){try{state.leaderboardKind=kind;const entries=await rpc('texas_sb_leaderboard',{p_kind:kind});document.querySelectorAll('[data-rank]').forEach((button)=>button.classList.toggle('active',button.dataset.rank===kind));const list=$('leaderboardList');list.replaceChildren();for(const entry of entries??[]){const row=document.createElement('div');row.className='leader-row';for(const[className,text]of[['leader-rank',entry.rank],['',entry.nickname],['leader-title',entry.title],['',`${entry.wins} 胜 / ${entry.losses} 负`],['',`${money(entry.beans)} 豆 · 已重置 ${Number(entry.resetCount??0)} 次`]]){const value=document.createElement('div');value.className=className;value.textContent=text;row.append(value);}list.append(row);}}catch(error){showBanner(readableError(error));}}
addEventListener('resize',()=>{if(state.room)renderSeats();});
async function restoreRoom(){try{const id=sessionStorage.getItem('texas.roomId');if(!id)return;state.room=await rpc('texas_sb_snapshot',{p_room:id});const present=state.room.players.some((player)=>player.userId===state.user.id)||state.room.isSpectator;if(!present)throw new Error('已离开房间');renderRoom();await connectRealtime();}catch{state.room=null;try{sessionStorage.removeItem('texas.roomId');}catch{}renderLobby();}}
async function restoreSession(){try{const{data:{session}}=await supabase.auth.getSession();if(!session){$('nicknameInput').value=localStorage.getItem('texas.nickname')??'';return;}state.user=await rpc('texas_sb_bootstrap',{p_nickname:null});showGame();await restoreRoom();}catch(error){setText('authError',readableError(error));}}
restoreSession();
