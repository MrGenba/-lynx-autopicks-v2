ALTER TABLE public.npb2_games ADD COLUMN IF NOT EXISTS source text,ADD COLUMN IF NOT EXISTS source_game_id text,ADD COLUMN IF NOT EXISTS source_url text,ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE public.npb2_player_stats ADD COLUMN IF NOT EXISTS raw_metrics jsonb;
NOTIFY pgrst,'reload schema';
