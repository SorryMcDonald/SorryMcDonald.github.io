-- ============================================================
-- 德州扑克 Supabase 版
-- 在 Supabase SQL Editor 中整段执行。可重复执行，不依赖 Node.js 服务器。
-- 前端只调用 RPC；洗牌、底牌、行动校验、边池和结算均在事务内完成。
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.texas_sb_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  beans bigint not null default 10000 check (beans >= 0),
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.texas_sb_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting'
    check (status in ('waiting','preflop','flop','turn','river','showdown','settled','closed')),
  host_user_id uuid references auth.users(id) on delete set null,
  small_blind bigint not null check (small_blind > 0),
  big_blind bigint not null check (big_blind >= small_blind * 2),
  min_buy_in bigint not null check (min_buy_in >= big_blind * 20),
  max_buy_in bigint not null check (max_buy_in >= min_buy_in),
  max_players integer not null check (max_players between 2 and 9),
  dealer_seat integer check (dealer_seat between 0 and 8),
  current_turn integer not null default -1 check (current_turn between -1 and 8),
  current_bet bigint not null default 0 check (current_bet >= 0),
  min_raise bigint not null check (min_raise > 0),
  hand_number integer not null default 0 check (hand_number >= 0),
  hand_id uuid,
  board jsonb not null default '[]'::jsonb,
  pot bigint not null default 0 check (pot >= 0),
  version bigint not null default 0 check (version >= 0),
  is_public boolean not null default true,
  allow_spectators boolean not null default false,
  spectator_cards boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.texas_sb_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.texas_sb_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat integer not null check (seat between 0 and 8),
  stack bigint not null check (stack >= 0),
  buy_in bigint not null check (buy_in > 0),
  in_hand boolean not null default false,
  waiting boolean not null default true,
  folded boolean not null default false,
  all_in boolean not null default false,
  acted boolean not null default false,
  can_raise boolean not null default true,
  street_bet bigint not null default 0 check (street_bet >= 0),
  total_contribution bigint not null default 0 check (total_contribution >= 0),
  payout bigint not null default 0 check (payout >= 0),
  action_seq integer not null default 0 check (action_seq >= 0),
  last_action text,
  pending_leave boolean not null default false,
  left_room boolean not null default false,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists texas_sb_one_active_room_per_user
  on public.texas_sb_players(user_id) where not left_room;
create unique index if not exists texas_sb_one_active_seat
  on public.texas_sb_players(room_id, seat) where not left_room;
create index if not exists texas_sb_players_room_idx
  on public.texas_sb_players(room_id) where not left_room;

create table if not exists public.texas_sb_spectators (
  room_id uuid not null references public.texas_sb_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.texas_sb_hands (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.texas_sb_rooms(id) on delete cascade,
  hand_number integer not null check (hand_number > 0),
  status text not null check (status in ('preflop','flop','turn','river','showdown','settled')),
  dealer_seat integer not null check (dealer_seat between 0 and 8),
  deck jsonb not null,
  deck_pos integer not null default 0,
  board jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (room_id, hand_number)
);

create table if not exists public.texas_sb_hole_cards (
  hand_id uuid not null references public.texas_sb_hands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cards jsonb not null check (jsonb_typeof(cards)='array' and jsonb_array_length(cards)=2),
  evaluation jsonb,
  primary key (hand_id, user_id)
);

create table if not exists public.texas_sb_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.texas_sb_rooms(id) on delete cascade,
  hand_id uuid references public.texas_sb_hands(id) on delete cascade,
  event_type text not null,
  user_id uuid references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists texas_sb_events_room_idx
  on public.texas_sb_events(room_id, id desc);

create table if not exists public.texas_sb_pots (
  hand_id uuid not null references public.texas_sb_hands(id) on delete cascade,
  pot_index integer not null check (pot_index >= 0),
  amount bigint not null check (amount > 0),
  eligible_user_ids jsonb not null default '[]'::jsonb,
  winner_user_ids jsonb not null default '[]'::jsonb,
  primary key (hand_id, pot_index)
);

create table if not exists public.texas_sb_client_actions (
  client_action_id text primary key,
  room_id uuid not null references public.texas_sb_rooms(id) on delete cascade,
  hand_id uuid not null references public.texas_sb_hands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.texas_sb_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end;
$$;

drop trigger if exists trg_texas_sb_profiles_updated on public.texas_sb_profiles;
create trigger trg_texas_sb_profiles_updated before update on public.texas_sb_profiles
for each row execute function public.texas_sb_set_updated_at();
drop trigger if exists trg_texas_sb_players_updated on public.texas_sb_players;
create trigger trg_texas_sb_players_updated before update on public.texas_sb_players
for each row execute function public.texas_sb_set_updated_at();

create or replace function public._texas_sb_uid()
returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  return v_uid;
end;
$$;

create or replace function public._texas_sb_room_id(p_room text)
returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_input_id uuid;
begin
  if nullif(trim(p_room),'') is null then raise exception 'ROOM_NOT_FOUND'; end if;
  begin v_input_id := trim(p_room)::uuid; exception when invalid_text_representation then v_input_id := null; end;
  select r.id into v_id from public.texas_sb_rooms r
    where r.id=v_input_id or upper(r.code)=upper(trim(p_room)) limit 1;
  if v_id is null then raise exception 'ROOM_NOT_FOUND'; end if;
  return v_id;
end;
$$;

create or replace function public._texas_sb_gen_code()
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_code text;
begin
  loop
    v_code := lpad((floor(random()*900000)+100000)::bigint::text,6,'0');
    exit when not exists(select 1 from public.texas_sb_rooms where code=v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function public._texas_sb_event(p_room uuid,p_type text,p_payload jsonb default '{}'::jsonb,p_user uuid default null)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id bigint; v_hand uuid;
begin
  select hand_id into v_hand from public.texas_sb_rooms where id=p_room;
  insert into public.texas_sb_events(room_id,hand_id,event_type,user_id,payload)
  values(p_room,v_hand,p_type,p_user,coalesce(p_payload,'{}'::jsonb)) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public._texas_sb_next_seat(p_room uuid,p_from integer,p_actionable boolean default false)
returns integer language sql stable security definer set search_path=public,pg_temp as $$
  with candidates as (
    select seat from public.texas_sb_players
    where room_id=p_room and not left_room
      and (not p_actionable or (in_hand and not folded and not all_in and not pending_leave))
  )
  select coalesce(
    (select seat from candidates where seat>p_from order by seat limit 1),
    (select seat from candidates order by seat limit 1),-1
  );
$$;

create or replace function public._texas_sb_eval_five(p_cards jsonb)
returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare
  v_ranks integer[]; v_unique integer[]; v_flush boolean; v_straight integer := 0;
  v_groups jsonb; v_pairs integer[]; v_level integer; v_name text; v_values integer[];
  i integer; g0 integer; g0c integer; g1 integer; g1c integer;
begin
  if jsonb_typeof(p_cards)<>'array' or jsonb_array_length(p_cards)<>5 then raise exception 'INVALID_FIVE_CARDS'; end if;
  select array_agg((c->>'rank')::integer order by (c->>'rank')::integer desc), count(distinct c->>'suit')=1
    into v_ranks,v_flush from jsonb_array_elements(p_cards) c;
  select array_agg(rank order by rank desc) into v_unique from (select distinct (c->>'rank')::integer rank from jsonb_array_elements(p_cards)c)q;
  if 14=any(v_unique) then v_unique:=array_append(v_unique,1); end if;
  if cardinality(v_unique)>=5 then
    for i in 1..cardinality(v_unique)-4 loop
      if v_unique[i]=v_unique[i+1]+1 and v_unique[i]=v_unique[i+2]+2 and v_unique[i]=v_unique[i+3]+3 and v_unique[i]=v_unique[i+4]+4 then v_straight:=v_unique[i]; exit; end if;
    end loop;
  end if;
  select jsonb_agg(jsonb_build_array(rank,cnt) order by cnt desc,rank desc) into v_groups
  from (select (c->>'rank')::integer rank,count(*)::integer cnt from jsonb_array_elements(p_cards)c group by 1)q;
  g0:=(v_groups->0->>0)::integer; g0c:=(v_groups->0->>1)::integer;
  g1:=coalesce((v_groups->1->>0)::integer,0); g1c:=coalesce((v_groups->1->>1)::integer,0);
  if v_flush and v_straight>0 then v_level:=9;v_name:='同花顺';v_values:=array[v_straight];
  elsif g0c=4 then v_level:=8;v_name:='四条';v_values:=array[g0,g1];
  elsif g0c=3 and g1c=2 then v_level:=7;v_name:='葫芦';v_values:=array[g0,g1];
  elsif v_flush then v_level:=6;v_name:='同花';v_values:=v_ranks;
  elsif v_straight>0 then v_level:=5;v_name:='顺子';v_values:=array[v_straight];
  elsif g0c=3 then
    v_level:=4;v_name:='三条';
    select array[g0]||array_agg(rank order by rank desc) into v_values from (select (x->>0)::integer rank from jsonb_array_elements(v_groups)x where (x->>1)::integer=1)q;
  else
    select array_agg((x->>0)::integer order by (x->>0)::integer desc) into v_pairs from jsonb_array_elements(v_groups)x where (x->>1)::integer=2;
    if cardinality(v_pairs)=2 then
      v_level:=3;v_name:='两对';
      select v_pairs||array_agg((x->>0)::integer) into v_values from jsonb_array_elements(v_groups)x where (x->>1)::integer=1;
    elsif cardinality(v_pairs)=1 then
      v_level:=2;v_name:='一对';
      select v_pairs||array_agg((x->>0)::integer order by (x->>0)::integer desc) into v_values from jsonb_array_elements(v_groups)x where (x->>1)::integer=1;
    else v_level:=1;v_name:='高牌';v_values:=v_ranks;
    end if;
  end if;
  return jsonb_build_object('level',v_level,'name',v_name,'values',to_jsonb(v_values),'cards',p_cards);
end;
$$;

create or replace function public._texas_sb_eval_hand(p_hole jsonb,p_board jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  with cards as (
    select row_number() over ()::integer i,value card from jsonb_array_elements(p_hole||p_board)
  ), combos as (
    select jsonb_build_array(a.card,b.card,c.card,d.card,e.card) cards
    from cards a join cards b on b.i>a.i join cards c on c.i>b.i join cards d on d.i>c.i join cards e on e.i>d.i
  ), evaluated as (select public._texas_sb_eval_five(cards) value from combos)
  select value from evaluated order by (value->>'level')::integer desc,value->'values' desc limit 1;
$$;

create or replace function public._texas_sb_allowed(p_room uuid,p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype;
  v_call bigint; v_max bigint; v_min bigint; v_actions jsonb:='["fold"]'::jsonb;
begin
  select * into r from public.texas_sb_rooms where id=p_room;
  select * into p from public.texas_sb_players where room_id=p_room and user_id=p_uid and not left_room limit 1;
  if not found or r.status not in ('preflop','flop','turn','river') or p.folded or p.all_in or not p.in_hand or p.pending_leave or r.current_turn<>p.seat then
    return jsonb_build_object('actions','[]'::jsonb,'toCall',0,'minRaiseTo',0,'maxRaiseTo',0);
  end if;
  v_call:=greatest(0,r.current_bet-p.street_bet); v_max:=p.street_bet+p.stack; v_min:=r.current_bet+r.min_raise;
  v_actions:=v_actions||case when v_call=0 then '["check"]'::jsonb else '["call"]'::jsonb end;
  if p.stack>0 then v_actions:=v_actions||'["all_in"]'::jsonb; end if;
  if r.current_bet=0 and v_max>=r.big_blind then v_actions:=v_actions||'["bet"]'::jsonb; end if;
  if r.current_bet>0 and p.can_raise and v_max>=v_min then v_actions:=v_actions||'["raise"]'::jsonb; end if;
  return jsonb_build_object('actions',v_actions,'toCall',v_call,'minRaiseTo',v_min,'maxRaiseTo',v_max);
end;
$$;

create or replace function public._texas_sb_can_view_room(p_room uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from public.texas_sb_rooms r
    where r.id=p_room and (
      r.host_user_id=auth.uid()
      or exists(select 1 from public.texas_sb_players p where p.room_id=r.id and p.user_id=auth.uid() and not p.left_room)
      or exists(select 1 from public.texas_sb_spectators s where s.room_id=r.id and s.user_id=auth.uid())
    )
  );
$$;

create or replace function public.texas_sb_bootstrap(p_nickname text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_name text;
begin
  v_name:=nullif(trim(p_nickname),'');
  if v_name is not null and char_length(v_name)>24 then raise exception 'NICKNAME_TOO_LONG'; end if;
  insert into public.texas_sb_profiles(user_id,nickname)
  values(v_uid,coalesce(v_name,'玩家'||right(replace(v_uid::text,'-',''),6)))
  on conflict(user_id) do update set nickname=coalesce(v_name,public.texas_sb_profiles.nickname);
  return (select jsonb_build_object('id',user_id,'nickname',nickname,'beans',beans,'wins',wins,'losses',losses) from public.texas_sb_profiles where user_id=v_uid);
end;
$$;

create or replace function public.texas_sb_me()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p.user_id,'nickname',p.nickname,'beans',p.beans,'wins',p.wins,'losses',p.losses)
  from public.texas_sb_profiles p where p.user_id=public._texas_sb_uid();
$$;

create or replace function public.texas_sb_list_rooms()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'code',r.code,'status',r.status,'playerCount',coalesce(c.n,0),'maxPlayers',r.max_players,
    'smallBlind',r.small_blind,'bigBlind',r.big_blind,'minBuyIn',r.min_buy_in,'maxBuyIn',r.max_buy_in,
    'allowSpectators',r.allow_spectators,'hostNickname',coalesce(h.nickname,'等待房主')
  ) order by r.updated_at desc),'[]'::jsonb)
  from public.texas_sb_rooms r
  left join (select room_id,count(*) n from public.texas_sb_players where not left_room group by room_id)c on c.room_id=r.id
  left join public.texas_sb_profiles h on h.user_id=r.host_user_id
  where r.is_public and r.status<>'closed' and coalesce(c.n,0)>0;
$$;

create or replace function public.texas_sb_snapshot(p_room text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype;
  v_player public.texas_sb_players%rowtype; v_spectator boolean; v_players jsonb; v_events jsonb; v_pots jsonb;
begin
  select * into r from public.texas_sb_rooms where id=v_room;
  select * into v_player from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room limit 1;
  v_spectator:=exists(select 1 from public.texas_sb_spectators where room_id=v_room and user_id=v_uid);
  if v_player.id is null and not v_spectator then raise exception 'ROOM_ACCESS_REQUIRED'; end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',p.id,'userId',p.user_id,'nickname',pr.nickname,'seat',p.seat,'stack',p.stack,'inHand',p.in_hand,
    'waiting',p.waiting,'folded',p.folded,'allIn',p.all_in,'pendingLeave',p.pending_leave,
    'streetBet',p.street_bet,'totalContribution',p.total_contribution,'actionSeq',p.action_seq,'lastAction',p.last_action,
    'holeCards',case when h.id is not null and (p.user_id=v_uid or (r.status='settled' and not p.folded) or (v_spectator and r.spectator_cards)) then hc.cards end,
    'handType',case when h.id is not null and hc.evaluation is not null and (p.user_id=v_uid or (r.status='settled' and not p.folded) or (v_spectator and r.spectator_cards)) then hc.evaluation->>'name' end
  )) order by p.seat),'[]'::jsonb) into v_players
  from public.texas_sb_players p join public.texas_sb_profiles pr on pr.user_id=p.user_id
  left join public.texas_sb_hands h on h.id=r.hand_id left join public.texas_sb_hole_cards hc on hc.hand_id=h.id and hc.user_id=p.user_id
  where p.room_id=v_room and not p.left_room;

  select coalesce(jsonb_agg(jsonb_build_object('amount',amount,'eligiblePlayerIds',eligible_user_ids,'winnerIds',winner_user_ids) order by pot_index),'[]'::jsonb)
    into v_pots from public.texas_sb_pots where hand_id=r.hand_id;
  select coalesce(jsonb_agg(x.value order by (x.value->>'id')::bigint),'[]'::jsonb) into v_events from (
    select jsonb_build_object('id',e.id,'roomId',e.room_id,'handId',e.hand_id,'eventType',e.event_type,'payload',e.payload,'createdAt',e.created_at) value
    from public.texas_sb_events e where e.room_id=v_room order by e.id desc limit 30
  )x;

  return jsonb_build_object(
    'id',r.id,'code',r.code,'status',r.status,'hostUserId',r.host_user_id,'version',r.version,
    'isPublic',r.is_public,'allowSpectators',r.allow_spectators,'spectatorCards',r.spectator_cards,'isSpectator',v_spectator,
    'smallBlind',r.small_blind,'bigBlind',r.big_blind,'minBuyIn',r.min_buy_in,'maxBuyIn',r.max_buy_in,'maxPlayers',r.max_players,
    'dealerSeat',r.dealer_seat,'currentTurn',r.current_turn,'currentBet',r.current_bet,'minRaise',r.min_raise,
    'pot',case when r.status='settled' then coalesce((select sum(amount) from public.texas_sb_pots where hand_id=r.hand_id),0) else r.pot end,
    'pots',v_pots,'board',r.board,'handNumber',r.hand_number,'handId',r.hand_id,'players',v_players,
    'allowedActions',case when v_player.id is null then jsonb_build_object('actions','[]'::jsonb,'toCall',0,'minRaiseTo',0,'maxRaiseTo',0) else public._texas_sb_allowed(v_room,v_uid) end,
    'recentEvents',v_events
  );
end;
$$;

create or replace function public.texas_sb_create_room(
  p_small_blind bigint default 10,p_big_blind bigint default 20,p_buy_in bigint default 1000,
  p_max_players integer default 9,p_allow_spectators boolean default false,p_spectator_cards boolean default false,p_is_public boolean default true
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid; v_profile public.texas_sb_profiles%rowtype;
  v_min bigint; v_max bigint; v_seat integer:=0;
begin
  perform public.texas_sb_bootstrap(null);
  if exists(select 1 from public.texas_sb_players where user_id=v_uid and not left_room) then raise exception 'ALREADY_IN_ROOM'; end if;
  p_small_blind:=greatest(1,coalesce(p_small_blind,10)); p_big_blind:=greatest(p_small_blind*2,coalesce(p_big_blind,20));
  v_min:=p_big_blind*20; v_max:=p_big_blind*100; p_max_players:=least(9,greatest(2,coalesce(p_max_players,9)));
  if p_buy_in<v_min or p_buy_in>v_max then raise exception 'BUY_IN_RANGE:%-%',v_min,v_max; end if;
  select * into v_profile from public.texas_sb_profiles where user_id=v_uid for update;
  if v_profile.beans<p_buy_in then raise exception 'INSUFFICIENT_BEANS'; end if;
  insert into public.texas_sb_rooms(code,host_user_id,small_blind,big_blind,min_buy_in,max_buy_in,max_players,min_raise,is_public,allow_spectators,spectator_cards)
  values(public._texas_sb_gen_code(),v_uid,p_small_blind,p_big_blind,v_min,v_max,p_max_players,p_big_blind,coalesce(p_is_public,true),coalesce(p_allow_spectators,false),coalesce(p_spectator_cards,false) and coalesce(p_allow_spectators,false))
  returning id into v_room;
  update public.texas_sb_profiles set beans=beans-p_buy_in where user_id=v_uid;
  insert into public.texas_sb_players(room_id,user_id,seat,stack,buy_in,waiting) values(v_room,v_uid,v_seat,p_buy_in,p_buy_in,true);
  perform public._texas_sb_event(v_room,'texas_room_created',jsonb_build_object('code',(select code from public.texas_sb_rooms where id=v_room),'hostNickname',v_profile.nickname),v_uid);
  perform public._texas_sb_event(v_room,'texas_player_joined',jsonb_build_object('userId',v_uid,'nickname',v_profile.nickname,'seat',v_seat,'waiting',false),v_uid);
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public.texas_sb_join_room(p_room text,p_buy_in bigint default 1000)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype;
  v_profile public.texas_sb_profiles%rowtype; v_seat integer; v_waiting boolean;
begin
  perform public.texas_sb_bootstrap(null); select * into r from public.texas_sb_rooms where id=v_room for update;
  if r.status='closed' then raise exception 'ROOM_CLOSED'; end if;
  if exists(select 1 from public.texas_sb_players where user_id=v_uid and not left_room) then
    if exists(select 1 from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room) then return public.texas_sb_snapshot(v_room::text); end if;
    raise exception 'ALREADY_IN_OTHER_ROOM';
  end if;
  if (select count(*) from public.texas_sb_players where room_id=v_room and not left_room)>=r.max_players then raise exception 'ROOM_FULL'; end if;
  if p_buy_in<r.min_buy_in or p_buy_in>r.max_buy_in then raise exception 'BUY_IN_RANGE:%-%',r.min_buy_in,r.max_buy_in; end if;
  select * into v_profile from public.texas_sb_profiles where user_id=v_uid for update;
  if v_profile.beans<p_buy_in then raise exception 'INSUFFICIENT_BEANS'; end if;
  select s into v_seat from generate_series(0,r.max_players-1)s where not exists(select 1 from public.texas_sb_players p where p.room_id=v_room and p.seat=s and not p.left_room) order by s limit 1;
  v_waiting:=r.status in ('preflop','flop','turn','river','showdown');
  update public.texas_sb_profiles set beans=beans-p_buy_in where user_id=v_uid;
  insert into public.texas_sb_players(room_id,user_id,seat,stack,buy_in,waiting) values(v_room,v_uid,v_seat,p_buy_in,p_buy_in,v_waiting);
  delete from public.texas_sb_spectators where room_id=v_room and user_id=v_uid;
  perform public._texas_sb_event(v_room,'texas_player_joined',jsonb_build_object('userId',v_uid,'nickname',v_profile.nickname,'seat',v_seat,'waiting',v_waiting),v_uid);
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public.texas_sb_rebuy(p_room text,p_amount bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype; v_beans bigint;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  if r.status not in ('waiting','settled') then raise exception 'REBUY_BETWEEN_HANDS_ONLY'; end if;
  select * into p from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room for update;
  if p.id is null then raise exception 'PLAYER_NOT_IN_ROOM'; end if;
  if p_amount<=0 or p.stack+p_amount>r.max_buy_in then raise exception 'INVALID_REBUY'; end if;
  select beans into v_beans from public.texas_sb_profiles where user_id=v_uid for update;
  if v_beans<p_amount then raise exception 'INSUFFICIENT_BEANS'; end if;
  update public.texas_sb_profiles set beans=beans-p_amount where user_id=v_uid;
  update public.texas_sb_players set stack=stack+p_amount where id=p.id;
  perform public._texas_sb_event(v_room,'texas_player_rebuy',jsonb_build_object('userId',v_uid,'amount',p_amount,'stack',p.stack+p_amount),v_uid);
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public.texas_sb_update_settings(p_room text,p_allow_spectators boolean,p_spectator_cards boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  if r.host_user_id<>v_uid then raise exception 'HOST_ONLY'; end if;
  update public.texas_sb_rooms set allow_spectators=coalesce(p_allow_spectators,false),spectator_cards=coalesce(p_spectator_cards,false) and coalesce(p_allow_spectators,false),version=version+1,updated_at=now() where id=v_room;
  if not coalesce(p_allow_spectators,false) then delete from public.texas_sb_spectators where room_id=v_room; end if;
  perform public._texas_sb_event(v_room,'texas_room_settings',jsonb_build_object('allowSpectators',p_allow_spectators,'spectatorCards',p_spectator_cards),v_uid);
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public._texas_sb_reveal(p_room uuid,p_street text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.texas_sb_rooms%rowtype; h public.texas_sb_hands%rowtype; v_count integer; v_pos integer; v_cards jsonb:='[]'::jsonb; i integer; v_turn integer;
begin
  select * into r from public.texas_sb_rooms where id=p_room for update;
  select * into h from public.texas_sb_hands where id=r.hand_id for update;
  v_count:=case when p_street='flop' then 3 else 1 end; v_pos:=h.deck_pos+1;
  for i in 0..v_count-1 loop v_cards:=v_cards||jsonb_build_array(h.deck->(v_pos+i)); end loop;
  update public.texas_sb_hands set deck_pos=v_pos+v_count,board=board||v_cards,status=p_street where id=h.id;
  update public.texas_sb_players set street_bet=0,acted=false,can_raise=true where room_id=p_room and in_hand and not left_room;
  v_turn:=public._texas_sb_next_seat(p_room,r.dealer_seat,true);
  update public.texas_sb_rooms set status=p_street,board=board||v_cards,current_bet=0,min_raise=big_blind,current_turn=v_turn where id=p_room;
  perform public._texas_sb_event(p_room,p_street||'_dealt',jsonb_build_object('board',(select board from public.texas_sb_rooms where id=p_room)));
end;
$$;

create or replace function public._texas_sb_settle(p_room uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype; v_level bigint; v_prev bigint:=0; v_amount bigint;
  v_best jsonb; v_eligible jsonb; v_winners jsonb; v_winner uuid; v_share bigint; v_remainder integer; v_index integer:=0;
  v_results jsonb; v_active integer;
begin
  select * into r from public.texas_sb_rooms where id=p_room for update;
  if r.status='settled' or r.hand_id is null then return; end if;

  if jsonb_array_length(r.board)=5 then
    for p in select * from public.texas_sb_players where room_id=p_room and in_hand and not folded and not left_room loop
      update public.texas_sb_hole_cards hc set evaluation=public._texas_sb_eval_hand(hc.cards,r.board)
        where hc.hand_id=r.hand_id and hc.user_id=p.user_id;
    end loop;
  end if;
  update public.texas_sb_players set payout=0 where room_id=p_room and in_hand;
  delete from public.texas_sb_pots where hand_id=r.hand_id;

  for v_level in select distinct total_contribution from public.texas_sb_players where room_id=p_room and in_hand and total_contribution>0 order by total_contribution loop
    select (v_level-v_prev)*count(*) into v_amount from public.texas_sb_players where room_id=p_room and in_hand and total_contribution>=v_level;
    v_prev:=v_level; if v_amount<=0 then continue; end if;
    select coalesce(jsonb_agg(user_id),'[]'::jsonb) into v_eligible from public.texas_sb_players
      where room_id=p_room and in_hand and total_contribution>=v_level and not folded;
    if jsonb_array_length(v_eligible)=0 then
      -- An unmatched contribution is returned to the contributor instead of disappearing.
      select coalesce(jsonb_agg(user_id order by seat),'[]'::jsonb) into v_winners
        from public.texas_sb_players where room_id=p_room and in_hand and total_contribution>=v_level;
      v_eligible:=v_winners;
    elsif jsonb_array_length(v_eligible)=1 then
      -- An uncontested pot does not require five community cards or a hand evaluation.
      v_winners:=v_eligible;
    else
      select hc.evaluation into v_best from public.texas_sb_players pp join public.texas_sb_hole_cards hc on hc.hand_id=r.hand_id and hc.user_id=pp.user_id
        where pp.room_id=p_room and pp.in_hand and pp.total_contribution>=v_level and not pp.folded
        order by (hc.evaluation->>'level')::integer desc,hc.evaluation->'values' desc limit 1;
      select jsonb_agg(pp.user_id order by case when mod(pp.seat-r.dealer_seat+9,9)=0 then 9 else mod(pp.seat-r.dealer_seat+9,9) end)
        into v_winners from public.texas_sb_players pp join public.texas_sb_hole_cards hc on hc.hand_id=r.hand_id and hc.user_id=pp.user_id
        where pp.room_id=p_room and pp.in_hand and pp.total_contribution>=v_level and not pp.folded
          and (hc.evaluation->>'level')::integer=(v_best->>'level')::integer and hc.evaluation->'values'=v_best->'values';
    end if;
    v_share:=v_amount/jsonb_array_length(v_winners); v_remainder:=mod(v_amount,jsonb_array_length(v_winners));
    for v_winner in select value::text::uuid from jsonb_array_elements_text(v_winners) loop
      update public.texas_sb_players set stack=stack+v_share+case when v_remainder>0 then 1 else 0 end,payout=payout+v_share+case when v_remainder>0 then 1 else 0 end
        where room_id=p_room and user_id=v_winner and not left_room;
      if v_remainder>0 then v_remainder:=v_remainder-1; end if;
    end loop;
    insert into public.texas_sb_pots(hand_id,pot_index,amount,eligible_user_ids,winner_user_ids) values(r.hand_id,v_index,v_amount,v_eligible,v_winners);
    v_index:=v_index+1;
  end loop;

  for p in select * from public.texas_sb_players where room_id=p_room and in_hand loop
    if p.payout-p.total_contribution>0 then update public.texas_sb_profiles set wins=wins+1 where user_id=p.user_id;
    elsif p.payout-p.total_contribution<0 then update public.texas_sb_profiles set losses=losses+1 where user_id=p.user_id; end if;
  end loop;
  update public.texas_sb_hands set status='settled',settled_at=now(),board=r.board where id=r.hand_id;
  update public.texas_sb_rooms set status='settled',current_turn=-1,current_bet=0,pot=0 where id=p_room;
  select coalesce(jsonb_agg(jsonb_build_object('userId',pp.user_id,'nickname',pr.nickname,'seat',pp.seat,'payout',pp.payout,
    'net',pp.payout-pp.total_contribution,'folded',pp.folded,'handType',hc.evaluation->>'name') order by pp.seat),'[]'::jsonb)
    into v_results from public.texas_sb_players pp join public.texas_sb_profiles pr on pr.user_id=pp.user_id
    left join public.texas_sb_hole_cards hc on hc.hand_id=r.hand_id and hc.user_id=pp.user_id where pp.room_id=p_room and pp.in_hand;
  perform public._texas_sb_event(p_room,'texas_hand_settled',jsonb_build_object('handId',r.hand_id,'board',r.board,'players',v_results));

  for p in select * from public.texas_sb_players where room_id=p_room and pending_leave and not left_room for update loop
    update public.texas_sb_profiles set beans=beans+p.stack where user_id=p.user_id;
    update public.texas_sb_players set stack=0,left_room=true,pending_leave=false,in_hand=false where id=p.id;
  end loop;
  if not exists(select 1 from public.texas_sb_players where room_id=p_room and not left_room and user_id=r.host_user_id) then
    update public.texas_sb_rooms set host_user_id=(select user_id from public.texas_sb_players where room_id=p_room and not left_room order by joined_at limit 1) where id=p_room;
  end if;
  select count(*) into v_active from public.texas_sb_players where room_id=p_room and not left_room;
  if v_active=0 then update public.texas_sb_rooms set status='closed',host_user_id=null where id=p_room; end if;
end;
$$;

create or replace function public._texas_sb_runout_settle(p_room uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_len integer;
begin
  loop
    select jsonb_array_length(board) into v_len from public.texas_sb_rooms where id=p_room;
    exit when v_len>=5;
    perform public._texas_sb_reveal(p_room,case when v_len=0 then 'flop' when v_len=3 then 'turn' else 'river' end);
  end loop;
  perform public._texas_sb_settle(p_room);
end;
$$;

create or replace function public._texas_sb_progress(p_room uuid,p_from integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.texas_sb_rooms%rowtype; v_count integer; v_actionable integer; v_complete boolean; v_next text;
begin
  select * into r from public.texas_sb_rooms where id=p_room for update;
  select count(*) into v_count from public.texas_sb_players where room_id=p_room and in_hand and not folded and not left_room;
  if v_count<=1 then perform public._texas_sb_settle(p_room); return; end if;
  select count(*) into v_actionable from public.texas_sb_players where room_id=p_room and in_hand and not folded and not all_in and not pending_leave and not left_room;
  if v_actionable=0 then perform public._texas_sb_runout_settle(p_room); return; end if;
  if v_actionable=1 and exists(
    select 1 from public.texas_sb_players
    where room_id=p_room and in_hand and not folded and not all_in and not pending_leave and not left_room
      and street_bet=r.current_bet
  ) then
    perform public._texas_sb_runout_settle(p_room); return;
  end if;
  select bool_and(acted and street_bet=r.current_bet) into v_complete from public.texas_sb_players where room_id=p_room and in_hand and not folded and not all_in and not pending_leave and not left_room;
  if v_complete then
    if r.status='river' then perform public._texas_sb_settle(p_room); return; end if;
    v_next:=case when r.status='preflop' then 'flop' when r.status='flop' then 'turn' else 'river' end;
    perform public._texas_sb_reveal(p_room,v_next);
    select count(*) into v_actionable from public.texas_sb_players where room_id=p_room and in_hand and not folded and not all_in and not pending_leave and not left_room;
    if v_actionable<=1 then perform public._texas_sb_runout_settle(p_room); end if;
  else update public.texas_sb_rooms set current_turn=public._texas_sb_next_seat(p_room,p_from,true) where id=p_room;
  end if;
end;
$$;

create or replace function public.texas_sb_start_hand(p_room text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype;
  v_hand uuid; v_deck jsonb; v_pos integer:=0; v_round integer; p public.texas_sb_players%rowtype; v_count integer;
  v_small integer; v_big integer; v_first integer; v_small_paid bigint; v_big_paid bigint;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  if r.host_user_id<>v_uid then raise exception 'HOST_ONLY'; end if;
  if r.status not in ('waiting','settled') then raise exception 'HAND_NOT_READY'; end if;
  select count(*) into v_count from public.texas_sb_players where room_id=v_room and not left_room and stack>0;
  if v_count<2 then raise exception 'NEED_TWO_PLAYERS'; end if;
  if r.dealer_seat is null then select min(seat) into r.dealer_seat from public.texas_sb_players where room_id=v_room and not left_room and stack>0;
  else select coalesce((select seat from public.texas_sb_players where room_id=v_room and not left_room and stack>0 and seat>r.dealer_seat order by seat limit 1),(select min(seat) from public.texas_sb_players where room_id=v_room and not left_room and stack>0)) into r.dealer_seat; end if;
  select jsonb_agg(jsonb_build_object('rank',rank,'suit',suit) order by random()) into v_deck
    from generate_series(2,14)rank cross join unnest(array['S','H','C','D'])suit;
  insert into public.texas_sb_hands(room_id,hand_number,status,dealer_seat,deck) values(v_room,r.hand_number+1,'preflop',r.dealer_seat,v_deck) returning id into v_hand;
  update public.texas_sb_players set in_hand=stack>0,waiting=stack<=0,folded=false,all_in=false,acted=false,can_raise=true,street_bet=0,total_contribution=0,payout=0,action_seq=0,last_action=null,pending_leave=false where room_id=v_room and not left_room;
  insert into public.texas_sb_hole_cards(hand_id,user_id,cards)
    select v_hand,user_id,'[null,null]'::jsonb from public.texas_sb_players where room_id=v_room and in_hand and not left_room;
  for v_round in 1..2 loop
    for p in select * from public.texas_sb_players where room_id=v_room and in_hand and not left_room order by seat loop
      update public.texas_sb_hole_cards set cards=jsonb_set(cards,array[(v_round-1)::text],v_deck->v_pos,false) where hand_id=v_hand and user_id=p.user_id; v_pos:=v_pos+1;
    end loop;
  end loop;
  update public.texas_sb_hands set deck_pos=v_pos where id=v_hand;
  if v_count=2 then v_small:=r.dealer_seat;v_big:=public._texas_sb_next_seat(v_room,v_small,false);
  else v_small:=public._texas_sb_next_seat(v_room,r.dealer_seat,false);v_big:=public._texas_sb_next_seat(v_room,v_small,false); end if;
  select least(stack,r.small_blind) into v_small_paid from public.texas_sb_players where room_id=v_room and seat=v_small and not left_room;
  update public.texas_sb_players set stack=stack-v_small_paid,street_bet=v_small_paid,total_contribution=v_small_paid,all_in=stack-v_small_paid=0 where room_id=v_room and seat=v_small and not left_room;
  select least(stack,r.big_blind) into v_big_paid from public.texas_sb_players where room_id=v_room and seat=v_big and not left_room;
  update public.texas_sb_players set stack=stack-v_big_paid,street_bet=v_big_paid,total_contribution=v_big_paid,all_in=stack-v_big_paid=0 where room_id=v_room and seat=v_big and not left_room;
  v_first:=public._texas_sb_next_seat(v_room,v_big,true);
  update public.texas_sb_rooms set status='preflop',dealer_seat=r.dealer_seat,current_turn=v_first,current_bet=r.big_blind,min_raise=r.big_blind,
    hand_number=r.hand_number+1,hand_id=v_hand,board='[]'::jsonb,pot=v_small_paid+v_big_paid where id=v_room;
  perform public._texas_sb_event(v_room,'texas_hand_started',jsonb_build_object('handId',v_hand,'handNumber',r.hand_number+1,'dealerSeat',r.dealer_seat,'smallBlindSeat',v_small,'bigBlindSeat',v_big));
  perform public._texas_sb_event(v_room,'texas_blinds_posted',jsonb_build_object('smallBlind',jsonb_build_object('seat',v_small,'amount',v_small_paid),'bigBlind',jsonb_build_object('seat',v_big,'amount',v_big_paid)));
  if not exists(select 1 from public.texas_sb_players where room_id=v_room and in_hand and not folded and not all_in and not pending_leave and not left_room) then perform public._texas_sb_runout_settle(v_room); end if;
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public.texas_sb_action(
  p_room text,p_type text,p_amount bigint default null,p_expected_version bigint default null,
  p_action_seq integer default null,p_client_action_id text default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype;
  v_allowed jsonb; v_call bigint; v_old bigint; v_target bigint; v_paid bigint:=0; v_increase bigint; v_full boolean:=false; v_allin boolean;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  if r.status not in ('preflop','flop','turn','river') then raise exception 'ACTION_NOT_ALLOWED'; end if;
  if p_client_action_id is null or char_length(p_client_action_id)<8 then raise exception 'CLIENT_ACTION_ID_REQUIRED'; end if;
  if exists(select 1 from public.texas_sb_client_actions where client_action_id=p_client_action_id and user_id=v_uid) then return public.texas_sb_snapshot(v_room::text); end if;
  if p_expected_version is not null and p_expected_version<>r.version then raise exception 'STALE_ROOM_VERSION'; end if;
  select * into p from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room and in_hand for update;
  if p.id is null then raise exception 'PLAYER_NOT_IN_HAND'; end if;
  if p_action_seq is null or p_action_seq<>p.action_seq+1 then raise exception 'INVALID_ACTION_SEQUENCE'; end if;
  if r.current_turn<>p.seat then raise exception 'NOT_YOUR_TURN'; end if;
  v_allowed:=public._texas_sb_allowed(v_room,v_uid);
  if not (v_allowed->'actions' ? p_type) then raise exception 'ACTION_NOT_ALLOWED'; end if;
  v_call:=(v_allowed->>'toCall')::bigint; v_old:=r.current_bet;

  if p_type='fold' then update public.texas_sb_players set folded=true,last_action=p_type,action_seq=p_action_seq where id=p.id;
  elsif p_type='check' then update public.texas_sb_players set acted=true,last_action=p_type,action_seq=p_action_seq where id=p.id;
  elsif p_type='call' then
    v_paid:=least(v_call,p.stack);
    update public.texas_sb_players set stack=stack-v_paid,street_bet=street_bet+v_paid,total_contribution=total_contribution+v_paid,
      all_in=stack-v_paid=0,acted=true,last_action=p_type,action_seq=p_action_seq where id=p.id;
    update public.texas_sb_rooms set pot=pot+v_paid where id=v_room;
  else
    v_target:=case when p_type='all_in' then p.street_bet+p.stack else p_amount end;
    if v_target is null or v_target<=p.street_bet or v_target>p.street_bet+p.stack then raise exception 'INVALID_BET_AMOUNT'; end if;
    v_increase:=v_target-v_old; v_allin:=v_target=p.street_bet+p.stack;
    if p_type='bet' and v_old<>0 then raise exception 'USE_RAISE'; end if;
    if p_type='raise' and v_old=0 then raise exception 'USE_BET'; end if;
    if v_old=0 and v_target<r.big_blind and not v_allin then raise exception 'MIN_BET:%',r.big_blind; end if;
    if v_old>0 and v_increase<r.min_raise and not v_allin then raise exception 'MIN_RAISE_TO:%',v_old+r.min_raise; end if;
    v_paid:=v_target-p.street_bet;
    update public.texas_sb_players set stack=stack-v_paid,street_bet=v_target,total_contribution=total_contribution+v_paid,
      all_in=stack-v_paid=0,acted=true,last_action=p_type,action_seq=p_action_seq where id=p.id;
    update public.texas_sb_rooms set pot=pot+v_paid where id=v_room;
    if v_target>v_old then
      v_full:=case when v_old=0 then v_target>=r.big_blind else v_increase>=r.min_raise end;
      update public.texas_sb_rooms set current_bet=v_target,min_raise=case when v_full then case when v_old=0 then v_target else v_increase end else min_raise end where id=v_room;
      if v_full then update public.texas_sb_players set acted=false,can_raise=true where room_id=v_room and in_hand and not folded and not all_in and not pending_leave and not left_room and id<>p.id;
      else update public.texas_sb_players set can_raise=false where room_id=v_room and in_hand and not folded and not all_in and not pending_leave and not left_room and acted and id<>p.id; end if;
    end if;
  end if;
  insert into public.texas_sb_client_actions(client_action_id,room_id,hand_id,user_id) values(p_client_action_id,v_room,r.hand_id,v_uid);
  perform public._texas_sb_event(v_room,'texas_player_action',jsonb_build_object('userId',v_uid,'nickname',(select nickname from public.texas_sb_profiles where user_id=v_uid),
    'seat',p.seat,'action',p_type,'paid',v_paid,'streetBet',(select street_bet from public.texas_sb_players where id=p.id),'fullRaise',v_full),v_uid);
  perform public._texas_sb_progress(v_room,p.seat);
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return public.texas_sb_snapshot(v_room::text);
end;
$$;

create or replace function public.texas_sb_leave_room(p_room text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype; v_next uuid;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  delete from public.texas_sb_spectators where room_id=v_room and user_id=v_uid;
  select * into p from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room for update;
  if p.id is not null then
    if p.in_hand and r.status in ('preflop','flop','turn','river') then
      update public.texas_sb_players set folded=true,pending_leave=true,last_action='leave' where id=p.id;
      perform public._texas_sb_event(v_room,'texas_player_left',jsonb_build_object('userId',v_uid,'seat',p.seat,'pending',true),v_uid);
      if r.current_turn=p.seat then
        perform public._texas_sb_progress(v_room,p.seat);
      elsif (select count(*) from public.texas_sb_players where room_id=v_room and in_hand and not folded and not left_room)<=1 then
        perform public._texas_sb_settle(v_room);
      end if;
    else
      update public.texas_sb_profiles set beans=beans+p.stack where user_id=v_uid;
      update public.texas_sb_players set stack=0,left_room=true,in_hand=false,pending_leave=false where id=p.id;
      perform public._texas_sb_event(v_room,'texas_player_left',jsonb_build_object('userId',v_uid,'seat',p.seat,'returned',p.stack),v_uid);
    end if;
  end if;
  if r.host_user_id=v_uid then
    select user_id into v_next from public.texas_sb_players where room_id=v_room and not left_room and not pending_leave and user_id<>v_uid order by joined_at limit 1;
    update public.texas_sb_rooms set host_user_id=v_next where id=v_room;
  end if;
  if not exists(select 1 from public.texas_sb_players where room_id=v_room and not left_room and not pending_leave) then update public.texas_sb_rooms set status='closed',host_user_id=null where id=v_room; end if;
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  return jsonb_build_object('left',true,'roomId',v_room);
end;
$$;

create or replace function public.texas_sb_spectate(p_room text,p_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid(); v_room uuid:=public._texas_sb_room_id(p_room); r public.texas_sb_rooms%rowtype; p public.texas_sb_players%rowtype; v_next uuid;
begin
  select * into r from public.texas_sb_rooms where id=v_room for update;
  if coalesce(p_enabled,true) then
    if r.status='closed' then raise exception 'ROOM_CLOSED'; end if; if not r.allow_spectators then raise exception 'SPECTATORS_DISABLED'; end if;
    select * into p from public.texas_sb_players where room_id=v_room and user_id=v_uid and not left_room for update;
    if p.id is not null then
      if p.in_hand and r.status in ('preflop','flop','turn','river') then raise exception 'CANNOT_SPECTATE_DURING_HAND'; end if;
      update public.texas_sb_profiles set beans=beans+p.stack where user_id=v_uid;
      update public.texas_sb_players set stack=0,left_room=true,in_hand=false where id=p.id;
      if r.host_user_id=v_uid then
        select user_id into v_next from public.texas_sb_players where room_id=v_room and not left_room and user_id<>v_uid order by joined_at limit 1;
        update public.texas_sb_rooms set host_user_id=v_next where id=v_room;
      end if;
    end if;
    insert into public.texas_sb_spectators(room_id,user_id) values(v_room,v_uid) on conflict do nothing;
    perform public._texas_sb_event(v_room,'texas_spectator_joined',jsonb_build_object('userId',v_uid),v_uid);
  else
    delete from public.texas_sb_spectators where room_id=v_room and user_id=v_uid;
    perform public._texas_sb_event(v_room,'texas_spectator_left',jsonb_build_object('userId',v_uid),v_uid);
  end if;
  if not exists(select 1 from public.texas_sb_players where room_id=v_room and not left_room) then
    update public.texas_sb_rooms set status='closed',host_user_id=null where id=v_room;
  end if;
  update public.texas_sb_rooms set version=version+1,updated_at=now() where id=v_room;
  if coalesce(p_enabled,true) then return public.texas_sb_snapshot(v_room::text); end if;
  return jsonb_build_object('left',true,'roomId',v_room);
end;
$$;

create or replace function public.texas_sb_refill()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=public._texas_sb_uid();
begin
  update public.texas_sb_profiles set beans=2000
    where user_id=v_uid and beans=0
      and not exists(select 1 from public.texas_sb_players where user_id=v_uid and not left_room and stack>0);
  return public.texas_sb_me();
end;
$$;

create or replace function public.texas_sb_leaderboard(p_kind text default 'wins')
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  with ranked as (
    select row_number() over(order by case when p_kind='losses' then losses else wins end desc,beans desc,nickname) rank,
      nickname,beans,wins,losses,
      case when p_kind='losses' then '散财童子' when wins>=50 then '牌局之王' when wins>=20 then '常胜将军' else '牌桌新秀' end title
    from public.texas_sb_profiles
  ) select coalesce(jsonb_agg(jsonb_build_object('rank',rank,'nickname',nickname,'beans',beans,'wins',wins,'losses',losses,'title',title) order by rank),'[]'::jsonb)
  from (select * from ranked where rank<=100)q;
$$;

create or replace function public.cleanup_stale_texas_sb_rooms()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  update public.texas_sb_rooms set status='closed',host_user_id=null
    where status<>'closed' and updated_at<now()-interval '6 hours'
      and not exists(select 1 from public.texas_sb_players p where p.room_id=texas_sb_rooms.id and not p.left_room);
  delete from public.texas_sb_rooms where status='closed' and updated_at<now()-interval '30 days';
  get diagnostics v_count=row_count; return v_count;
end;
$$;

-- Browser roles cannot read game internals or mutate tables directly. Room rows are
-- selectable only so Supabase Realtime can authorize room-version notifications.
alter table public.texas_sb_profiles enable row level security;
alter table public.texas_sb_rooms enable row level security;
alter table public.texas_sb_players enable row level security;
alter table public.texas_sb_spectators enable row level security;
alter table public.texas_sb_hands enable row level security;
alter table public.texas_sb_hole_cards enable row level security;
alter table public.texas_sb_events enable row level security;
alter table public.texas_sb_pots enable row level security;
alter table public.texas_sb_client_actions enable row level security;

drop policy if exists texas_sb_rooms_realtime_select on public.texas_sb_rooms;
create policy texas_sb_rooms_realtime_select on public.texas_sb_rooms
  for select to authenticated using (is_public or public._texas_sb_can_view_room(id));

revoke all on table public.texas_sb_profiles,public.texas_sb_rooms,public.texas_sb_players,
  public.texas_sb_spectators,public.texas_sb_hands,public.texas_sb_hole_cards,
  public.texas_sb_events,public.texas_sb_pots,public.texas_sb_client_actions from anon,authenticated;
grant select on table public.texas_sb_rooms to authenticated;
revoke all on sequence public.texas_sb_events_id_seq from anon,authenticated;

do $security$
declare v_function record;
begin
  for v_function in
    select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'texas_sb_%' or p.proname like '\_texas\_sb\_%' escape '\')
  loop
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',v_function.nspname,v_function.proname,v_function.args);
  end loop;
end;
$security$;

grant execute on function public.texas_sb_bootstrap(text) to authenticated;
grant execute on function public.texas_sb_me() to authenticated;
grant execute on function public.texas_sb_list_rooms() to authenticated;
grant execute on function public.texas_sb_snapshot(text) to authenticated;
grant execute on function public.texas_sb_create_room(bigint,bigint,bigint,integer,boolean,boolean,boolean) to authenticated;
grant execute on function public.texas_sb_join_room(text,bigint) to authenticated;
grant execute on function public.texas_sb_rebuy(text,bigint) to authenticated;
grant execute on function public.texas_sb_update_settings(text,boolean,boolean) to authenticated;
grant execute on function public.texas_sb_start_hand(text) to authenticated;
grant execute on function public.texas_sb_action(text,text,bigint,bigint,integer,text) to authenticated;
grant execute on function public.texas_sb_leave_room(text) to authenticated;
grant execute on function public.texas_sb_spectate(text,boolean) to authenticated;
grant execute on function public.texas_sb_refill() to authenticated;
grant execute on function public.texas_sb_leaderboard(text) to authenticated;
grant execute on function public._texas_sb_can_view_room(uuid) to authenticated;
revoke all on function public.cleanup_stale_texas_sb_rooms() from public,anon,authenticated;

do $realtime$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='texas_sb_rooms'
  ) then
    alter publication supabase_realtime add table public.texas_sb_rooms;
  end if;
exception when undefined_object then
  raise notice 'supabase_realtime publication is unavailable; enable Realtime for texas_sb_rooms in the dashboard';
end;
$realtime$;

-- If pg_cron is enabled, schedule empty-room cleanup once. Active rooms are never
-- advanced, folded or closed by this job.
do $cleanup_schedule$
declare v_job_id bigint;
begin
  if to_regclass('cron.job') is not null then
    execute 'select jobid from cron.job where jobname=$1 limit 1'
      into v_job_id using 'cleanup-empty-texas-sb-rooms';
    if v_job_id is null then
      execute 'select cron.schedule($1,$2,$3)'
        into v_job_id using 'cleanup-empty-texas-sb-rooms','15 * * * *','select public.cleanup_stale_texas_sb_rooms()';
    end if;
  end if;
end;
$cleanup_schedule$;
