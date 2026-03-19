ALTER TABLE side_effects
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_side_effects_sched
ON side_effects (status, next_run_at, updated_at);

