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

Fix 2026-09-02 (auditoria de estado del CLV): con la ventana de captura activa desde ~2026-08-02,
solo 3 de 19 picks elegibles (Auto-Picks v2, ver CLAUDE.md) consiguieron cierre -- 15.8%, y encima
sin NINGUN rastro de por que fallo el resto: _capture_league() hacia un unico intento de scrape por
tick, sin reintentar ni rotar circuito si salia vacio/fallaba (a diferencia de
odds_autofetch.autofetch_single_game, que desde 2026-08-02 reintenta con NEWNYM entre intentos), y
sin llamar a record_activity() nunca -- un fallo de captura no dejaba NINGUNA fila en tor_activity,
ni exito ni fracaso. Con una ventana de solo 20 minutos y CLV_CAPTURE_INTERVAL_SECONDS=300 por
defecto, cada pick tenia como mucho ~3-4 intentos repartidos entre ticks, cada uno de un solo tiro.
Mismo patron ya visto y corregido en el flujo principal de cuotas (misma leccion del proyecto: "si
algo falla y no sabes por que, instrumentar primero"). Aplicado aqui el mismo patron de
autofetch_single_game: reintento con rotacion de circuito + backoff dentro de un mismo tick (tope
bajo, CAPTURE_RETRIES=2 intentos extra, para no competir de mas con el resto del sistema por el
semaforo de Tor) y record_activity() en cada intento (source="clv"), visible en el dashboard igual
que el resto de scrapes.
"""
import asyncio
import datetime as dt
import json
import logging

from app import aliases
from app.node_bridge import NodeBridgeError, run_odds_scraper
from app.odds_autofetch import (
    AUTOFETCH_BACKOFF_S, SCRAPER_LEAGUE, _match_scraped_game, _scrape_semaphore, _values_from_scraped,
)
from app.pipelines import LEAGUE_LABEL, PipelineContext
from app.tor_control import record_activity, rotate_tor_circuit

logger = logging.getLogger(__name__)

# Partidos que arrancan dentro de estos minutos. Con el tick cada ~5min, el cierre se captura
# ~0-20min antes del inicio (proxy estandar de 'closing line').
CAPTURE_WINDOW_MIN = 20

# Reintentos EXTRA dentro de un mismo tick si el scrape sale vacio/falla (2026-09-02). Bajo a
# proposito: la ventana ya es corta (20 min) y el propio tick (cada
# CLV_CAPTURE_INTERVAL_SECONDS, 300s por defecto) vuelve a intentarlo -- esto es para no perder
# TODOS los intentos de un tick a un solo tiro de mala suerte con el circuito de Tor, no para
# competir de mas con el resto del sistema por el semaforo.
CAPTURE_RETRIES = 2


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
    # Minutos hasta el partido MAS PROXIMO de este lote -- si ya esta a <2 min, no tiene sentido
    # seguir reintentando (mismo corte que autofetch_single_game): para entonces la ventana de
    # captura casi ha cerrado y un reintento mas solo consumiria turno del semaforo sin utilidad.
    def _min_minutes_to_start() -> float | None:
        vals = []
        for p in picks:
            gdt = p.get("game_datetime_utc")
            if gdt is None:
                continue
            if gdt.tzinfo is None:
                gdt = gdt.replace(tzinfo=dt.timezone.utc)
            vals.append((gdt - dt.datetime.now(dt.timezone.utc)).total_seconds() / 60)
        return min(vals) if vals else None

    total_inserted = 0
    pending = list(picks)
    for attempt in range(1 + CAPTURE_RETRIES):
        status = "empty"
        games = []
        t0 = asyncio.get_event_loop().time()
        try:
            async with _scrape_semaphore:
                result = await run_odds_scraper(
                    ctx.node_bin, ctx.vendor_dir, league_key,
                    proxy, candidate_names=names,
                )
            games = result.get("games") or []
            if games:
                status = "ok"
            elif result.get("wrong_catalog"):
                status = "wrong_catalog"
        except NodeBridgeError as e:
            logger.warning("CLV: scraper fallo para %s: %s", league_key, e)
            status = "scraper_failed"
        duration_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
        await record_activity(
            ctx.pool, "scrape", ok=bool(games), sport_id=sport_id, league=league_key,
            status=status, n_candidates=len(pending), n_scraped=len(games),
            duration_ms=duration_ms, source="clv",
        )

        to_insert = []
        matched_pks = set()
        for scraped in games:
            cand = _match_scraped_game(scraped, cands)
            if cand is None:
                continue
            values = _values_from_scraped(scraped)
            for p in pending:
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
                matched_pks.add(p["game_pk"])
        if to_insert:
            try:
                await ctx.supabase.insert(ctx.http_client, "pick_closing_lines", to_insert)
                logger.info("CLV: %s cierres capturados (%s, intento %s)", len(to_insert), league_key, attempt + 1)
                total_inserted += len(to_insert)
            except Exception:
                logger.exception("CLV: fallo guardando pick_closing_lines (%s)", league_key)

        pending = [p for p in pending if p["game_pk"] not in matched_pks]
        if not pending:
            break  # ya se capturo cierre para todos los picks pedidos
        if status not in ("empty", "scraper_failed", "wrong_catalog"):
            break  # trajo pagina real pero no matcheo -- reintentar no lo arregla, es problema de nombres
        if attempt >= CAPTURE_RETRIES:
            break
        mins_to_start = _min_minutes_to_start()
        if mins_to_start is not None and mins_to_start < 2:
            logger.info("CLV: %s a <2min del inicio mas cercano -- no se reintenta mas", league_key)
            break
        ok, detail = await rotate_tor_circuit()
        logger.info("CLV retry %s/%s (%s) %s -- NEWNYM %s (%s)",
                     attempt + 1, CAPTURE_RETRIES, status, league_key, "ok" if ok else "FALLO", detail)
        await record_activity(
            ctx.pool, "rotate", ok=ok, sport_id=sport_id, league=league_key,
            status=f"retry_{status}", detail=detail, source="clv_retry",
        )
        await asyncio.sleep(AUTOFETCH_BACKOFF_S[min(attempt, len(AUTOFETCH_BACKOFF_S) - 1)])
    return total_inserted


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
