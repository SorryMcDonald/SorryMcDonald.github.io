DO $verify$
DECLARE
  missing_objects text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname = 'users'
      AND constraint_row.conname = 'users_animation_mode_check'
      AND position('disabled' IN pg_get_constraintdef(constraint_row.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'users_animation_mode_check does not allow disabled';
  END IF;

  SELECT array_agg(object_name ORDER BY object_name)
  INTO missing_objects
  FROM unnest(ARRAY[
    'texas_rooms',
    'texas_room_players',
    'texas_hands',
    'texas_hand_players',
    'texas_hole_cards',
    'texas_actions',
    'texas_pots',
    'texas_wallet_ledger',
    'texas_client_actions'
  ]) AS object_name
  WHERE to_regclass('public.' || object_name) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing Texas tables: %', missing_objects;
  END IF;

  SELECT array_agg(object_name ORDER BY object_name)
  INTO missing_objects
  FROM unnest(ARRAY[
    'texas_rooms_public_updated_idx',
    'texas_room_players_room_active_idx',
    'texas_room_players_room_seat_active_unique',
    'texas_room_players_user_active_unique',
    'texas_hands_room_number_idx',
    'texas_actions_room_seq_idx',
    'texas_actions_hand_idx',
    'texas_wallet_ledger_user_created_idx',
    'texas_client_actions_room_created_idx'
  ]) AS object_name
  WHERE to_regclass('public.' || object_name) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing Texas indexes: %', missing_objects;
  END IF;

  SELECT array_agg(expected.trigger_name ORDER BY expected.trigger_name)
  INTO missing_objects
  FROM (VALUES
    ('texas_rooms', 'trg_texas_rooms_updated_at'),
    ('texas_room_players', 'trg_texas_room_players_updated_at'),
    ('texas_actions', 'trg_texas_actions_notify'),
    ('texas_wallet_ledger', 'trg_texas_wallet_ledger_immutable')
  ) AS expected(table_name, trigger_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname = expected.table_name
      AND trigger_row.tgname = expected.trigger_name
      AND NOT trigger_row.tgisinternal
  );
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing Texas triggers: %', missing_objects;
  END IF;

  SELECT array_agg(object_name ORDER BY object_name)
  INTO missing_objects
  FROM unnest(ARRAY[
    'tournament_editions',
    'tournament_tracks',
    'tournament_tables',
    'tournament_entries',
    'tournament_wallet_ledger'
  ]) AS object_name
  WHERE to_regclass('public.' || object_name) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing tournament tables: %', missing_objects;
  END IF;

  SELECT array_agg(object_name ORDER BY object_name)
  INTO missing_objects
  FROM unnest(ARRAY[
    'tournament_editions_opens_at_idx',
    'tournament_editions_kind_opens_at_idx',
    'tournament_entries_room_active_idx',
    'tournament_entries_user_idx'
  ]) AS object_name
  WHERE to_regclass('public.' || object_name) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing tournament indexes: %', missing_objects;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tournament_editions'
      AND column_name='competition_kind'
  ) THEN
    RAISE EXCEPTION 'missing tournament_editions.competition_kind';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname='public'
      AND table_row.relname='tournament_tracks'
      AND constraint_row.conname='tournament_tracks_game_check'
      AND position('wild_texas' IN pg_get_constraintdef(constraint_row.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'tournament_tracks_game_check does not allow special variants';
  END IF;

  IF to_regclass('public.doudizhu_rooms') IS NULL THEN
    RAISE EXCEPTION 'missing doudizhu_rooms table';
  END IF;
  IF to_regclass('public.users_refill_count_idx') IS NULL THEN
    RAISE EXCEPTION 'missing users_refill_count_idx index';
  END IF;

  SELECT array_agg(expected.trigger_name ORDER BY expected.trigger_name)
  INTO missing_objects
  FROM (VALUES
    ('tournament_editions', 'trg_tournament_editions_updated_at'),
    ('tournament_tracks', 'trg_tournament_tracks_updated_at'),
    ('tournament_wallet_ledger', 'trg_tournament_wallet_ledger_immutable')
  ) AS expected(table_name, trigger_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger AS trigger_row
    JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
    WHERE table_row.relname = expected.table_name
      AND trigger_row.tgname = expected.trigger_name
      AND NOT trigger_row.tgisinternal
  );
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'missing tournament triggers: %', missing_objects;
  END IF;
END
$verify$;

SELECT json_build_object(
  'schema_ready', true,
  'migration_level', 10,
  'texas_table_count', 9,
  'texas_index_count', 9,
  'texas_trigger_count', 4,
  'tournament_table_count', 5,
  'tournament_index_count', 4,
  'tournament_trigger_count', 3,
  'doudizhu_table_count', 1,
  'refill_index_count', 1
) AS schema_receipt;
