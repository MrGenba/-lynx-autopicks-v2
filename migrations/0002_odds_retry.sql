-- 2026-07-26: retry persistente del auto-fetch de cuotas al confirmarse el lineup completo.
-- last_odds_attempt_at marca el último intento de scrape de cuotas de un partido, para el
-- cooldown entre reintentos (evita re-scrapear en cada tick de 180s = martilleo/throttle).
ALTER TABLE games_gate_state ADD COLUMN IF NOT EXISTS last_odds_attempt_at TIMESTAMPTZ;
