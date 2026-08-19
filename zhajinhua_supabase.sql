-- ============================================================
-- 炸金花联机版 · Supabase 建表脚本
-- 在 Supabase 控制台 → SQL Editor 里整段运行；新库初始化和旧库升级均可重复执行
-- ============================================================

-- ---------- 房间表 ----------
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,          -- 6位房号
  status      text not null default 'waiting', -- waiting / playing / finished
  host_seat   int  not null default 0,       -- 房主座位号
  current_turn int not null default -1,      -- 当前行动玩家座位（-1=无）
  level       int  not null default 0,       -- 当前注额（暗注单位）
  pot         int  not null default 0,       -- 底池
  round       int  not null default 0,       -- 局数（用于触发新一局）
  message     text not null default '',      -- 最近一条操作播报
  msg_seq     int  not null default 0,       -- 播报序号（递增触发实时更新）
  is_public   boolean not null default true, -- 是否出现在公开房间列表
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- 兼容已经运行过旧版脚本的数据库。
alter table public.rooms add column if not exists is_public boolean not null default true;
alter table public.rooms add column if not exists updated_at timestamptz not null default now();
drop index if exists public.idx_rooms_public_status;
create index idx_rooms_public_status
  on public.rooms(is_public, status, updated_at desc);

-- ---------- 玩家表（公共状态） ----------
create table if not exists public.players (
  id       uuid primary key default gen_random_uuid(),
  room_id  uuid not null references public.rooms(id) on delete cascade,
  user_id  uuid not null,                    -- 关联匿名登录 uid
  seat     int  not null,
  name     text not null,
  chips    int  not null default 1000,
  seen     boolean not null default false,   -- 是否看牌
  folded   boolean not null default false,   -- 是否弃牌
  bet      int  not null default 0,          -- 本轮注额（不含底注）
  total    int  not null default 0,          -- 本局总投入（含底注，用于边池）
  compare_with int not null default -1,      -- 比牌目标座位（-1=无）
  in_round boolean not null default false,   -- 是否参与当前正在进行的牌局
  all_in   boolean not null default false,   -- 是否已全押
  action_seq bigint not null default 0,      -- 玩家动作序号（过牌也会递增）
  last_action text not null default '',      -- see/call/raise/allin/compare/fold
  left_room boolean not null default false,  -- 中途退出但等待本局结算清理
  is_host  boolean not null default false,
  unique(room_id, seat)
);
-- 兼容已经运行过旧版脚本的数据库。
alter table public.players add column if not exists compare_with int not null default -1;
alter table public.players add column if not exists in_round boolean not null default false;
alter table public.players add column if not exists all_in boolean not null default false;
alter table public.players add column if not exists action_seq bigint not null default 0;
alter table public.players add column if not exists last_action text not null default '';
alter table public.players add column if not exists left_room boolean not null default false;
create index if not exists idx_players_room on public.players(room_id);
create index if not exists idx_players_user on public.players(user_id);

-- 数据库层硬限制每个房间最多 8 名未退出玩家，并用事务锁处理并发加入。
create or replace function public.enforce_zhajinhua_room_limit()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.left_room then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));
  if (
    select count(*)
    from public.players p
    where p.room_id=new.room_id
      and not p.left_room
      and p.id<>new.id
  ) >= 8 then
    raise exception 'ROOM_FULL';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zhajinhua_room_limit on public.players;
create trigger trg_zhajinhua_room_limit
before insert or update of room_id, left_room on public.players
for each row execute function public.enforce_zhajinhua_room_limit();

-- 原子开始一局：锁定房间并在同一事务中校验玩家、扣底注、写入手牌和切换状态。
create or replace function public.prepare_zhajinhua_round(
  p_room_id uuid,
  p_players jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_room rooms%rowtype;
  v_entry jsonb;
  v_player players%rowtype;
  v_ids uuid[];
  v_count integer;
  v_ante integer;
  v_pot integer := 0;
  v_turn integer := null;
  v_round integer;
begin
  if jsonb_typeof(p_players) <> 'array' then
    raise exception 'INVALID_PLAYERS';
  end if;

  select * into v_room from rooms where id=p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status not in ('waiting','finished') then
    raise exception 'ROOM_NOT_READY';
  end if;
  if not exists (
    select 1 from players
    where room_id=p_room_id and user_id=auth.uid() and is_host and not left_room
  ) then
    raise exception 'NOT_ROOM_HOST';
  end if;

  select count(*) into v_count from jsonb_array_elements(p_players);
  if v_count < 2 or v_count > 8 then raise exception 'INVALID_PLAYER_COUNT'; end if;
  v_ids := array(select (value->>'id')::uuid from jsonb_array_elements(p_players));
  if cardinality(v_ids) <> v_count
     or exists(select 1 from unnest(v_ids) as ids(id) group by id having count(*) > 1) then
    raise exception 'DUPLICATE_PLAYER';
  end if;

  -- 先锁定并完整校验所有玩家，任何人刚退出都会让整笔事务回滚。
  for v_entry in select value from jsonb_array_elements(p_players) loop
    if jsonb_typeof(v_entry->'hand') <> 'array' or jsonb_array_length(v_entry->'hand') <> 3 then
      raise exception 'INVALID_HAND';
    end if;
    select * into v_player from players
      where id=(v_entry->>'id')::uuid and room_id=p_room_id
      for update;
    if not found or v_player.left_room or v_player.chips <= 0 then
      raise exception 'PLAYER_CHANGED';
    end if;
    if v_turn is null or v_player.seat < v_turn then v_turn := v_player.seat; end if;
  end loop;

  update players set
    in_round=false, all_in=false, last_action='', action_seq=0,
    folded=false, seen=false, bet=0, total=0, compare_with=-1
  where room_id=p_room_id;
  update hands set hand=null where room_id=p_room_id;

  for v_entry in select value from jsonb_array_elements(p_players) loop
    select * into v_player from players where id=(v_entry->>'id')::uuid for update;
    v_ante := least(10, v_player.chips);
    v_pot := v_pot + v_ante;
    update players set
      chips=v_player.chips-v_ante, bet=0, total=v_ante,
      seen=false, folded=false, compare_with=-1, in_round=true,
      all_in=(v_player.chips-v_ante=0), last_action='', action_seq=0
    where id=v_player.id;
    insert into hands(player_id,user_id,room_id,hand)
    values(v_player.id,v_player.user_id,p_room_id,v_entry->'hand')
    on conflict(player_id) do update set
      user_id=excluded.user_id, room_id=excluded.room_id, hand=excluded.hand;
  end loop;

  v_round := coalesce(v_room.round,0)+1;
  update rooms set
    status='playing', current_turn=v_turn, level=1, pot=v_pot,
    round=v_round, message=''
  where id=p_room_id;
  return jsonb_build_object('status','playing','current_turn',v_turn,'level',1,
                            'pot',v_pot,'round',v_round);
end;
$$;
revoke all on function public.prepare_zhajinhua_round(uuid,jsonb) from public;
grant execute on function public.prepare_zhajinhua_round(uuid,jsonb) to anon, authenticated;

-- ---------- 手牌表（RLS 保护隐私） ----------
create table if not exists public.hands (
  player_id uuid primary key references public.players(id) on delete cascade,
  user_id   uuid not null,
  room_id   uuid not null,
  hand      jsonb                          -- [{rank,suit},...] 或 null
);
create index if not exists idx_hands_room on public.hands(room_id);

-- ---------- 聊天消息表 ----------
create table if not exists public.messages (
  id         bigint generated by default as identity primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  name       text not null,
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_room_created
  on public.messages(room_id, created_at);

-- ---------- 房间活动时间与自动清理 ----------
create or replace function public.set_zhajinhua_room_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

drop trigger if exists trg_zhajinhua_room_updated_at on public.rooms;
create trigger trg_zhajinhua_room_updated_at
before update on public.rooms
for each row execute function public.set_zhajinhua_room_updated_at();

create or replace function public.touch_zhajinhua_room_from_child()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  target_room uuid;
begin
  target_room=case when tg_op='DELETE' then old.room_id else new.room_id end;
  update public.rooms set updated_at=now() where id=target_room;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_zhajinhua_players_touch_room on public.players;
create trigger trg_zhajinhua_players_touch_room
after insert or update or delete on public.players
for each row execute function public.touch_zhajinhua_room_from_child();

drop trigger if exists trg_zhajinhua_messages_touch_room on public.messages;
create trigger trg_zhajinhua_messages_touch_room
after insert or update or delete on public.messages
for each row execute function public.touch_zhajinhua_room_from_child();

create or replace function public.cleanup_stale_zhajinhua_rooms()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  deleted_count integer;
begin
  delete from public.rooms
  where updated_at < now()-interval '2 hours';
  get diagnostics deleted_count=row_count;
  return deleted_count;
end;
$$;
revoke all on function public.cleanup_stale_zhajinhua_rooms() from public, anon, authenticated;
grant execute on function public.cleanup_stale_zhajinhua_rooms() to postgres;

create extension if not exists pg_cron;
do $cron$
declare
  old_job record;
begin
  for old_job in
    select jobid from cron.job where jobname='zhajinhua-room-cleanup'
  loop
    perform cron.unschedule(old_job.jobid);
  end loop;
  perform cron.schedule(
    'zhajinhua-room-cleanup',
    '*/15 * * * *',
    'select public.cleanup_stale_zhajinhua_rooms();'
  );
end;
$cron$;

-- ============================================================
-- 行级安全 RLS
-- ============================================================
alter table public.rooms   enable row level security;
alter table public.players enable row level security;
alter table public.hands   enable row level security;
alter table public.messages enable row level security;

-- rooms / players：好友房信任模型，匿名可读写（简化，便于快速上线）
drop policy if exists "rooms_all" on public.rooms;
create policy "rooms_all"   on public.rooms   for all using (true) with check (true);
drop policy if exists "players_all" on public.players;
create policy "players_all" on public.players for all using (true) with check (true);
drop policy if exists "messages_all" on public.messages;
create policy "messages_all" on public.messages for all using (true) with check (true);

-- hands：普通玩家只能读自己的手牌；房主可读全桌手牌
drop policy if exists "hands_read_own" on public.hands;
create policy "hands_read_own" on public.hands for select
  using (auth.uid() = user_id);

drop policy if exists "hands_read_host" on public.hands;
create policy "hands_read_host" on public.hands for select
  using (
    exists (
      select 1 from public.players p
      where p.room_id = hands.room_id
        and p.user_id = auth.uid()
        and p.is_host
    )
  );

-- hands：写权限（房主洗牌发牌时写入所有人的手牌）
drop policy if exists "hands_insert_host" on public.hands;
create policy "hands_insert_host" on public.hands for insert
  with check (
    exists (
      select 1 from public.players p
      where p.room_id = hands.room_id
        and p.user_id = auth.uid()
        and p.is_host
    )
  );

-- hands：更新（房主结算后清空手牌）
drop policy if exists "hands_update_host" on public.hands;
create policy "hands_update_host" on public.hands for update
  using (
    exists (
      select 1 from public.players p
      where p.room_id = hands.room_id
        and p.user_id = auth.uid()
        and p.is_host
    )
  );

-- ============================================================
-- 实时订阅（Realtime）
-- 建表后需要把这几个表加入 publication 才能收到 postgres_changes
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='hands'
  ) then
    alter publication supabase_realtime add table public.hands;
  end if;
end;
$$;

-- ============================================================
-- 辅助函数：生成 6 位房号（避免冲突）
-- ============================================================
create or replace function public.gen_room_code()
returns text language plpgsql as $$
declare
  code text;
begin
  loop
    code := upper(substr(md5(random()::text), 1, 6));
    exit when not exists (select 1 from public.rooms r where r.code = code);
  end loop;
  return code;
end;
$$;
