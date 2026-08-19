-- Durable room snapshots for the single-server game runtime.
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}'::jsonb;
