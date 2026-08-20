-- Shared PostgreSQL persistence for the merged 斗地主 service.
CREATE TABLE IF NOT EXISTS doudizhu_rooms (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('waiting','bidding','doubling','playing','finished','closed')),
  host_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 4),
  base_score BIGINT NOT NULL CHECK (base_score > 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doudizhu_rooms_status_updated_idx ON doudizhu_rooms (status, updated_at DESC);
DROP TRIGGER IF EXISTS trg_doudizhu_rooms_updated_at ON doudizhu_rooms;
CREATE TRIGGER trg_doudizhu_rooms_updated_at BEFORE UPDATE ON doudizhu_rooms
FOR EACH ROW EXECUTE FUNCTION set_zhajinhua_updated_at();
