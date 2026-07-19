"""Cliente de odds-api.io (2026-07-11) -- fuente de cuotas primaria nueva, API real (no
scraping). Se probo en vivo: cubre las 3 ligas del proyecto con nombres de liga exactos, y el
plan gratuito de esta cuenta trae Bet365 + Betano ya fijados en la LLAMADA a la API (no se
puede pedir menos), pero eso no significa que haya que aceptar cualquiera de las dos como
respuesta valida. Si no encuentra el partido o la casa PEDIDA no tiene cuotas todavia, devuelve
None -- el llamador (odds_autofetch.py o /scrape-odds/*) cae al scraper de Tor como respaldo,
no se borra ese camino.

2026-07-20 CORREGIDO: hasta ahora, si Bet365 no tenia mercados para un evento concreto, el
codigo caia en silencio a Betano -- devolvia los valores igualmente (con bookmaker="Betano"
guardado correctamente puertas adentro), pero nada rio abajo (el nodo n8n "Actualizar Cuotas
bet365") comprobaba ese campo antes de mostrarlo bajo la cabecera "Bet365" para TODOS los
partidos de la lista. Bug real reportado en vivo por el usuario comparando Baltimore Orioles @
Houston Astros: las cuotas mostradas (RL 2.75/1.47, Tot 1.95/1.86, ML 2.00/1.83) no coincidian
con bet365 real (RL 2.65/1.45, Tot 1.91/1.82, ML 2.01/1.76) -- consistente con Betano, no con
cuotas movidas por el tiempo. Misma familia de bug que el arreglado el 2026-07-18 en
pickBookmaker() (scraper de Tor), aqui sin tocar hasta ahora. Ahora get_odds_for_game() y
get_league_odds() aceptan un parametro bookmaker explicito y SOLO devuelven esa casa -- nunca
sustituyen por otra en silencio, igual que ya se exige en el scraper de Tor."""
import datetime as dt
import logging
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from app import aliases
from app.overround import check_overround

logger = logging.getLogger(__name__)

BASE = "https://api.odds-api.io/v3"
BOOKMAKERS = "Bet365,Betano"  # fijados en el plan gratuito de esta cuenta, no configurable por query
MIN_MATCH_SCORE = 4  # mismo umbral que odds_autofetch._match_scraped_game -- evita matches debiles
MADRID_TZ = ZoneInfo("Europe/Madrid")  # hora correcta (con DST real) para el formato "HH:MM"
# que consume produccion (n8n) -- a diferencia del desfase de 1h que se encontro en
# cuotasahora.com (ver memoria del proyecto), esto usa zoneinfo real, no depende de ninguna web.

# sport_id -> lista de slugs de liga en odds-api.io. MiLB AAA se reparte en las mismas 2 ligas
# (International League / Pacific Coast League) que ya combinabamos en el scraper de cuotasahora.
LEAGUE_SLUGS: dict[int, list[str]] = {
    1: ["usa-mlb"],
    11: ["usa-milb-triple-a-international-league", "usa-milb-triple-a-pacific-coast-league"],
    23: ["mexico-mexican-league"],
}

# league_key (el que usa produccion, ver vendor/scraper_cuotasahora.js LEAGUE_PATHS) -> sport_id
LEAGUE_KEY_TO_SPORT_ID: dict[str, int] = {"MLB": 1, "MiLB": 11, "LMB": 23}


async def _find_event_id(
    client: httpx.AsyncClient, api_key: str, sport_id: int,
    away_team_name: str, home_team_name: str, game_dt: dt.datetime,
) -> Optional[int]:
    slugs = LEAGUE_SLUGS.get(sport_id, [])
    if not slugs:
        return None
    # Ventana de +/- 6h alrededor de la hora real del partido -- suficiente margen para
    # cualquier retraso/adelanto de horario sin arrastrar partidos de otros dias.
    frm = (game_dt - dt.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
    to = (game_dt + dt.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")

    candidates = []
    for slug in slugs:
        try:
            resp = await client.get(
                f"{BASE}/events",
                params={"sport": "baseball", "league": slug, "status": "pending", "from": frm, "to": to, "apiKey": api_key},
                timeout=15.0,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("odds-api.io /events fallo para %s: %s", slug, e)
            continue
        events = data if isinstance(data, list) else data.get("data") or data.get("events") or []
        candidates.extend(events)

    if not candidates:
        return None

    # Desempate por cercania de fecha/hora, no solo por nombre de equipo -- bug real
    # encontrado en vivo: un doblete (2 partidos el mismo dia, mismos 2 equipos) puntuaba
    # exactamente igual por nombre y se descartaba como "ambiguo" aunque game_dt (la hora real
    # del partido concreto, ya conocida via MLB Stats API) apuntaba claramente a uno solo.
    def date_diff_seconds(ev: dict) -> float:
        try:
            ev_dt = dt.datetime.fromisoformat(ev["date"].replace("Z", "+00:00"))
            return abs((ev_dt - game_dt).total_seconds())
        except (KeyError, ValueError):
            return float("inf")

    scored = []
    for ev in candidates:
        s = aliases.score(away_team_name, ev.get("away", "")) + aliases.score(home_team_name, ev.get("home", ""))
        if s < MIN_MATCH_SCORE:
            continue
        scored.append((s, date_diff_seconds(ev), ev))
    if not scored:
        return None
    scored.sort(key=lambda t: (-t[0], t[1]))
    best_score, best_diff, best_ev = scored[0]
    # Solo ambiguo de verdad si otro candidato empata en AMBOS: mismo score Y practicamente
    # la misma hora (menos de 5 min de diferencia) -- un doblete real cae fuera de esto porque
    # sus horas de inicio difieren varias horas.
    if len(scored) > 1 and scored[1][0] == best_score and scored[1][1] < 300:
        logger.info("odds-api.io: match ambiguo para %s @ %s, se omite", away_team_name, home_team_name)
        return None
    return best_ev.get("id")


def _market_by_name(markets: list[dict], name: str) -> Optional[dict]:
    for m in markets:
        if m.get("name") == name:
            return m
    return None


def _f(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _values_from_markets(markets: list[dict]) -> dict:
    values = {
        "away_ml": None, "home_ml": None,
        "away_hc_val": None, "away_hc_odds": None, "home_hc_val": None, "home_hc_odds": None,
        "total_line": None, "over_odds": None, "under_odds": None,
    }

    ml = _market_by_name(markets, "ML")
    if ml and ml.get("odds"):
        row = ml["odds"][0]
        home_odds, away_odds = _f(row.get("home")), _f(row.get("away"))
        if home_odds is not None and away_odds is not None:
            chk = check_overround(away_odds, home_odds)
            if chk.ok:
                values["home_ml"], values["away_ml"] = home_odds, away_odds

    # Spread (run line) -- odds-api.io devuelve las dos orientaciones (hdp negativo = home
    # favorito, hdp positivo = away favorito) como filas separadas del mismo mercado. Se
    # prioriza la fila con hdp negativo (home favorito) como referencia, igual que hacia
    # pickMainLine({preferAbs:1.5}) en el scraper de cuotasahora -- el run line de beisbol es
    # casi siempre +/-1.5.
    spread = _market_by_name(markets, "Spread")
    if spread and spread.get("odds"):
        rows = spread["odds"]
        row = next((r for r in rows if _f(r.get("hdp")) is not None and _f(r["hdp"]) < 0), rows[0])
        hdp, home_odds, away_odds = _f(row.get("hdp")), _f(row.get("home")), _f(row.get("away"))
        if hdp is not None and home_odds is not None and away_odds is not None:
            chk = check_overround(away_odds, home_odds)
            if chk.ok:
                values["home_hc_val"], values["home_hc_odds"] = hdp, home_odds
                values["away_hc_val"], values["away_hc_odds"] = -hdp, away_odds

    totals = _market_by_name(markets, "Totals")
    if totals and totals.get("odds"):
        row = totals["odds"][0]
        line, over_odds, under_odds = _f(row.get("hdp")), _f(row.get("over")), _f(row.get("under"))
        if line is not None and over_odds is not None and under_odds is not None:
            chk = check_overround(over_odds, under_odds)
            if chk.ok:
                values["total_line"], values["over_odds"], values["under_odds"] = line, over_odds, under_odds

    return values


async def get_odds_for_game(
    api_key: str, sport_id: int, away_team_name: str, home_team_name: str, game_dt: dt.datetime,
    bookmaker: str = "Bet365",
) -> Optional[dict]:
    """None si no se encuentra el partido, o si la casa PEDIDA (bookmaker) no tiene cuotas
    todavia -- el llamador cae al scraper de Tor en ese caso. Nunca sustituye por la otra casa
    del plan (Betano) en silencio."""
    async with httpx.AsyncClient() as client:
        event_id = await _find_event_id(client, api_key, sport_id, away_team_name, home_team_name, game_dt)
        if event_id is None:
            return None

        try:
            resp = await client.get(
                f"{BASE}/odds",
                params={"eventId": event_id, "bookmakers": BOOKMAKERS, "apiKey": api_key},
                timeout=15.0,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("odds-api.io /odds fallo para eventId=%s: %s", event_id, e)
            return None

    bookmakers = data.get("bookmakers") or {}
    markets = bookmakers.get(bookmaker)
    if not markets:
        return None
    values = _values_from_markets(markets)
    if any(v is not None for v in values.values()):
        return values
    return None


def _values_to_scraper_shape(values: dict, away_team: str, home_team: str, event_date_iso: str, bookmaker: str) -> dict:
    """Convierte el dict 'values' (mismo formato que _store_odds) a la forma que ya esperaba
    el scraper de cuotasahora.com (games[]) -- asi produccion (n8n, validateGame/fmtGame) no
    necesita cambiar nada, solo cambia de donde viene el dict."""
    try:
        utc_dt = dt.datetime.fromisoformat(event_date_iso.replace("Z", "+00:00"))
        time_str = utc_dt.astimezone(MADRID_TZ).strftime("%H:%M")
    except (TypeError, ValueError):
        time_str = None

    game = {
        "league": None, "status": "scheduled", "time": time_str,
        "away_team": away_team, "home_team": home_team,
        "moneyline": {"home": values["home_ml"], "away": values["away_ml"]},
        "bookmaker": bookmaker,
    }
    if values["total_line"] is not None:
        game["total"] = {"line": values["total_line"], "over_odds": values["over_odds"], "under_odds": values["under_odds"]}
    if values["home_hc_val"] is not None:
        game["run_line"] = {
            "home": {"line": values["home_hc_val"], "odds": values["home_hc_odds"]},
            "away": {"line": values["away_hc_val"], "odds": values["away_hc_odds"]},
        }
    return game


async def get_league_odds(api_key: str, league_key: str, bookmaker: str = "Bet365") -> dict:
    """Equivalente a fetchLeagueOdds() del scraper de Tor, pero via odds-api.io -- mismo shape
    de vuelta ({league, games, errors, fetched_at}) para que /scrape-odds/* (main.py) pueda
    usar esto como reemplazo directo sin que produccion (n8n) note la diferencia. Solo se llama
    con bookmaker="Bet365" en la practica (ver main.py:_run_scrape_job, que salta esta via
    rapida por completo si se pide otra casa -- odds-api.io no tiene Winamax en el plan) pero se
    deja parametrizado por si el plan cambia.

    Bug real encontrado en vivo: sin filtro de fecha, /events?status=pending devuelve TODOS los
    partidos futuros de la liga (semanas/meses vista, ~950 para MLB) -- una llamada a /odds por
    cada uno agota el limite de 100 peticiones/hora del plan gratuito casi al instante (944
    errores 429 en la primera prueba). Se limita a una ventana de 30h desde ahora -- de sobra
    para "hoy" en cualquier zona horaria sin arrastrar partidos de dentro de varias semanas."""
    sport_id = LEAGUE_KEY_TO_SPORT_ID.get(league_key)
    slugs = LEAGUE_SLUGS.get(sport_id, [])
    games: list[dict] = []
    errors: list[str] = []
    now = dt.datetime.now(dt.timezone.utc)
    frm = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    to = (now + dt.timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient() as client:
        events = []
        for slug in slugs:
            try:
                resp = await client.get(
                    f"{BASE}/events",
                    params={"sport": "baseball", "league": slug, "status": "pending", "from": frm, "to": to, "apiKey": api_key},
                    timeout=20.0,
                )
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                errors.append(f"/events fallo para {slug}: {e}")
                continue
            events.extend(data if isinstance(data, list) else data.get("data") or data.get("events") or [])

        for ev in events:
            event_id = ev.get("id")
            try:
                oresp = await client.get(
                    f"{BASE}/odds",
                    params={"eventId": event_id, "bookmakers": BOOKMAKERS, "apiKey": api_key},
                    timeout=15.0,
                )
                oresp.raise_for_status()
                odata = oresp.json()
            except Exception as e:
                errors.append(f"/odds fallo para eventId={event_id}: {e}")
                continue

            bookmakers = odata.get("bookmakers") or {}
            markets = bookmakers.get(bookmaker)
            if not markets:
                continue  # esta casa no tiene cuotas para este partido todavia -- se omite, nunca se sustituye por otra
            values = _values_from_markets(markets)
            if any(v is not None for v in values.values()):
                game = _values_to_scraper_shape(values, ev.get("away", ""), ev.get("home", ""), ev.get("date", ""), bookmaker)
                game["league"] = league_key
                games.append(game)

    return {"league": league_key, "games": games, "errors": errors, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat()}
