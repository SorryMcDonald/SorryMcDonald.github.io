-- Weekly multi-table tournaments. Run after 006_texas_indexes.sql.

create table if not exists tournament_editions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_key TEXT NOT NULL UNIQUE,
  opens_at TIMESTAMPTZ NOT NULL,
  registration_closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','registration_open','running','completed','cancelled')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registration_closes_at > opens_at)
);

create table if not exists tournament_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id UUID NOT NULL REFERENCES tournament_editions(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('texas','zhajinhua')),
  status TEXT NOT NULL CHECK (status IN ('scheduled','registration_open','running','completed','cancelled')),
  champion_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  champion_prize BIGINT NOT NULL DEFAULT 0 CHECK (champion_prize >= 0),
  next_table_number INTEGER NOT NULL DEFAULT 1 CHECK (next_table_number > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (edition_id, game)
);

create table if not exists tournament_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tournament_tracks(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL CHECK (table_number > 0),
  game_room_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (track_id, table_number),
  UNIQUE (track_id, game_room_id)
);

create table if not exists tournament_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id UUID NOT NULL REFERENCES tournament_tracks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  nickname TEXT NOT NULL,
  buy_in BIGINT NOT NULL CHECK (buy_in > 0 AND buy_in <= 200000),
  chips BIGINT NOT NULL CHECK (chips >= 0),
  status TEXT NOT NULL CHECK (status IN ('active','eliminated','left','champion')),
  game_room_id UUID NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  eliminated_at TIMESTAMPTZ,
  UNIQUE (track_id, user_id)
);

create table if not exists tournament_wallet_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  track_id UUID NOT NULL REFERENCES tournament_tracks(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('buy_in','prize','refund','adjustment')),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  balance_after BIGINT CHECK (balance_after >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create index if not exists tournament_editions_opens_at_idx on tournament_editions (opens_at desc);
create index if not exists tournament_entries_room_active_idx on tournament_entries (game_room_id) where status='active';
create index if not exists tournament_entries_user_idx on tournament_entries (user_id, entered_at desc);

drop trigger if exists trg_tournament_editions_updated_at on tournament_editions;
create trigger trg_tournament_editions_updated_at before update on tournament_editions
for each row execute function set_zhajinhua_updated_at();
drop trigger if exists trg_tournament_tracks_updated_at on tournament_tracks;
create trigger trg_tournament_tracks_updated_at before update on tournament_tracks
for each row execute function set_zhajinhua_updated_at();

create or replace function prevent_tournament_wallet_ledger_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'TOURNAMENT_WALLET_LEDGER_IMMUTABLE';
end;
$$;

drop trigger if exists trg_tournament_wallet_ledger_immutable on tournament_wallet_ledger;
create trigger trg_tournament_wallet_ledger_immutable before update or delete on tournament_wallet_ledger
for each row execute function prevent_tournament_wallet_ledger_mutation();

-- Texas tournament entries use the existing wallet transaction so the account
-- debit and room creation remain atomic.
alter table texas_wallet_ledger drop constraint if exists texas_wallet_ledger_entry_type_check;
alter table texas_wallet_ledger add constraint texas_wallet_ledger_entry_type_check
  check (entry_type in ('buy_in','rebuy','cash_out','refund','adjustment','tournament_buy_in','tournament_prize'));
