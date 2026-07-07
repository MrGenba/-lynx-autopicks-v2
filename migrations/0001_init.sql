-- Lynx Hunter Auto-Picks v2 -- schema inicial.
-- Esta base de datos es propia y separada de Supabase: nunca se escribe en las tablas
-- de produccion (mlb_games, picks_history, etc.), solo se leen via REST cuando hace falta.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sport_id: 1=MLB, 11=MiLB AAA, 23=LMB (mismo mapeo que MLB Stats API en todo el proyecto).
CREATE TABLE IF NOT EXISTS team_aliases (
  id         BIGSERIAL PRIMARY KEY,
  sport_id   SMALLINT NOT NULL,
  team_id    INTEGER NOT NULL,
  team_name  TEXT NOT NULL,
  alias_text TEXT NOT NULL,
  alias_norm TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('seed', 'learned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sport_id, alias_norm)
);

-- Un partido descubierto por el detector. Se actualiza en cada tick; los timestamps de
-- confirmacion son "primera vez que se vio true", nunca se retroceden.
CREATE TABLE IF NOT EXISTS games_gate_state (
  id                          BIGSERIAL PRIMARY KEY,
  sport_id                    SMALLINT NOT NULL,
  game_pk                     BIGINT NOT NULL,
  away_team_id                INTEGER,
  home_team_id                INTEGER,
  away_team_name              TEXT,
  home_team_name              TEXT,
  game_datetime_utc           TIMESTAMPTZ,
  status                      TEXT,
  away_pitcher_id             INTEGER,
  home_pitcher_id             INTEGER,
  pitchers_confirmed_at       TIMESTAMPTZ,  -- Gate A
  lineup_confirmed_at         TIMESTAMPTZ,  -- Gate B
  pitchers_no_odds_notice_at  TIMESTAMPTZ,  -- dedupe del aviso "faltan cuotas" (pipeline 1)
  lineup_no_odds_notice_at    TIMESTAMPTZ,  -- dedupe del aviso "faltan cuotas" (pipeline 2)
  discovered_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sport_id, game_pk)
);

-- Cuotas recibidas por Telegram para un partido. Un unico set vigente por partido
-- (mensajes nuevos actualizan/mezclan, no acumulan historial -- ver pipelines.py).
CREATE TABLE IF NOT EXISTS game_odds (
  id                    BIGSERIAL PRIMARY KEY,
  sport_id              SMALLINT NOT NULL,
  game_pk               BIGINT NOT NULL,
  away_ml               NUMERIC,
  home_ml               NUMERIC,
  away_hc_val           NUMERIC,
  away_hc_odds          NUMERIC,
  home_hc_val           NUMERIC,
  home_hc_odds          NUMERIC,
  total_line            NUMERIC,
  over_odds             NUMERIC,
  under_odds            NUMERIC,
  submitted_by_chat_id  BIGINT,
  telegram_message_id   BIGINT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sport_id, game_pk)
);

-- El mecanismo de idempotencia: como mucho una fila por (partido, pipeline), para siempre.
-- El INSERT ... ON CONFLICT DO NOTHING de esta tabla es el unico punto de sincronizacion
-- entre el detector (tick cada 180s) y el manejador de mensajes de Telegram -- ver pipelines.py.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                   BIGSERIAL PRIMARY KEY,
  sport_id             SMALLINT NOT NULL,
  game_pk              BIGINT NOT NULL,
  pipeline             SMALLINT NOT NULL CHECK (pipeline IN (1, 2)),
  claimed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  quant_result         JSONB,
  data_score           NUMERIC,
  best_pick            JSONB,
  published            BOOLEAN NOT NULL DEFAULT false,
  published_at         TIMESTAMPTZ,
  telegram_message_id  BIGINT,
  error                TEXT,
  UNIQUE (sport_id, game_pk, pipeline)
);

-- Todo lo calculado, incluso bajo umbral, para poder auditar calibracion despues.
CREATE TABLE IF NOT EXISTS candidates_log (
  id              BIGSERIAL PRIMARY KEY,
  pipeline_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  market          TEXT,
  pick_side       TEXT,
  pick_team       TEXT,
  odds            NUMERIC,
  prob_estimated  NUMERIC,
  prob_implied    NUMERIC,
  edge            NUMERIC,
  edge_threshold  NUMERIC,
  confidence      TEXT,
  publicable      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Desambiguacion de alias: keyed SOLO por chat_id, independiente de cualquier estado del
-- detector -- asi un numero arbitrario de ticks entre la pregunta y la respuesta "1"/"2"
-- del usuario no puede interferir con este flujo.
CREATE TABLE IF NOT EXISTS telegram_pending_clarification (
  chat_id          BIGINT PRIMARY KEY,
  raw_message_text TEXT NOT NULL,
  parsed_odds      JSONB NOT NULL,
  candidate_games  JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);

-- Cursor de getUpdates (para long-polling con offset persistente entre reinicios).
CREATE TABLE IF NOT EXISTS telegram_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
