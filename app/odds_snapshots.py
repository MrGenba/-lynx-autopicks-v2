"""Dos fotos de la MISMA linea por partido, para medir si el mercado reacciona al anuncio de los
abridores.

POR QUE (2026-09-06, a raiz de una observacion del usuario): en MiLB los abridores se anuncian **el
mismo dia**. Verificado contra la API oficial: de los partidos de D+1, D+2 y D+3, CERO tienen los
dos abridores publicados (D+0: 67%). O sea que la casa cotiza sin ninguna informacion de pitcheo y
el dato aparece la misma mañana. Si la linea NO se mueve al aparecer, jugamos con informacion que
el precio no tiene; si se mueve, el problema es de velocidad y no de conocimiento.

Hoy eso no se puede medir: MiLB se mira UNA sola vez por partido (550 de 550), asi que no existe ni
una observacion de la misma linea en dos momentos. Este modulo crea esa observacion.

  fase='early'   foto temprana, antes de que se anuncien los abridores. UN scrape al dia para todo
                 el slate (el scraper acepta varios partidos por pasada via candidate_names).
  fase='gate_a'  la que ya capturamos al confirmarse los abridores. CERO scrapes extra: se copia
                 de lo que Gate A guarda de todos modos.

NO alimenta al motor, NO publica, NO toca `game_odds` ni `*_candidates_history`. Es telemetria.
Sirve ademas de sustituto rapido del CLV: mide lo mismo (¿nos da la razon el mercado despues?) sin
depender de la captura de cierre, que lleva 4 filas en un mes.
"""
import datetime as dt
import logging
from typing import Optional

from app import aliases
from app.node_bridge import NodeBridgeError, run_odds_scraper

logger = logging.getLogger(__name__)

# Solo MiLB de momento: es donde el usuario planteo la hipotesis y donde se verifico que los
# abridores salen el mismo dia. Ampliar cuando haya lectura de estos datos.
SCRAPER_LEAGUE = {11: "MiLB"}
LEAGUE_LABEL = {1: "MLB", 11: "MiLB", 23: "LMB"}
TABLA = "odds_snapshots"


def _valores(scraped: dict) -> dict:
    """Extrae las cuotas del formato del scraper. A diferencia de _values_from_scraped de
    odds_autofetch, aqui NO se filtra por overround: para telemetria interesa la linea tal cual
    la sirvio el sitio, incluso si es rara -- justo esas son las interesantes."""
    ml = scraped.get("moneyline") or {}
    total = scraped.get("total") or {}
    rl = scraped.get("run_line") or {}
    rl_home, rl_away = rl.get("home") or {}, rl.get("away") or {}
    return {
        "away_ml": ml.get("away"), "home_ml": ml.get("home"),
        "total_line": total.get("line"), "over_odds": total.get("over_odds"),
        "under_odds": total.get("under_odds"),
        "away_hc_val": rl_away.get("line"), "away_hc_odds": rl_away.get("odds"),
        "home_hc_val": rl_home.get("line"), "home_hc_odds": rl_home.get("odds"),
    }


async def guardar(ctx, sport_id: int, game_pk: int, fase: str, valores: dict,
                  away_team: str = None, home_team: str = None,
                  game_date=None, starters_known: Optional[bool] = None) -> None:
    """Escribe una foto. Nunca revienta al llamador: si Supabase falla, se registra y se sigue --
    esto es telemetria, no puede tumbar el pipeline de picks."""
    if all(v is None for v in valores.values()):
        return
    fila = {
        "game_id": game_pk, "liga": LEAGUE_LABEL.get(sport_id, str(sport_id)),
        "fase": fase, "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "starters_known": starters_known,
        "away_team": away_team, "home_team": home_team,
        "source": "autopicks_v2", **valores,
    }
    if game_date is not None:
        fila["game_date"] = str(game_date)[:10]
    try:
        # merge-duplicates + on_conflict: sin on_conflict PostgREST NO sabe que restriccion unica
        # usar y devuelve 409 en vez de actualizar (verificado contra la tabla real 2026-09-06).
        # Y hay que mirar el status a mano: httpx no lanza por si solo, asi que sin esto un 409
        # pasaria en silencio y no se guardaria nada.
        resp = await ctx.http_client.post(
            f"{ctx.supabase.base_url}/rest/v1/{TABLA}?on_conflict=game_id,fase",
            headers={**ctx.supabase.headers, "Content-Type": "application/json",
                     "Prefer": "return=minimal,resolution=merge-duplicates"},
            json=[fila], timeout=15.0,
        )
        if resp.status_code >= 300:
            logger.warning("odds_snapshots: %s al guardar fase=%s game_pk=%s -- %s",
                           resp.status_code, fase, game_pk, resp.text[:200])
    except Exception:
        logger.exception("odds_snapshots: fallo guardando foto fase=%s game_pk=%s", fase, game_pk)


async def _partidos_de_hoy(ctx, sport_id: int) -> list[dict]:
    """Los partidos del dia se leen de SUPABASE (daily_games), no de games_gate_state: a la hora de
    la foto temprana todavia no han entrado en la ventana de 6h del detector, asi que la tabla
    interna aun no los tiene."""
    hoy = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    return await ctx.supabase.select(ctx.http_client, "daily_games", {
        "select": "game_id,game_date,away_team_name,home_team_name,away_pitcher_id,home_pitcher_id",
        "game_date": f"gte.{hoy}",
        "order": "game_id.asc",
        "limit": "60",
    })


async def capture_early_snapshot_tick(ctx) -> None:
    """Una pasada al dia, temprano: foto de la linea de TODO el slate antes de que se anuncien los
    abridores. UN solo scrape -- el scraper filtra por candidate_names y visita varios partidos en
    la misma pasada, igual que hace el sondeo periodico."""
    for sport_id, league_key in SCRAPER_LEAGUE.items():
        try:
            partidos = await _partidos_de_hoy(ctx, sport_id)
        except Exception:
            logger.exception("odds_snapshots: no se pudo leer el calendario de %s", league_key)
            continue
        hoy = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        partidos = [p for p in partidos if str(p.get("game_date", ""))[:10] == hoy]
        if not partidos:
            logger.info("odds_snapshots: sin partidos de %s hoy -- nada que fotografiar", league_key)
            continue

        nombres = [n for p in partidos for n in (p.get("away_team_name"), p.get("home_team_name")) if n]
        logger.info("odds_snapshots: foto temprana de %s -- %s partidos, un solo scrape",
                    league_key, len(partidos))
        try:
            resultado = await run_odds_scraper(
                ctx.node_bin, ctx.vendor_dir, league_key, ctx.proxy_server,
                candidate_names=nombres,
            )
        except NodeBridgeError as e:
            logger.warning("odds_snapshots: el scraper fallo para %s: %s", league_key, e)
            continue

        juegos = resultado.get("games") or []
        if not juegos:
            # Info en si misma: puede que la casa aun no haya publicado la linea a esta hora.
            logger.info("odds_snapshots: %s no devolvio partidos en la foto temprana (¿linea aun sin publicar?)",
                        league_key)
            continue

        candidatos = [
            aliases.CandidateGame(
                sport_id=sport_id, game_pk=p["game_id"],
                away_team_id=None, home_team_id=None,
                away_team_name=p.get("away_team_name") or "", home_team_name=p.get("home_team_name") or "",
                game_datetime_utc=None,
            ) for p in partidos
        ]
        por_pk = {p["game_id"]: p for p in partidos}

        # import diferido: _match_scraped_game vive en odds_autofetch, que importa este modulo
        from app.odds_autofetch import _match_scraped_game

        guardados = 0
        for scraped in juegos:
            cand = _match_scraped_game(scraped, candidatos)
            if cand is None:
                continue
            p = por_pk.get(cand.game_pk, {})
            abridores = bool(p.get("away_pitcher_id")) and bool(p.get("home_pitcher_id"))
            await guardar(
                ctx, sport_id, cand.game_pk, "early", _valores(scraped),
                away_team=cand.away_team_name, home_team=cand.home_team_name,
                game_date=p.get("game_date"), starters_known=abridores,
            )
            guardados += 1
        logger.info("odds_snapshots: %s -- %s scrapeados, %s fotos guardadas",
                    league_key, len(juegos), guardados)
