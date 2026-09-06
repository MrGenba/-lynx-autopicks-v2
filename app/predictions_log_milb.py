"""`predictions_log` para MiLB: el mu del modelo de TODOS los partidos del dia, tengan cuotas o no.

POR QUE (2026-09-06): hoy solo se conserva el `mu` de los partidos que consiguieron cuotas -- 237
de ~1.700 con marcador. Esa muestra tiene **sesgo de seleccion**: son los partidos que alguien
scrapeo con exito, no una muestra aleatoria. Con ella, el sesgo de nivel del modelo sale -0.350
±0.326 (t=-1.08, o sea nada) y cambia de signo cada mes (-0.86 en mayo, +1.57 en julio, -0.94 en
septiembre). No se puede decidir si hay que recalibrar `calibration_factor` con eso.

MLB resolvio esto en 2026-07-13 con el mismo patron y hoy tiene 230 filas limpias. MiLB nunca lo
tuvo (`predictions_log` con league='MiLB' esta a 0). Esto lo monta.

QUE HACE: una vez al dia coge los partidos MiLB del dia, arma el objeto de matchup con el adaptador
de siempre (no necesita cuotas), corre el motor y guarda mu + probabilidades a una linea ESTANDAR
fija. Nada mas: no publica, no evalua candidatos, no toca `game_odds` ni `*_candidates_history`.

La linea estandar (STD_LINE) es fija a proposito: lo que se quiere medir es el `mu` del modelo, y
para que las probabilidades sean comparables entre dias tienen que estar evaluadas siempre contra
el mismo numero. NO es la linea del mercado.

Coste: ~15 partidos/dia x (1 lectura de matchup + 1 proceso de node). Sin Tor, sin scraping.
"""
import asyncio
import datetime as dt
import logging
import re
from pathlib import Path
from typing import Optional

from app.node_bridge import NodeBridgeError, run_quant

logger = logging.getLogger(__name__)

SPORT_ID = 11
LEAGUE_KEY = "milb"      # clave que espera run_quant.js (minusculas); la etiqueta de BD es "MiLB"
LEAGUE_LABEL = "MiLB"
TABLA = "predictions_log"


# Linea de referencia fija para que las probabilidades sean comparables entre dias. 9.5 es la
# mediana historica de las lineas de MiLB; el valor exacto da igual mientras no cambie.
STD_LINE = 9.5


def _nb_k_del_motor(vendor_dir: str) -> Optional[float]:
    """Lee el nb_k de MiLB del propio quant_engine.js en vez de duplicar el numero aqui. Si se
    recalibra el motor, esto lo sigue solo -- duplicarlo a mano es exactamente como la tabla de
    CLAUDE.md acabo diciendo 7 cuando el motor llevaba dos meses en 3.7."""
    try:
        texto = (Path(vendor_dir) / "quant_engine.js").read_text(encoding="utf-8", errors="ignore")
        bloque = re.search(r"11:\s*\{.*?nb_k:\s*([\d.]+)", texto, re.S)
        return float(bloque.group(1)) if bloque else None
    except Exception:
        logger.warning("predictions_log MiLB: no se pudo leer nb_k del motor")
        return None

STATS_API = "https://statsapi.mlb.com/api/v1"


async def _partidos_de_hoy(ctx) -> list[dict]:
    """El calendario Y los abridores se leen de la API EN VIVO, no de `daily_games`.

    Verificado el 2026-09-06 a las 17:55 UTC: `daily_games` tenia los dos abridores en **1 de 21**
    partidos mientras la API ya publicaba **12 de 15**. El sync de Supabase va por detras, y sin
    pitcher_id el adaptador devuelve None -- o sea que leer de Supabase habria dejado esta tabla
    con un 5% de cobertura y con el mismo sesgo de seleccion que viene a eliminar.

    El adaptador acepta los pitcher_id como fallback precisamente para este caso (lo dice su
    docstring), que es lo que hace el detector desde siempre.
    """
    hoy = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    r = await ctx.http_client.get(
        f"{STATS_API}/schedule", params={"sportId": 11, "date": hoy, "hydrate": "probablePitcher"},
        timeout=20.0,
    )
    r.raise_for_status()
    partidos = []
    for dia in r.json().get("dates", []):
        for g in dia.get("games", []):
            away = (g.get("teams", {}).get("away", {}) or {})
            home = (g.get("teams", {}).get("home", {}) or {})
            ap, hp = away.get("probablePitcher"), home.get("probablePitcher")
            partidos.append({
                "game_id": g["gamePk"],
                "game_date": hoy,
                "away_team_name": (away.get("team") or {}).get("name"),
                "home_team_name": (home.get("team") or {}).get("name"),
                "away_pitcher_id": ap.get("id") if ap else None,
                "home_pitcher_id": hp.get("id") if hp else None,
            })
    return partidos


async def _ya_guardado(ctx, game_pk: int) -> bool:
    fila = await ctx.supabase.select_one(ctx.http_client, TABLA, {
        "select": "id", "game_pk": f"eq.{game_pk}", "league": "eq.MiLB",
    })
    return fila is not None


async def capture_predictions_tick(ctx) -> None:
    """Una pasada diaria. Cada partido va por separado y con su propio try: que uno falle (sin
    abridor, sin stats, motor que revienta) no puede dejar sin guardar a los demas."""
    adapter = ctx.adapters.get(SPORT_ID)
    if adapter is None:
        logger.warning("predictions_log MiLB: no hay adaptador para sport_id=%s", SPORT_ID)
        return
    try:
        partidos = await _partidos_de_hoy(ctx)
    except Exception:
        logger.exception("predictions_log MiLB: no se pudo leer el calendario")
        return
    if not partidos:
        logger.info("predictions_log MiLB: sin partidos hoy")
        return

    logger.info("predictions_log MiLB: %s partidos del dia", len(partidos))
    guardados = sin_datos = errores = repetidos = 0

    for p in partidos:
        game_pk = p["game_id"]
        try:
            if await _ya_guardado(ctx, game_pk):
                repetidos += 1
                continue

            game_obj = await adapter.build_game_object(
                game_pk, "pitchers_only",
                p.get("away_pitcher_id"), p.get("home_pitcher_id"), None,
            )
            if game_obj is None:
                sin_datos += 1
                continue

            # Sin cuotas: solo se le pasa la linea estandar para que calcule p_over/p_under. El
            # motor no necesita precios para producir mu -- los candidatos saldran vacios y da igual.
            payload = {
                "game": game_obj,
                "away_ml": None, "home_ml": None,
                "away_hc_val": None, "away_hc_odds": None,
                "home_hc_val": None, "home_hc_odds": None,
                "total_line": STD_LINE, "over_odds": None, "under_odds": None,
            }
            resultado = await run_quant(ctx.node_bin, ctx.vendor_dir, LEAGUE_KEY, payload)

            fila = {
                "game_pk": game_pk,
                "league": LEAGUE_LABEL,
                "game_date": str(p.get("game_date", ""))[:10],
                "mu_away": resultado.get("away_runs"),
                "mu_home": resultado.get("home_runs"),
                "k_usado": _nb_k_del_motor(ctx.vendor_dir),
                "std_line": STD_LINE,
                "p_over_std": resultado.get("over_win"),
                "p_under_std": resultado.get("under_win"),
                "p_ml_away": resultado.get("away_ml_win"),
                "p_ml_home": resultado.get("home_ml_win"),
                "data_score": resultado.get("data_score"),
            }
            if fila["mu_away"] is None or fila["mu_home"] is None:
                sin_datos += 1
                continue

            await ctx.supabase.insert(ctx.http_client, TABLA, [fila])
            guardados += 1

        except NodeBridgeError:
            logger.warning("predictions_log MiLB: el motor fallo para game_pk=%s", game_pk)
            errores += 1
        except Exception:
            logger.exception("predictions_log MiLB: fallo inesperado en game_pk=%s", game_pk)
            errores += 1
        # respiro entre partidos: 15 procesos de node seguidos no aportan nada por ir mas rapido
        await asyncio.sleep(0.5)

    logger.info(
        "predictions_log MiLB: %s guardados, %s ya estaban, %s sin datos suficientes, %s errores",
        guardados, repetidos, sin_datos, errores,
    )
