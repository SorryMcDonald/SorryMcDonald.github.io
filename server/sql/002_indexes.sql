-- Supporting indexes for room state, event delivery, balances, and leaderboards.
CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rooms_public_status_updated_idx
  ON rooms (is_public, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms (host_user_id);
CREATE INDEX IF NOT EXISTS room_players_room_active_idx
  ON room_players (room_id, seat) WHERE left_room = FALSE;
CREATE INDEX IF NOT EXISTS room_players_user_idx ON room_players (user_id);
CREATE INDEX IF NOT EXISTS room_spectators_room_joined_idx
  ON room_spectators (room_id, joined_at);
CREATE INDEX IF NOT EXISTS rounds_room_started_idx
  ON rounds (room_id, started_at DESC);
CREATE INDEX IF NOT EXISTS round_players_round_result_idx
  ON round_players (round_id, result);
CREATE INDEX IF NOT EXISTS ledger_user_created_idx
  ON account_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_round_idx ON account_ledger (round_id);
CREATE INDEX IF NOT EXISTS game_events_room_id_idx
  ON game_events (room_id, id);
CREATE INDEX IF NOT EXISTS game_events_created_idx
  ON game_events (created_at, id);
CREATE INDEX IF NOT EXISTS global_banners_queue_idx
  ON global_banners (queue_name, id);
CREATE INDEX IF NOT EXISTS legacy_migrations_target_idx
  ON legacy_migrations (target_user_id) WHERE target_user_id IS NOT NULL;
