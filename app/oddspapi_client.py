"""Cliente del backend de oddspapi.io -- respaldo de Tor para MiLB/LMB (ver
app/odds_autofetch.py::_try_oddspapi_fallback). NO reemplaza a Tor: se intenta Tor primero (con
todos sus reintentos habituales) y solo si eso falla del todo se prueba esto, antes de rendirse.

Distinto de odds_api_client.py (api.odds-api.io), que se probo como fuente PRIMARIA en julio y
se desactivo el 2026-07-20 porque su feed "Bet365" no coincidia con bet365.com real en MLB (ver
docstring de odds_autofetch.autofetch_single_game).

2026-08-29 (v2): migrado de la cuenta directa de oddspapi.io (api.oddspapi.io, plan gratuito de
250 peticiones/mes) a la MISMA API revendida via RapidAPI (host bet36528.p.rapidapi.com --
verificado en vivo: mismo esquema de fixtureId/tournamentId/marketId, mismos datos), con un plan
de pago de 10.000 peticiones/mes que hace innecesaria la cache agresiva de la v1. La cuenta
directa queda sin usar; ODDSPAPI_KEY ahora guarda la key de RapidAPI (x-rapidapi-key), no la de
oddspapi.io. Aqui se usa solo como red de seguridad cuando Tor ya fallo del todo, no como
sustituto: cualquier cuota (aunque no sea perfecta) es mejor que ninguna, que es la situacion real
de MiLB desde junio. Verificado en vivo el 2026-08-29 contra un partido real de Triple-A
International League: el signo del hcp de "Handicap (incl. extra innings)" aplica directamente al
participant1 (home) tal cual lo da el catalogo de mercados (home no favorito -> handicap positivo,
home favorito -> handicap negativo), igual que ya asume _values_from_scraped() para el scraper de
Tor.

Cobertura verificada (GET /tournaments?sportId=13): MiLB AAA se reparte en
"Triple-A International League" (34238) y "Triple-A Pacific Coast League" (34240), igual que ya
combinabamos en el scraper de cuotasahora. LMB es "Mexican League" (1030). MLB (109) existe pero
NO se usa aqui -- fuera del alcance acordado, Tor ya funciona bien para MLB."""
import asyncio
import datetime as dt
import json
import logging
import time
from pathlib import Path
from typing import Optional

import httpx

from app.odds_api_client import _values_to_scraper_shape
from app.overround import check_overround

logger = logging.getLogger(__name__)

BASE = "https://bet36528.p.rapidapi.com"
RAPIDAPI_HOST = "bet36528.p.rapidapi.com"

# Ultima foto de cupo vista en una respuesta (cabeceras X-RateLimit-Requests-*) -- en memoria del
# proceso, sin tabla nueva: el dashboard (mismo proceso) la lee directamente via get_quota().
# None hasta la primera llamada real.
_quota: dict = {"limit": None, "remaining": None, "checked_at": None}


def _update_quota(resp: httpx.Response) -> None:
    lim = resp.headers.get("x-ratelimit-requests-limit")
    rem = resp.headers.get("x-ratelimit-requests-remaining")
    if lim is None or rem is None:
        return
    try:
        _quota["limit"] = int(lim)
        _quota["remaining"] = int(rem)
        _quota["checked_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    except ValueError:
        pass


def get_quota() -> dict:
    """Foto mas reciente del cupo mensual de RapidAPI, para el dashboard. {limit, remaining,
    checked_at} con todo None si el proceso aun no ha hecho ninguna llamada real."""
    return dict(_quota)

# sport_id (el que usa produccion, ver odds_autofetch.SCRAPER_LEAGUE) -> tournamentIds de
# oddspapi.io. Solo MiLB y LMB -- alcance acordado 2026-08-29, MLB queda fuera.
TOURNAMENT_IDS: dict[int, list[int]] = {
    11: [34238, 34240],  # MiLB AAA: Triple-A International League, Triple-A Pacific Coast League
    23: [1030],  # LMB: Mexican League
}
LEAGUE_KEY_TO_SPORT_ID: dict[str, int] = {"MiLB": 11, "LMB": 23}

# marketId (baseball, sportId=13) -> {type, handicap, outcomes: {outcomeId: outcomeName}}.
# Generado una vez (2026-08-29) desde GET /v4/markets -- es un catalogo estatico de la API, no
# cambia por partido. Se embebe en vez de pedirlo en cada llamada porque el endpoint completo
# pesa ~9MB y no admite filtro por sportId en el servidor.
_MARKETS_PATH = Path(__file__).parent / "oddspapi_baseball_markets.json"
_MARKETS: dict[str, dict] = json.loads(_MARKETS_PATH.read_text("utf-8"))


def _price_and_main(outcomes: dict, outcome_id) -> tuple[Optional[float], bool]:
    o = outcomes.get(str(outcome_id))
    if not o:
        return None, False
    p0 = (o.get("players") or {}).get("0") or {}
    price = p0.get("price")
    try:
        price = float(price) if price is not None else None
    except (TypeError, ValueError):
        price = None
    return price, bool(p0.get("mainLine"))


def _values_from_markets(markets: dict) -> dict:
    values = {
        "away_ml": None, "home_ml": None,
        "away_hc_val": None, "away_hc_odds": None, "home_hc_val": None, "home_hc_odds": None,
        "total_line": None, "over_odds": None, "under_odds": None,
    }
    hc_candidates = []  # (mainLine, abs(handicap), handicap, home_price, away_price)
    tot_candidates = []  # (mainLine, line, over_price, under_price)

    for market_id, mdata in (markets or {}).items():
        meta = _MARKETS.get(str(market_id))
        if not meta:
            continue
        outcomes = mdata.get("outcomes") or {}
        name_to_id = {v: k for k, v in meta["outcomes"].items()}

        if meta["type"] == "moneyline":
            home_price, _ = _price_and_main(outcomes, name_to_id.get("1"))
            away_price, _ = _price_and_main(outcomes, name_to_id.get("2"))
            if home_price is not None and away_price is not None:
                chk = check_overround(away_price, home_price)
                if chk.ok:
                    values["home_ml"], values["away_ml"] = home_price, away_price

        elif meta["type"] == "spreads":
            home_price, main = _price_and_main(outcomes, name_to_id.get("1"))
            away_price, _ = _price_and_main(outcomes, name_to_id.get("2"))
            if home_price is not None and away_price is not None:
                hc_candidates.append((main, abs(meta["handicap"]), meta["handicap"], home_price, away_price))

        elif meta["type"] == "totals":
            over_price, main = _price_and_main(outcomes, name_to_id.get("Over"))
            under_price, _ = _price_and_main(outcomes, name_to_id.get("Under"))
            if over_price is not None and under_price is not None:
                tot_candidates.append((main, meta["handicap"], over_price, under_price))

    if hc_candidates:
        hc_candidates.sort(key=lambda t: (not t[0], t[1]))
        _, _, handicap, home_price, away_price = hc_candidates[0]
        chk = check_overround(away_price, home_price)
        if chk.ok:
            values["home_hc_val"], values["home_hc_odds"] = handicap, home_price
            values["away_hc_val"], values["away_hc_odds"] = -handicap, away_price

    if tot_candidates:
        tot_candidates.sort(key=lambda t: not t[0])
        _, line, over_price, under_price = tot_candidates[0]
        chk = check_overround(over_price, under_price)
        if chk.ok:
            values["total_line"], values["over_odds"], values["under_odds"] = line, over_price, under_price

    return values


_CACHE_TTL_S = 600  # ver nota de cuota abajo
_cache: dict[str, tuple[float, dict]] = {}  # league_key -> (monotonic_ts, result)


async def get_league_odds(api_key: str, league_key: str, bookmaker: str = "bet365") -> dict:
    """Mismo shape de vuelta que odds_api_client.get_league_odds() y que el scraper de Tor
    ({league, games, errors, fetched_at}, games[] en la forma que ya consume
    odds_autofetch._match_scraped_game / _values_from_scraped) -- asi el llamador no necesita
    saber de que fuente viene cada partido.

    Cacheada 10 min en memoria de todos modos (herencia de la v1, cuenta directa de 250/mes):
    con el plan RapidAPI de 10.000/mes ya no hace falta por cupo, pero se conserva porque
    odds_autofetch.autofetch_single_game llama a esto una vez por gate confirmado por partido
    (hasta 2x, mas el sondeo periodico), y cachear por liga evita perseguir el limite de RITMO
    por segundo del plan (ver sleep entre llamadas mas abajo) cuando varios partidos de la misma
    liga disparan el fallback casi a la vez."""
    cached = _cache.get(league_key)
    if cached is not None and (time.monotonic() - cached[0]) < _CACHE_TTL_S:
        return cached[1]

    now = dt.datetime.now(dt.timezone.utc)
    sport_id = LEAGUE_KEY_TO_SPORT_ID.get(league_key)
    tournament_ids = TOURNAMENT_IDS.get(sport_id or -1, [])
    if not tournament_ids:
        return {"league": league_key, "games": [], "errors": [f"liga no soportada por oddspapi_client: {league_key}"],
                "fetched_at": now.isoformat()}

    frm = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    to = (now + dt.timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    games: list[dict] = []
    errors: list[str] = []
    fixture_meta: dict[str, tuple[str, str, str]] = {}  # fixtureId -> (home_name, away_name, start_time)
    headers = {"x-rapidapi-host": RAPIDAPI_HOST, "x-rapidapi-key": api_key}

    async with httpx.AsyncClient() as client:
        # odds-by-tournaments no trae nombres de equipo (solo participant1Id/participant2Id) --
        # hace falta /fixtures aparte para poder emparejar contra los candidatos. Espaciadas
        # ~2s entre si (2026-08-29, verificado tanto en la cuenta directa como via RapidAPI): sin
        # pausa, dos /fixtures seguidas devuelven 429 aunque la cuota mensual tenga de sobra --
        # limite de ritmo por segundo del plan, no de cupo.
        for i, tid in enumerate(tournament_ids):
            if i > 0:
                await asyncio.sleep(2.0)
            try:
                resp = await client.get(f"{BASE}/fixtures",
                    params={"tournamentId": tid, "from": frm, "to": to}, headers=headers, timeout=20.0)
                resp.raise_for_status()
                _update_quota(resp)
                for f in resp.json():
                    fixture_meta[f["fixtureId"]] = (
                        f.get("participant1Name") or "", f.get("participant2Name") or "", f.get("startTime") or "",
                    )
            except Exception as e:
                errors.append(f"/fixtures fallo para tournamentId={tid}: {e}")

        await asyncio.sleep(2.0)
        try:
            resp = await client.get(f"{BASE}/odds-by-tournaments", params={
                "bookmaker": bookmaker, "tournamentIds": ",".join(str(t) for t in tournament_ids),
            }, headers=headers, timeout=25.0)
            resp.raise_for_status()
            _update_quota(resp)
            fixtures = resp.json()
        except Exception as e:
            errors.append(f"/odds-by-tournaments fallo: {e}")
            fixtures = []

    for fx in fixtures if isinstance(fixtures, list) else []:
        bm = (fx.get("bookmakerOdds") or {}).get(bookmaker)
        if not bm:
            continue  # esta casa no tiene cuotas todavia para este partido -- se omite, nunca se sustituye por otra
        meta = fixture_meta.get(fx.get("fixtureId"))
        if not meta or not meta[0] or not meta[1]:
            continue  # sin nombre de equipo no se puede emparejar -- se descarta, no se adivina
        home_name, away_name, start_time = meta
        values = _values_from_markets(bm.get("markets") or {})
        if all(v is None for v in values.values()):
            continue
        game = _values_to_scraper_shape(values, away_name, home_name, start_time or fx.get("startTime", ""), "Bet365")
        game["league"] = league_key
        games.append(game)

    result = {"league": league_key, "games": games, "errors": errors, "fetched_at": now.isoformat()}
    # No cachear un fallo total (0 partidos y con errores) -- mejor reintentar en la proxima
    # llamada real que quedarse 10 min sirviendo un resultado vacio por un fallo transitorio.
    if games or not errors:
        _cache[league_key] = (time.monotonic(), result)
    return result
