-- 2026-08-30: freno de reintento perpetuo para partidos SIN NINGUNA cuota.
--
-- _candidates_needing_odds ya frena a los partidos PARCIALES (last_partial_retry_at, migracion
-- 0004), pero el caso "sin nada" queda deliberadamente sin freno ("es el caso que de verdad
-- importa"). Auditoria 2026-08-30: eso es justo el patron que el cortacircuitos existe para
-- cortar (insistir agrava el throttle de cuotasahora), solo que aqui no habia ningun freno por
-- PARTIDO, solo el cortacircuitos por LIGA. Medido en produccion: MiLB reintentaba partidos sin
-- cuotas cada 15 min sin parar durante hasta 7h de ventana (-1h/+6h), y el 49.3% de los intentos
-- de MiLB en 7 dias volvian "empty" (frente al 3.9% de MLB con el mismo scraper/navegador).
ALTER TABLE games_gate_state ADD COLUMN IF NOT EXISTS last_empty_retry_at TIMESTAMPTZ;
