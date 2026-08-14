"""Dashboard de estado (HTML) servido en GET /d/<DASHBOARD_TOKEN> -- 2026-08-14.

Responde de un vistazo las dos preguntas que hasta ahora solo se podian contestar mirando los
logs del contenedor (inaccesibles desde el movil): (1) ¿el scrapeo por Tor esta vivo y por que
IP sale?, y (2) ¿que partidos de hoy tienen cuotas y cuales no?

Es SOLO-LECTURA a proposito. La rotacion de circuito se pide desde Telegram ("cambio tor"), que
va autenticada con el token de scrape; el token de esta pagina viaja en la URL (unica forma de
abrirla en un navegador) y por tanto acaba en el historial y en logs de proxy -- filtrarlo no
debe permitir accionar nada, solo mirar.

Todo se renderiza en el servidor: sin JS, sin recursos externos, un <meta refresh> y ya. La
pagina se abre desde el movil por Traefik, donde una CDN bloqueada dejaria la pagina en blanco.
"""
import datetime as dt
import html
import logging

from app.tor_control import get_exit_ip

logger = logging.getLogger(__name__)

LEAGUE_NAME = {1: "MLB", 11: "MiLB AAA", 23: "LMB"}

# Ventana de partidos mostrada: desde 6h antes (para que un partido recien empezado no
# desaparezca mientras se revisa por que no tuvo cuotas) hasta 30h despues (cubre el slate de
# manana ya descubierto por el detector).
_GAMES_SQL = """
SELECT g.sport_id, g.game_pk, g.away_team_name, g.home_team_name, g.status,
       to_char(g.game_datetime_utc AT TIME ZONE 'Europe/Madrid', 'DD/MM HH24:MI') AS hora_local,
       g.game_datetime_utc,
       g.pitchers_confirmed_at IS NOT NULL AS gate_a,
       g.lineup_confirmed_at   IS NOT NULL AS gate_b,
       EXTRACT(EPOCH FROM now() - g.last_odds_attempt_at)::int AS last_attempt_age_s,
       o.away_ml, o.home_ml, o.away_hc_val, o.away_hc_odds, o.home_hc_val, o.home_hc_odds,
       o.total_line, o.over_odds, o.under_odds,
       EXTRACT(EPOCH FROM now() - o.updated_at)::int AS odds_age_s,
       (SELECT count(*) FROM pipeline_runs p
         WHERE p.sport_id = g.sport_id AND p.game_pk = g.game_pk AND p.published) AS picks
FROM games_gate_state g
LEFT JOIN game_odds o ON o.sport_id = g.sport_id AND o.game_pk = g.game_pk
WHERE g.game_datetime_utc > now() - interval '6 hours'
  AND g.game_datetime_utc < now() + interval '30 hours'
ORDER BY g.game_datetime_utc, g.sport_id
"""

_SUMMARY_SQL = """
SELECT
  count(*) FILTER (WHERE kind='scrape' AND created_at > now() - interval '6 hours')          AS s6,
  count(*) FILTER (WHERE kind='scrape' AND ok AND created_at > now() - interval '6 hours')   AS s6_ok,
  count(*) FILTER (WHERE kind='scrape' AND created_at > now() - interval '24 hours')         AS s24,
  count(*) FILTER (WHERE kind='scrape' AND ok AND created_at > now() - interval '24 hours')  AS s24_ok,
  count(*) FILTER (WHERE kind='rotate' AND created_at > now() - interval '24 hours')         AS r24,
  EXTRACT(EPOCH FROM now() - max(created_at) FILTER (WHERE kind='scrape' AND ok))::int       AS last_ok_age_s,
  EXTRACT(EPOCH FROM now() - max(created_at) FILTER (WHERE kind='scrape'))::int              AS last_any_age_s,
  EXTRACT(EPOCH FROM now() - max(created_at) FILTER (WHERE kind='rotate'))::int              AS last_rotate_age_s
FROM tor_activity
"""

_EVENTS_SQL = """
SELECT kind, league, ok, status, n_scraped, n_matched, duration_ms, detail, source, exit_ip,
       to_char(created_at AT TIME ZONE 'Europe/Madrid', 'DD/MM HH24:MI:SS') AS ts_local
FROM tor_activity
ORDER BY created_at DESC
LIMIT 25
"""


async def collect_state(pool, proxy: str | None) -> dict:
    """Reune todo lo que pinta la pagina. Cada bloque va por separado y tolera su propio fallo:
    si la comprobacion de Tor da timeout (justo el caso interesante) la tabla de partidos tiene
    que seguir viendose, y al reves."""
    tor = await get_exit_ip(proxy)

    games, summary, events, db_error = [], {}, [], None
    try:
        async with pool.acquire() as conn:
            games = await conn.fetch(_GAMES_SQL)
            summary = dict(await conn.fetchrow(_SUMMARY_SQL))
            events = await conn.fetch(_EVENTS_SQL)
    except Exception as e:
        logger.exception("dashboard: fallo leyendo de Postgres")
        db_error = f"{type(e).__name__}: {e}"[:300]

    return {"tor": tor, "games": games, "summary": summary, "events": events, "db_error": db_error}


def _esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def _odds(v) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.2f}"
    except (TypeError, ValueError):
        return _esc(v)


def _signed(v) -> str:
    if v is None:
        return ""
    try:
        f = float(v)
        return f"+{f:g}" if f > 0 else f"{f:g}"
    except (TypeError, ValueError):
        return _esc(v)


def _age(seconds) -> str:
    """Edad legible. None = nunca ocurrio (distinto de 'hace 0s')."""
    if seconds is None:
        return "nunca"
    s = int(seconds)
    if s < 0:
        s = 0
    if s < 60:
        return f"hace {s}s"
    if s < 3600:
        return f"hace {s // 60}min"
    if s < 86400:
        return f"hace {s // 3600}h{(s % 3600) // 60:02d}"
    return f"hace {s // 86400}d"


def _tor_verdict(tor: dict, summary: dict) -> tuple[str, str, str]:
    """(clase_css, titulo, explicacion). Separa deliberadamente dos cosas que se confunden:
    que Tor RESPONDA (el proxy funciona) y que el scrapeo SIRVA (cuotasahora devuelve la pagina
    real por ese circuito). Se puede estar online y aun asi no recibir cuotas."""
    last_ok = summary.get("last_ok_age_s")
    scrape_reciente = last_ok is not None and last_ok < 6 * 3600

    if not tor.get("ok"):
        return "bad", "Tor NO responde", f"El proxy SOCKS no contesta: {tor.get('detail') or 'sin detalle'}"
    if not tor.get("is_tor"):
        return ("warn", "Salida sin Tor",
                "El proxy responde pero la peticion NO salio por la red Tor — cuotasahora vera la IP "
                "del VPS (bloqueada). Revisa PROXY_SERVER y que el daemon tor esté vivo.")
    if scrape_reciente:
        return "ok", "Tor online · scrapeo OK", "Tor responde y hubo scrapes con partidos reales en las últimas 6h."
    if last_ok is None:
        return ("warn", "Tor online · sin scrapes aún",
                "Tor responde, pero todavía no hay ningún scrape registrado (¿contenedor recién desplegado?).")
    return ("warn", "Tor online · scrapeo sin éxito",
            f"Tor responde, pero el último scrape con partidos reales fue {_age(last_ok)}. "
            "Es el síntoma del circuito 'decoy' — prueba «cambio tor» en Telegram.")


def _games_table(games) -> str:
    if not games:
        return "<p class='muted'>Sin partidos descubiertos en la ventana (-6h / +30h).</p>"

    rows = []
    for g in games:
        has_odds = g["away_ml"] is not None or g["total_line"] is not None or g["away_hc_odds"] is not None
        if has_odds:
            estado, cls = "Con cuotas", "ok"
        elif g["gate_a"] or g["gate_b"]:
            estado, cls = "Confirmado, SIN cuotas", "bad"
        else:
            estado, cls = "Esperando confirmación", "muted"

        ml = f"{_odds(g['away_ml'])} / {_odds(g['home_ml'])}" if g["away_ml"] is not None else "—"
        if g["away_hc_odds"] is not None:
            hc = (f"{_signed(g['away_hc_val'])} @{_odds(g['away_hc_odds'])} / "
                  f"{_signed(g['home_hc_val'])} @{_odds(g['home_hc_odds'])}")
        else:
            hc = "—"
        if g["total_line"] is not None:
            ou = f"{_signed(g['total_line']).lstrip('+')} · O{_odds(g['over_odds'])} / U{_odds(g['under_odds'])}"
        else:
            ou = "—"

        gates = ("A✅" if g["gate_a"] else "A⏳") + " " + ("L✅" if g["gate_b"] else "L⏳")
        cuando = _age(g["odds_age_s"]) if has_odds else _age(g["last_attempt_age_s"]) + " (intento)"
        picks = f"🏆 {g['picks']}" if g["picks"] else "—"

        rows.append(
            "<tr>"
            f"<td class='nowrap'>{_esc(g['hora_local'])}</td>"
            f"<td class='nowrap'>{_esc(LEAGUE_NAME.get(g['sport_id'], g['sport_id']))}</td>"
            f"<td>{_esc(g['away_team_name'])} <span class='muted'>@</span> {_esc(g['home_team_name'])}</td>"
            f"<td class='nowrap'>{_esc(gates)}</td>"
            f"<td class='nowrap {cls}'>{_esc(estado)}</td>"
            f"<td class='nowrap'>{ml}</td>"
            f"<td class='nowrap'>{hc}</td>"
            f"<td class='nowrap'>{ou}</td>"
            f"<td class='nowrap muted'>{_esc(cuando)}</td>"
            f"<td class='nowrap'>{picks}</td>"
            "</tr>"
        )

    return (
        "<div class='scroll'><table>"
        "<thead><tr><th>Hora</th><th>Liga</th><th>Partido</th><th>Gates</th><th>Estado</th>"
        "<th>ML (A/H)</th><th>Hándicap</th><th>Total</th><th>Cuotas</th><th>Picks</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></div>"
    )


def _events_table(events) -> str:
    if not events:
        return "<p class='muted'>Sin actividad registrada todavía.</p>"
    rows = []
    for e in events:
        icon = "✅" if e["ok"] else "❌"
        kind = "rotación IP" if e["kind"] == "rotate" else "scrape"
        detalle = e["detail"] or ""
        if e["kind"] == "scrape" and e["n_scraped"] is not None:
            detalle = f"{e['n_scraped']} scrapeados · {e['n_matched']} asignados. {detalle}".strip()
        dur = f"{e['duration_ms'] / 1000:.0f}s" if e["duration_ms"] else ""
        rows.append(
            "<tr>"
            f"<td class='nowrap'>{_esc(e['ts_local'])}</td>"
            f"<td class='nowrap'>{icon} {_esc(kind)}</td>"
            f"<td class='nowrap'>{_esc(e['league'] or '—')}</td>"
            f"<td class='nowrap'>{_esc(e['status'] or '')}</td>"
            f"<td class='nowrap'>{_esc(dur)}</td>"
            f"<td class='detail'>{_esc(detalle[:180])}</td>"
            "</tr>"
        )
    return (
        "<div class='scroll'><table>"
        "<thead><tr><th>Cuándo</th><th>Evento</th><th>Liga</th><th>Estado</th><th>Dur.</th><th>Detalle</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></div>"
    )


_CSS = """
:root{--bg:#f6f7f9;--card:#fff;--fg:#1a1d21;--muted:#6b7280;--line:#e3e6ea;
--ok:#15803d;--okbg:#dcfce7;--warn:#a16207;--warnbg:#fef3c7;--bad:#b91c1c;--badbg:#fee2e2;}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--fg:#e6e9ee;--muted:#9aa4b2;
--line:#262c35;--ok:#4ade80;--okbg:#0d2c1a;--warn:#fbbf24;--warnbg:#33280a;--bad:#f87171;--badbg:#3a1414;}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);
font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1{font-size:19px;margin:0 0 2px}h2{font-size:15px;margin:26px 0 10px;color:var(--muted);
text-transform:uppercase;letter-spacing:.06em}
.wrap{max-width:1200px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.banner{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;margin:14px 0}
.banner .title{font-size:17px;font-weight:650}
.banner.ok{background:var(--okbg);border-color:var(--ok)}.banner.ok .title{color:var(--ok)}
.banner.warn{background:var(--warnbg);border-color:var(--warn)}.banner.warn .title{color:var(--warn)}
.banner.bad{background:var(--badbg);border-color:var(--bad)}.banner.bad .title{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.tile .v{font-size:19px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:normal}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:0}
.nowrap{white-space:nowrap}.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.detail{color:var(--muted);font-size:12px;max-width:420px}
code{background:var(--bg);padding:1px 5px;border-radius:5px;font-size:12.5px}
footer{margin:26px 0 8px;color:var(--muted);font-size:12px}
"""


def render_html(state: dict, refresh_s: int = 60) -> str:
    tor, summary = state["tor"], state["summary"] or {}
    cls, titulo, explica = _tor_verdict(tor, summary)

    ip = tor.get("ip") or "—"
    s6, s6_ok = summary.get("s6") or 0, summary.get("s6_ok") or 0
    s24, s24_ok = summary.get("s24") or 0, summary.get("s24_ok") or 0
    pct24 = f"{(100 * s24_ok / s24):.0f}%" if s24 else "—"

    games = state["games"]
    con_cuotas = sum(
        1 for g in games
        if g["away_ml"] is not None or g["total_line"] is not None or g["away_hc_odds"] is not None
    )

    db_warning = (
        f"<div class='card banner bad'><span class='title'>Sin datos de Postgres</span>"
        f"<span class='muted'>{_esc(state['db_error'])}</span></div>"
        if state["db_error"] else ""
    )

    ahora = dt.datetime.now(dt.timezone.utc).strftime("%d/%m %H:%M:%S UTC")

    return f"""<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="{refresh_s}">
<title>Lynx Hunter · Estado Tor y cuotas</title>
<style>{_CSS}</style>
</head><body><div class="wrap">

<h1>Lynx Hunter · Estado del scrapeo</h1>
<div class="muted">Actualizado {_esc(ahora)} · se refresca solo cada {refresh_s}s</div>

{db_warning}

<div class="card banner {cls}">
  <span class="title">{_esc(titulo)}</span>
  <span class="muted">{_esc(explica)}</span>
</div>

<div class="grid">
  <div class="card tile"><div class="k">IP de salida</div><div class="v">{_esc(ip)}</div>
    <div class="muted">{'red Tor confirmada' if tor.get('is_tor') else 'sin confirmar'} · {tor.get('latency_ms', 0)} ms</div></div>
  <div class="card tile"><div class="k">Último scrape con partidos</div><div class="v">{_esc(_age(summary.get('last_ok_age_s')))}</div>
    <div class="muted">último intento {_esc(_age(summary.get('last_any_age_s')))}</div></div>
  <div class="card tile"><div class="k">Scrapes 6h</div><div class="v">{s6_ok}/{s6}</div>
    <div class="muted">con partidos / intentos</div></div>
  <div class="card tile"><div class="k">Éxito 24h</div><div class="v">{pct24}</div>
    <div class="muted">{s24_ok} de {s24} intentos</div></div>
  <div class="card tile"><div class="k">Rotaciones de IP</div><div class="v">{summary.get('r24') or 0}</div>
    <div class="muted">últimas 24h · última {_esc(_age(summary.get('last_rotate_age_s')))}</div></div>
  <div class="card tile"><div class="k">Partidos con cuotas</div><div class="v">{con_cuotas}/{len(games)}</div>
    <div class="muted">ventana -6h / +30h</div></div>
</div>

<h2>Partidos y cuotas</h2>
{_games_table(games)}

<h2>Actividad reciente de Tor</h2>
{_events_table(state['events'])}

<footer>
Para forzar una IP nueva, escribe <code>cambio tor</code> en @Lynx_HunterBot.
La IP mostrada es la del circuito que sirve la comprobación en este instante; Tor reutiliza
circuito por destino, así que normalmente —pero no con garantía— es la misma que ve cuotasahora.
</footer>

</div></body></html>"""
