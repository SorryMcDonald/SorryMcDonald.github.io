-- Extend tournament persistence for the daily permanent special tables.
-- Run after 007_tournaments.sql. This migration is idempotent.

ALTER TABLE tournament_editions
  ADD COLUMN IF NOT EXISTS competition_kind TEXT NOT NULL DEFAULT 'weekly';

ALTER TABLE tournament_editions
  DROP CONSTRAINT IF EXISTS tournament_editions_competition_kind_check;
ALTER TABLE tournament_editions
  ADD CONSTRAINT tournament_editions_competition_kind_check
  CHECK (competition_kind IN ('weekly', 'permanent'));

ALTER TABLE tournament_tracks
  DROP CONSTRAINT IF EXISTS tournament_tracks_game_check;
ALTER TABLE tournament_tracks
  ADD CONSTRAINT tournament_tracks_game_check
  CHECK (game IN ('texas', 'zhajinhua', 'laizi_zhajinhua', 'ghost_texas', 'wild_texas'));

CREATE INDEX IF NOT EXISTS tournament_editions_kind_opens_at_idx
  ON tournament_editions (competition_kind, opens_at DESC);
