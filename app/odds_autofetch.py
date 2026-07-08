"""Obtiene cuotas automaticamente de cuotasahora.com (vendor/run_odds_scraper.js) para los
partidos que el detector ya tiene con al menos Gate A confirmado, sin esperar a que alguien
las pegue por Telegram. Reutiliza exactamente la misma logica de validacion/guardado/disparo
que message_handler.py usa para las cuotas manuales -- asi el camino automatico y el manual
convergen en el mismo sitio (_store_odds, _check_gates_and_fire), sin divergencia de reglas.

Corre en un job de APScheduler separado del detector (ver main.py), a un intervalo mucho mas
largo (por defecto 900s) -- cada ciclo scrapea la liga ENTERA en cuotasahora.com, no solo el
partido que hace falta, asi que hay que ser conservador con la frecuencia para no arriesgarse a
otro bloqueo de IP como el que ya sufrio el VPS de Francia."""
import logging

import asyncpg

from app import aliases
from app.message_handler import _check_gates_and_fire, _store_odds
from app.node_bridge import NodeBridgeError, run_odds_scraper
from app.overround import check_overround
from app.pipelines import LEAGUE_KEY, LEAGUE_LABEL, PipelineContext

logger = logging.getLogger(__name__)

SCRAPER_LEAGUE = {1: "MLB", 11: "MiLB", 23: "LMB"}
MIN_MATCH_SCORE = 4  # 2x score()==2 minimo, o un exacto (3) + parcial (1) -- evita matches debiles
GAMES_WINDOW_SQL = (
    "game_datetime_utc BETWEEN now() - interval '1 hour' AND now() + interval '6 hours'"
)

# Estado en memoria (se pierde en cada reinicio, no es critico) -- solo para no mandar el
# mismo aviso de "cuotasahora.com no responde" al admin en cada ciclo si sigue bloqueado.
_last_status: dict[int, bool] = {}


async def _candidates_needing_odds(pool: asyncpg.Pool, sport_id: int) -> list[aliases.CandidateGame]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT g.sport_id, g.game_pk, g.away_team_id, g.home_team_id,
                   g.away_team_name, g.home_team_name
            FROM games_gate_state g
            LEFT JOIN game_odds o ON o.sport_id = g.sport_id AND o.game_pk = g.game_pk
            WHERE g.sport_id = $1
              AND g.pitchers_confirmed_at IS NOT NULL
              AND g.{GAMES_WINDOW_SQL}
              AND (o.game_pk IS NULL OR o.away_ml IS NULL OR o.total_line IS NULL)
            """,
            sport_id,
        )
    return [
        aliases.CandidateGame(
            sport_id=r["sport_id"], game_pk=r["game_pk"], away_team_id=r["away_team_id"],
            home_team_id=r["home_team_id"], away_team_name=r["away_team_name"],
            home_team_name=r["home_team_name"], game_datetime_utc=None,
        )
        for r in rows
    ]


def _match_scraped_game(scraped: dict, candidates: list[aliases.CandidateGame]) -> aliases.CandidateGame | None:
    """A diferencia de aliases.match_game() no hay ambiguedad de orden -- el scraper ya resuelve
    home/away real del sitio, asi que solo hace falta comparar away<->away y home<->home. Guardia
    anti-ambiguedad igual de estricta: si el segundo mejor empata o casi, no asignar (mejor
    perder una cuota que asignarla al partido equivocado)."""
    scored = []
    for c in candidates:
        s = aliases.score(scraped.get("away_team"), c.away_team_name) + aliases.score(scraped.get("home_team"), c.home_team_name)
        if s < MIN_MATCH_SCORE:
            continue
        scored.append((s, c))
    if not scored:
        return None
    scored.sort(key=lambda t: t[0], reverse=True)
    if len(scored) > 1 and scored[1][0] >= scored[0][0]:
        return None
    return scored[0][1]


def _values_from_scraped(game: dict) -> dict:
    ml = game.get("moneyline") or {}
    total = game.get("total") or {}
    rl = game.get("run_line") or {}
    rl_home, rl_away = rl.get("home") or {}, rl.get("away") or {}

    values = {
        "away_ml": None, "home_ml": None,
        "away_hc_val": None, "away_hc_odds": None, "home_hc_val": None, "home_hc_odds": None,
        "total_line": None, "over_odds": None, "under_odds": None,
    }

    if ml.get("away") is not None and ml.get("home") is not None:
        chk = check_overround(ml["away"], ml["home"])
        if chk.ok:
            values["away_ml"], values["home_ml"] = ml["away"], ml["home"]

    if rl_away.get("odds") is not None and rl_home.get("odds") is not None:
        chk = check_overround(rl_away["odds"], rl_home["odds"])
        if chk.ok:
            values["away_hc_val"], values["away_hc_odds"] = rl_away.get("line"), rl_away["odds"]
            values["home_hc_val"], values["home_hc_odds"] = rl_home.get("line"), rl_home["odds"]

    if total.get("over_odds") is not None and total.get("under_odds") is not None:
        chk = check_overround(total["over_odds"], total["under_odds"])
        if chk.ok:
            values["total_line"], values["over_odds"], values["under_odds"] = (
                total.get("line"), total["over_odds"], total["under_odds"],
            )

    return values


async def _notify_status_change(ctx: PipelineContext, sport_id: int, ok: bool, detail: str) -> None:
    prev = _last_status.get(sport_id)
    _last_status[sport_id] = ok
    if prev is ok:
        return  # sin cambio de estado, no repetir el aviso en cada ciclo
    label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    if ok:
        await ctx.telegram.send_message(ctx.admin_chat_id, f"✅ Cuotas automáticas {label}: cuotasahora.com vuelve a responder.")
    else:
        await ctx.telegram.send_message(ctx.admin_chat_id, f"⚠️ Cuotas automáticas {label}: {detail}")


async def autofetch_league(ctx: PipelineContext, sport_id: int) -> None:
    candidates = await _candidates_needing_odds(ctx.pool, sport_id)
    if not candidates:
        return  # nada que buscar en esta liga ahora mismo -- no hace falta scrapear nada

    league_key = SCRAPER_LEAGUE[sport_id]
    candidate_names = [n for c in candidates for n in (c.away_team_name, c.home_team_name) if n]
    try:
        result = await run_odds_scraper(
            ctx.node_bin, ctx.vendor_dir, league_key,
            ctx.proxy_server, ctx.proxy_username, ctx.proxy_password,
            candidate_names=candidate_names,
        )
    except NodeBridgeError as e:
        logger.warning("run_odds_scraper fallo para %s: %s", league_key, e)
        await _notify_status_change(ctx, sport_id, False, f"scraper falló: {str(e)[:200]}")
        return

    games = result.get("games") or []
    if not games and result.get("errors"):
        await _notify_status_change(ctx, sport_id, False, f"sin partidos, {result['errors'][0][:180]}")
        return
    await _notify_status_change(ctx, sport_id, True, "")

    remaining = list(candidates)
    matched_count = 0
    for scraped in games:
        cand = _match_scraped_game(scraped, remaining)
        if cand is None:
            continue
        values = _values_from_scraped(scraped)
        if all(v is None for v in values.values()):
            continue

        await _store_odds(ctx.pool, cand.sport_id, cand.game_pk, values, chat_id=0, message_id=0)
        matched_count += 1
        remaining = [c for c in remaining if c.game_pk != cand.game_pk]

        learn_away = cand.away_team_id
        learn_home = cand.home_team_id
        if learn_away is not None:
            await aliases.learn_alias(ctx.pool, cand.sport_id, scraped.get("away_team", ""), learn_away, cand.away_team_name)
        if learn_home is not None:
            await aliases.learn_alias(ctx.pool, cand.sport_id, scraped.get("home_team", ""), learn_home, cand.home_team_name)

        await _check_gates_and_fire(ctx, cand.sport_id, cand.game_pk, cand.away_team_name, cand.home_team_name)

    logger.info(
        "autofetch %s: %s candidatos, %s partidos scrapeados, %s asignados",
        league_key, len(candidates), len(games), matched_count,
    )


async def autofetch_tick(ctx: PipelineContext) -> None:
    for sport_id in LEAGUE_KEY:
        try:
            await autofetch_league(ctx, sport_id)
        except Exception:
            logger.exception("autofetch_tick fallo para sport_id=%s", sport_id)
