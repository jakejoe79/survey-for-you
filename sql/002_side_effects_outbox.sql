CREATE TYPE side_effect_status AS ENUM ('pending', 'running', 'executed');

ALTER TABLE side_effects
  ADD COLUMN IF NOT EXISTS status side_effect_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempt_id UUID,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

DROP TRIGGER IF EXISTS trg_side_effects_updated_at ON side_effects;
CREATE TRIGGER trg_side_effects_updated_at
BEFORE UPDATE ON side_effects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_side_effects_pending
ON side_effects (status, updated_at);

