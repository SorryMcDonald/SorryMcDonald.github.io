-- Track successful refill phrases for the disgrace leaderboard.
ALTER TABLE users ADD COLUMN IF NOT EXISTS refill_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_refill_count_check;
ALTER TABLE users ADD CONSTRAINT users_refill_count_check CHECK (refill_count >= 0);
CREATE INDEX IF NOT EXISTS users_refill_count_idx ON users (refill_count DESC, lower(nickname), id);
