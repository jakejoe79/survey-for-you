CREATE TYPE idempotency_status AS ENUM ('processing','completed','failed');

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  status idempotency_status NOT NULL,
  request_version INT NOT NULL,
  attempt_id UUID,
  resolved_request_hash TEXT,
  response_version INT,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT idempotency_expires_after_created CHECK (expires_at > created_at),
  UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_processing ON idempotency_keys (status, updated_at);

CREATE TABLE IF NOT EXISTS survey_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  platform_id BIGINT NOT NULL,
  payout_cents INT NOT NULL CHECK (payout_cents > 0),
  duration_seconds INT NOT NULL CHECK (duration_seconds > 0),
  completed_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  write_source TEXT NOT NULL DEFAULT 'quick_log',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entries_user_time
ON survey_entries (user_id, completed_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_entries_user_platform_time
ON survey_entries (user_id, platform_id, completed_at_utc DESC);

CREATE TABLE IF NOT EXISTS user_platform_stats (
  user_id BIGINT NOT NULL,
  platform_id BIGINT NOT NULL,
  use_count INT NOT NULL DEFAULT 0,
  last_used_at_utc TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, platform_id)
);

CREATE TABLE IF NOT EXISTS user_daily_activity (
  user_id BIGINT NOT NULL,
  local_date DATE NOT NULL,
  timezone_at_write TEXT NOT NULL,
  entry_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, local_date)
);

CREATE TABLE IF NOT EXISTS side_effects (
  id BIGSERIAL PRIMARY KEY,
  idempotency_id BIGINT NOT NULL,
  effect_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_id, effect_type),
  CONSTRAINT fk_idempotency FOREIGN KEY (idempotency_id) REFERENCES idempotency_keys(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_idempotency_keys_updated_at ON idempotency_keys;
CREATE TRIGGER trg_idempotency_keys_updated_at
BEFORE UPDATE ON idempotency_keys
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_platform_stats_updated_at ON user_platform_stats;
CREATE TRIGGER trg_user_platform_stats_updated_at
BEFORE UPDATE ON user_platform_stats
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_daily_activity_updated_at ON user_daily_activity;
CREATE TRIGGER trg_user_daily_activity_updated_at
BEFORE UPDATE ON user_daily_activity
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

