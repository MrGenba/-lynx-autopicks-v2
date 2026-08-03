"""Captura de linea de CIERRE (Bet365 via scraper de cuotasahora -- MISMA fuente que la cuota de
apuesta) para poder medir CLV (closing line value). Cerca del inicio de cada partido con pick
publicado, scrapea la linea actual y la guarda en Supabase `pick_closing_lines`. El informe
(clv_report.js) cruza esto con *_picks_history: si los picks baten el cierre de forma consistente
(sobre 200+ apuestas), hay edge real aunque el P/L a corto sea ruidoso.

Notas de diseno (sesion 2026-07-25):
- CLV solo es medible HACIA DELANTE: no hay cierres historicos guardados ni API que los de
  (odds-api.io no tiene endpoint historico; los picks solo guardaban la cuota de apuesta).
- La fuente del cierre es el scraper de Tor (cuotasahora Bet365), la MISMA que alimenta las
  cuotas de apuesta -- usar odds-api.io aqui sesgaria la medida (su feed 'Bet365' no coincide con
  bet365.com, decision del usuario 2026-07-20).
- NO re-dispara pipelines ni sobreescribe game_odds: solo lee la linea y la guarda aparte.
- Desactivada por defecto (CLV_CAPTURE_ENABLED): anade scrapes de Tor extra cerca del cierre.
"""
import datetime as dt
import json
import logging

from app import aliases
from app.node_bridge import NodeBridgeError, run_odds_scraper
from app.odds_autofetch import (
    SCRAPER_LEAGUE, _match_scraped_game, _scrape_semaphore, _values_from_scraped,
)
from app.pipelines import LEAGUE_LABEL, PipelineContext

logger = logging.getLogger(__name__)

# Partidos que arrancan dentro de estos minutos. Con el tick cada ~5min, el cierre se captura
# ~0-20min antes del inicio (proxy estandar de 'closing line').
CAPTURE_WINDOW_MIN = 20


def _side_base(side: str) -> str:
    return (side or "").strip().lower().split(" ")[0]


def closing_for_pick(values: dict, market: str, side: str):
    """(closing_odds_del_lado, closing_odds_contrario, closing_line) desde el dict 'values' de
    _values_from_scraped, segun el mercado/lado del pick. None si esa linea no vino en el scrape."""
    m = (market or "").upper()
    s = _side_base(side)
    if m == "ML":
        return (values["away_ml"], values["home_ml"], None) if s == "away" \
            else (values["home_ml"], values["away_ml"], None)
    if m in ("OU", "OVER", "UNDER"):
        over = (m == "OVER") or (s == "over")
        return (values["over_odds"], values["under_odds"], values["total_line"]) if over \
            else (values["under_odds"], values["over_odds"], values["total_line"])
    if m.startswith("HC"):
        if s == "home" or m == "HC_HOME":
            return values["home_hc_odds"], values["away_hc_odds"], values["home_hc_val"]
        return values["away_hc_odds"], values["home_hc_odds"], values["away_hc_val"]
    return None, None, None


async def _published_picks_starting_soon(ctx: PipelineContext) -> list[dict]:
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT r.sport_id, r.game_pk, r.best_pick,
                   g.away_team_name, g.home_team_name, g.game_datetime_utc
            FROM pipeline_runs r
            JOIN games_gate_state g ON g.sport_id = r.sport_id AND g.game_pk = r.game_pk
            WHERE r.published = true AND r.best_pick IS NOT NULL
              AND g.game_datetime_utc BETWEEN now() AND now() + interval '{CAPTURE_WINDOW_MIN} minutes'
            """
        )
    out = []
    for r in rows:
        bp = r["best_pick"]
        bp = json.loads(bp) if isinstance(bp, str) else bp
        if not bp:
            continue
        out.append({
            "sport_id": r["sport_id"], "game_pk": r["game_pk"],
            "away_team_name": r["away_team_name"], "home_team_name": r["home_team_name"],
            "game_datetime_utc": r["game_datetime_utc"],
            "market": bp.get("market"), "pick_side": bp.get("pick_side"),
        })
    return out


async def _already_captured(ctx: PipelineContext, game_pks: list) -> set:
    if not game_pks:
        return set()
    ids = ",".join(str(g) for g in sorted(set(game_pks)))
    rows = await ctx.supabase.select(
        ctx.http_client, "pick_closing_lines",
        {"game_pk": f"in.({ids})", "select": "game_pk,market,pick_side"},
    )
    return {(str(r["game_pk"]), r["market"], r["pick_side"]) for r in rows}


async def _capture_league(ctx: PipelineContext, sport_id: int, picks: list[dict], now: dt.datetime) -> int:
    league_key = SCRAPER_LEAGUE.get(sport_id)
    if not league_key:
        return 0
    cands = [
        aliases.CandidateGame(
            sport_id=sport_id, game_pk=p["game_pk"], away_team_id=None, home_team_id=None,
            away_team_name=p["away_team_name"], home_team_name=p["home_team_name"],
            game_datetime_utc=p["game_datetime_utc"],
        ) for p in picks
    ]
    names = [n for c in cands for n in (c.away_team_name, c.home_team_name) if n]
    proxy = ctx.proxy_server_lmb if (sport_id == 23 and ctx.proxy_server_lmb) else ctx.proxy_server
    try:
        async with _scrape_semaphore:
            result = await run_odds_scraper(
                ctx.node_bin, ctx.vendor_dir, league_key,
                proxy, candidate_names=names,
            )
    except NodeBridgeError as e:
        logger.warning("CLV: scraper fallo para %s: %s", league_key, e)
        return 0

    to_insert = []
    for scraped in (result.get("games") or []):
        cand = _match_scraped_game(scraped, cands)
        if cand is None:
            continue
        values = _values_from_scraped(scraped)
        for p in picks:
            if p["game_pk"] != cand.game_pk:
                continue
            close, opp, line = closing_for_pick(values, p["market"], p["pick_side"])
            if close is None:
                continue
            gdt = cand.game_datetime_utc
            if gdt is not None and gdt.tzinfo is None:
                gdt = gdt.replace(tzinfo=dt.timezone.utc)
            mins = round((gdt - now).total_seconds() / 60, 1) if gdt else None
            to_insert.append({
                "game_pk": str(cand.game_pk), "league": LEAGUE_LABEL.get(sport_id),
                "market": p["market"], "pick_side": _side_base(p["pick_side"]),
                "closing_odds": close, "closing_opp_odds": opp, "closing_line": line,
                "minutes_to_start": mins, "bookmaker": "Bet365", "source": "cuotasahora",
                "captured_at": now.isoformat(),
            })
    if to_insert:
        try:
            await ctx.supabase.insert(ctx.http_client, "pick_closing_lines", to_insert)
            logger.info("CLV: %s cierres capturados (%s)", len(to_insert), league_key)
        except Exception:
            logger.exception("CLV: fallo guardando pick_closing_lines (%s)", league_key)
    return len(to_insert)


async def capture_closing_lines_tick(ctx: PipelineContext) -> None:
    """Tick periodico (APScheduler). Idempotente: pre-check de ya-capturados + UNIQUE en la tabla.
    No debe tumbar el scheduler pase lo que pase -> todo envuelto en try/except."""
    try:
        picks = await _published_picks_starting_soon(ctx)
        if not picks:
            return
        captured = await _already_captured(ctx, [p["game_pk"] for p in picks])
        pending = [p for p in picks
                   if (str(p["game_pk"]), p["market"], _side_base(p["pick_side"])) not in captured]
        if not pending:
            return
        by_sport: dict[int, list] = {}
        for p in pending:
            by_sport.setdefault(p["sport_id"], []).append(p)
        now = dt.datetime.now(dt.timezone.utc)
        for sport_id, sport_picks in by_sport.items():
            await _capture_league(ctx, sport_id, sport_picks, now)
    except Exception:
        logger.exception("capture_closing_lines_tick fallo")
