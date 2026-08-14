-- 2026-08-14: telemetria del scrapeo por Tor. Hasta ahora el unico rastro de "¿funciona el
-- scraper?" eran los logs del contenedor (inaccesibles desde Telegram) y _last_status, que vive
-- en memoria y se pierde en cada reinicio. Esta tabla es la fuente del dashboard /d/<token>:
-- permite responder "¿esta online el scrapeo?" con historial real, no con una foto del momento.
--
-- kind='scrape' -> un intento de scrape de cuotasahora (una liga, una sesion de navegador).
--                 ok=true significa que cuotasahora sirvio la pagina REAL (devolvio partidos);
--                 ok=false cubre tanto el fallo duro del scraper como el "decoy" (indice vacio).
-- kind='rotate' -> una rotacion de circuito (SIGNAL NEWNYM), manual desde Telegram o automatica
--                 entre reintentos del autofetch.
CREATE TABLE IF NOT EXISTS tor_activity (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('scrape', 'rotate')),
  sport_id     SMALLINT,
  league       TEXT,
  ok           BOOLEAN NOT NULL,
  status       TEXT,
  n_candidates INTEGER,
  n_scraped    INTEGER,
  n_matched    INTEGER,
  duration_ms  INTEGER,
  exit_ip      TEXT,
  detail       TEXT,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tor_activity_created_idx ON tor_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS tor_activity_kind_created_idx ON tor_activity (kind, created_at DESC);
