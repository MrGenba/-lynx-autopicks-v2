ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS prediction_snapshot_id text;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS receipt_synced_at timestamptz;
ALTER TABLE game_odds ADD COLUMN IF NOT EXISTS market_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
