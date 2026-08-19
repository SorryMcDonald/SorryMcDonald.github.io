-- Texas Holdem schema. Run after 001_schema.sql, 002_indexes.sql and 003_room_state.sql.

create table if not exists texas_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','preflop','flop','turn','river','showdown','settled','closed')),
  host_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  small_blind BIGINT NOT NULL CHECK (small_blind > 0),
  big_blind BIGINT NOT NULL CHECK (big_blind >= small_blind * 2),
  min_buy_in BIGINT NOT NULL CHECK (min_buy_in >= big_blind * 20),
  max_buy_in BIGINT NOT NULL CHECK (max_buy_in >= min_buy_in),
  max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 9),
  dealer_seat INTEGER CHECK (dealer_seat BETWEEN 0 AND 8),
  current_turn INTEGER NOT NULL DEFAULT -1 CHECK (current_turn BETWEEN -1 AND 8),
  hand_number INTEGER NOT NULL DEFAULT 0 CHECK (hand_number >= 0),
  pot BIGINT NOT NULL DEFAULT 0 CHECK (pot >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  allow_spectators BOOLEAN NOT NULL DEFAULT FALSE,
  spectator_cards BOOLEAN NOT NULL DEFAULT FALSE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create table if not exists texas_room_players (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES texas_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 8),
  stack BIGINT NOT NULL DEFAULT 0 CHECK (stack >= 0),
  waiting BOOLEAN NOT NULL DEFAULT TRUE,
  pending_leave BOOLEAN NOT NULL DEFAULT FALSE,
  left_room BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create table if not exists texas_hands (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES texas_rooms(id) ON DELETE CASCADE,
  hand_number INTEGER NOT NULL CHECK (hand_number > 0),
  status TEXT NOT NULL CHECK (status IN ('preflop','flop','turn','river','showdown','settled')),
  dealer_seat INTEGER NOT NULL CHECK (dealer_seat BETWEEN 0 AND 8),
  board JSONB NOT NULL DEFAULT '[]'::jsonb,
  pot BIGINT NOT NULL DEFAULT 0 CHECK (pot >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  UNIQUE (room_id, hand_number)
);

create table if not exists texas_hand_players (
  hand_id UUID NOT NULL REFERENCES texas_hands(id) ON DELETE CASCADE,
  room_player_id UUID REFERENCES texas_room_players(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 8),
  folded BOOLEAN NOT NULL DEFAULT FALSE,
  all_in BOOLEAN NOT NULL DEFAULT FALSE,
  total_contribution BIGINT NOT NULL DEFAULT 0 CHECK (total_contribution >= 0),
  payout BIGINT NOT NULL DEFAULT 0 CHECK (payout >= 0),
  net_change BIGINT NOT NULL DEFAULT 0,
  hand_type TEXT,
  stats_applied BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (hand_id, user_id),
  UNIQUE (hand_id, seat)
);

create table if not exists texas_hole_cards (
  hand_id UUID NOT NULL REFERENCES texas_hands(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cards JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, user_id),
  CHECK (jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) = 2)
);

create table if not exists texas_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES texas_rooms(id) ON DELETE CASCADE,
  hand_id UUID REFERENCES texas_hands(id) ON DELETE CASCADE,
  event_seq BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, event_seq)
);

create table if not exists texas_pots (
  hand_id UUID NOT NULL REFERENCES texas_hands(id) ON DELETE CASCADE,
  pot_index INTEGER NOT NULL CHECK (pot_index >= 0),
  amount BIGINT NOT NULL CHECK (amount > 0),
  eligible_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  winner_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (hand_id, pot_index)
);

create table if not exists texas_wallet_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id UUID REFERENCES texas_rooms(id) ON DELETE SET NULL,
  hand_id UUID REFERENCES texas_hands(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('buy_in','rebuy','cash_out','refund','adjustment')),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  balance_after BIGINT CHECK (balance_after >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

create table if not exists texas_client_actions (
  client_action_id TEXT PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES texas_rooms(id) ON DELETE CASCADE,
  hand_id UUID REFERENCES texas_hands(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

drop trigger if exists trg_texas_rooms_updated_at on texas_rooms;
create trigger trg_texas_rooms_updated_at before update on texas_rooms
for each row execute function set_zhajinhua_updated_at();

drop trigger if exists trg_texas_room_players_updated_at on texas_room_players;
create trigger trg_texas_room_players_updated_at before update on texas_room_players
for each row execute function set_zhajinhua_updated_at();

create or replace function notify_texas_event()
returns trigger language plpgsql as $$
begin
  perform pg_notify('texas_events', json_build_object(
    'event_id', new.id, 'room_id', new.room_id, 'event_type', new.event_type
  )::text);
  return new;
end;
$$;

drop trigger if exists trg_texas_actions_notify on texas_actions;
create trigger trg_texas_actions_notify after insert on texas_actions
for each row execute function notify_texas_event();

create or replace function prevent_texas_wallet_ledger_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'TEXAS_WALLET_LEDGER_IMMUTABLE';
end;
$$;

drop trigger if exists trg_texas_wallet_ledger_immutable on texas_wallet_ledger;
create trigger trg_texas_wallet_ledger_immutable before update or delete on texas_wallet_ledger
for each row execute function prevent_texas_wallet_ledger_mutation();
