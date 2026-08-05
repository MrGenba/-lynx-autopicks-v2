"""Obtiene cuotas automaticamente para los partidos que el detector ya tiene con al menos
Gate A confirmado, sin esperar a que alguien las pegue por Telegram. Reutiliza exactamente la
misma logica de validacion/guardado/disparo que message_handler.py usa para las cuotas
manuales -- asi el camino automatico y el manual convergen en el mismo sitio (_store_odds,
_check_gates_and_fire), sin divergencia de reglas.

Desde 2026-07-11, autofetch_single_game() prueba primero odds-api.io (API real, ver
app/odds_api_client.py) -- mas rapido y fiable que el scraper de Tor+cuotasahora.com. Si no
encuentra el partido o cuotas todavia, cae al scraper de Tor (vendor/run_odds_scraper.js) como
respaldo -- no se borro ese camino, solo dejo de ser el primero en intentarse.

Dos formas de disparo, mismo motor por debajo:
- autofetch_single_game(): disparado por el detector EN EL MOMENTO en que un partido confirma
  Gate A o Gate B sin cuotas todavia (ver detector.py) -- un scrape acotado a un solo partido,
  como mucho 2 intentos por partido en toda su vida (una vez por gate). Este es el camino
  principal desde 2026-07-09: coincide con lo que se pidio originalmente ("manda las cuotas
  cuando se confirmen las alineaciones"), no un sondeo periodico de ligas enteras.
- autofetch_tick()/autofetch_league(): sondeo periodico de TODA la liga, pensado como red de
  seguridad para partidos que el disparo puntual no cogio (ODDS_AUTOFETCH_ENABLED=false por
  defecto -- desactivado 2026-07-09 tras un gasto de proxy inesperado, casi todo generado por
  este sondeo repetido antes de que existiera el disparo puntual de arriba)."""
import asyncio
import datetime as dt
import logging

import asyncpg

from app import aliases
from app.message_handler import _check_gates_and_fire, _store_odds
from app.tor_control import rotate_tor_circuit
from app.node_bridge import NodeBridgeError, run_odds_scraper
from app.overround import check_overround
from app.pipelines import LEAGUE_KEY, LEAGUE_LABEL, PipelineContext

logger = logging.getLogger(__name__)

SCRAPER_LEAGUE = {1: "MLB", 11: "MiLB", 23: "LMB"}
MIN_MATCH_SCORE = 4  # 2x score()==2 minimo, o un exacto (3) + parcial (1) -- evita matches debiles
GAMES_WINDOW_SQL = (
    "game_datetime_utc BETWEEN now() - interval '1 hour' AND now() + interval '6 hours'"
)
# Un partido de beisbol rara vez pasa de ~4h incluso con entradas extra -- si el scraping (mas
# lento por Tor, o si un ciclo se retrasa) termina despues de este margen, el partido ya
# probablemente acabo y no tiene sentido guardar ni disparar nada con esas cuotas. Bug real
# encontrado en vivo 2026-07-09: autofetch_single_game() no comprobaba esto en absoluto, asi que
# un scrape lento podia guardar cuotas para un partido ya jugado.
MAX_GAME_AGE = dt.timedelta(hours=5)

# Estado en memoria (se pierde en cada reinicio, no es critico) -- solo para no mandar el
# mismo aviso de "cuotasahora.com no responde" al admin en cada ciclo si sigue bloqueado.
_last_status: dict[int, bool] = {}

# Bug real encontrado en vivo 2026-07-09: cuando varios partidos confirman su Gate A/B casi a la
# vez (normal en un mismo bloque horario de la noche), cada uno dispara su propio
# autofetch_single_game() en paralelo (asyncio.create_task en detector.py) -- y todos comparten
# el MISMO proceso de Tor (127.0.0.1:9050, un unico daemon en el contenedor). Varias instancias
# de Chrome intentando abrir circuitos de Tor a la vez lo saturan y todas fallan. Este semaforo
# limita cuantos scrapes reales corren a la vez -- lo comparten el disparo puntual, el sondeo
# periodico Y el endpoint /scrape-odds/* de produccion (2026-07-10).
# Bajado de 2 a 1 el 2026-07-10: probado en vivo que 2 scrapes reales a la vez (cada uno con su
# propio Chrome via patchright, canal "chrome" real no chromium generico) dejaban el contenedor
# intermitentemente inalcanzable (502 "Service is not reachable" en Traefik) por presion de
# CPU/memoria en este VPS compartido con n8n/postgres/etc. Serializar del todo es mas lento
# pero mas seguro -- sin esto, el endpoint de produccion podia coincidir con un disparo puntual
# interno y tumbar el contenedor.
_scrape_semaphore = asyncio.Semaphore(1)

# Retry del disparo puntual cuando el scrape vuelve VACÍO (no_bookmaker_rows/no_header transitorio,
# cuotas que SÍ existen -- lección 2026-07-26). Bounded + backoff amplio: NO martillear, porque
# `no_bookmaker_rows` suele ser señal de throttle de cuotasahora y reintentar rápido lo empeora.
# Solo se reintenta el caso "empty" (transitorio); una caída dura del scraper (NodeBridgeError) NO
# se reintenta in-place (el detector reintentará en un tick posterior con cooldown, cuando Tor
# probablemente se haya recuperado).
AUTOFETCH_RETRIES = 5               # reintentos extra -> 6 intentos totales por llamada
# LMB (sport 23) sufre mucho mas la loteria de circuito: el widget de cuotas (XHR) solo carga en
# CIERTOS circuitos Tor -> un scrape entero devuelve TODO o NADA segun el exit. 6 intentos no bastan
# para dar con uno bueno de forma fiable (comprobado 2026-08-04: manual funciona, automatico no
# entraba). Se sube LMB a 11 reintentos (12 intentos) rotando NEWNYM entre cada uno. Coste acotado:
# en cuanto un intento pilla circuito bueno, ese circuito se cachea ~600s y el resto de partidos LMB
# entran rapido; solo el primero paga la busqueda. MLB/MiLB se quedan en 5 (casi nunca lo necesitan).
AUTOFETCH_RETRIES_LMB = 11
# 2026-08-02: backoff corto porque entre reintentos se ROTA el circuito de Tor (NEWNYM). El circuito
# se mantiene estable DURANTE cada scrape; solo rota entre intentos. cuotasahora sirve un "decoy"
# (indice sin partidos) a algunos circuitos -> con 6 intentos rotando circuito, ~80% de dar con uno
# bueno. El backoff da tiempo a que Tor construya el circuito nuevo antes del siguiente intento.
AUTOFETCH_BACKOFF_S = (15, 15, 20, 20, 25)  # espera antes de cada reintento (tras rotar circuito)
# Espaciado GLOBAL entre scrapes reales. Con "cuotas frescas siempre", cuando salen muchos lineups
# casi a la vez el detector encola N scrapes -- el semáforo los serializa pero back-to-back, y ese
# burst es justo lo que throttlea cuotasahora. Este hueco mínimo los separa.
_MIN_SCRAPE_GAP_S = 25.0
_last_scrape = [0.0]  # holder mutable (evita declarar 'global' dentro del bloque del semáforo)


async def _candidates_needing_odds(pool: asyncpg.Pool, sport_id: int) -> list[aliases.CandidateGame]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT g.sport_id, g.game_pk, g.away_team_id, g.home_team_id,
                   g.away_team_name, g.home_team_name, g.game_datetime_utc
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
            home_team_name=r["home_team_name"], game_datetime_utc=r["game_datetime_utc"],
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
    # 2026-08-05: SOLO LOG, ya no manda Telegram. Este aviso (✅ vuelve a responder / ⚠️ sin partidos,
    # descartado) hacia flip-flop constante: el scrape usa UN circuito Tor por sesion y cuotasahora no
    # pinta el widget en algunos circuitos -> cada miss transitorio (que el retry recupera) disparaba
    # un par ⚠️/✅. Puro ruido de un sistema de reintentos que funciona. La señal util de "faltan
    # cuotas" para un partido concreto ya la da el detector ("📋 Lineup listo, faltan cuotas") y el
    # de "datos insuficientes"; esos SI van a Telegram. Se conserva _last_status por si se reactiva.
    _last_status[sport_id] = ok
    label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    if ok:
        logger.info("cuotas %s: cuotasahora responde de nuevo", label)
    else:
        logger.info("cuotas %s: %s", label, detail)


async def _scrape_and_apply(ctx: PipelineContext, sport_id: int, candidates: list[aliases.CandidateGame]) -> int:
    """Nucleo compartido: scrapea la liga (filtrada a candidates via slug de URL, ver
    scraper_cuotasahora.js), empareja, guarda y dispara. Devuelve cuantos candidatos
    consiguieron cuotas. Usado tanto por el disparo puntual (1 candidato) como por el
    sondeo periodico (N candidatos)."""
    if not candidates:
        return 0, "empty"

    league_key = SCRAPER_LEAGUE[sport_id]
    candidate_names = [n for c in candidates for n in (c.away_team_name, c.home_team_name) if n]
    try:
        async with _scrape_semaphore:
            # Espaciado global anti-throttle: separa scrapes back-to-back (ver _MIN_SCRAPE_GAP_S).
            gap = _MIN_SCRAPE_GAP_S - (dt.datetime.now(dt.timezone.utc).timestamp() - _last_scrape[0])
            if gap > 0:
                await asyncio.sleep(gap)
            # LMB (sport 23) sale por su Tor MEXICANO si esta configurado (cuotasahora sirve un muro
            # de login/decoy a los circuitos Tor no-MX en la seccion LMB); el resto por el Tor normal.
            proxy = ctx.proxy_server_lmb if (sport_id == 23 and ctx.proxy_server_lmb) else ctx.proxy_server
            result = await run_odds_scraper(
                ctx.node_bin, ctx.vendor_dir, league_key,
                proxy,
                candidate_names=candidate_names,
            )
            _last_scrape[0] = dt.datetime.now(dt.timezone.utc).timestamp()
    except NodeBridgeError as e:
        logger.warning("run_odds_scraper fallo para %s: %s", league_key, e)
        await _notify_status_change(ctx, sport_id, False, f"scraper falló: {str(e)[:200]}")
        return 0, "scraper_failed"

    games = result.get("games") or []
    if not games and result.get("errors"):
        await _notify_status_change(ctx, sport_id, False, f"sin partidos, {result['errors'][0][:180]}")
        return 0, "empty"
    await _notify_status_change(ctx, sport_id, True, "")

    now = dt.datetime.now(dt.timezone.utc)
    cand_by_pk = {c.game_pk: c for c in candidates}

    # 2026-07-27 (fix B): agrupar los scrapes POR candidato real antes de aplicar. cuotasahora a
    # veces lista el MISMO partido dos veces con cuotas distintas (p.ej. el de hoy y el de manana,
    # o un fantasma con el mismo matchup). El bucle anterior asignaba "el primero del scrape" y
    # eliminaba el candidato -> podia guardar cuotas del partido equivocado, y un scrape que
    # deberia ir al candidato A podia caer en B tras liberarse A. Ahora: cada scrape se empareja
    # contra la lista COMPLETA de candidatos; si 2+ scrapes caen en el mismo candidato con cuotas
    # que DIFIEREN, no se aplica ninguna (fail-safe, misma filosofia que _match_scraped_game:
    # "mejor perder una cuota que asignarla al partido equivocado"). Si coinciden, se aplica.
    by_cand: dict[int, list[tuple[dict, dict]]] = {}
    for scraped in games:
        cand = _match_scraped_game(scraped, candidates)
        if cand is None:
            continue
        values = _values_from_scraped(scraped)
        if all(v is None for v in values.values()):
            continue
        by_cand.setdefault(cand.game_pk, []).append((scraped, values))

    matched_count = 0
    for game_pk, entries in by_cand.items():
        cand = cand_by_pk[game_pk]

        if cand.game_datetime_utc is not None:
            game_dt = cand.game_datetime_utc
            if game_dt.tzinfo is None:
                game_dt = game_dt.replace(tzinfo=dt.timezone.utc)
            if now - game_dt > MAX_GAME_AGE:
                logger.info(
                    "autofetch: descartado game_pk=%s (%s @ %s) -- empezo hace %s, probablemente ya termino",
                    cand.game_pk, cand.away_team_name, cand.home_team_name, now - game_dt,
                )
                continue

        # Fail-safe ante duplicados conflictivos: mismo partido real scrapeado 2+ veces con cuotas
        # distintas -> no fiarse de ninguna (probable partido erroneo/duplicado de cuotasahora).
        if len(entries) > 1 and any(e[1] != entries[0][1] for e in entries[1:]):
            logger.warning(
                "autofetch: %s scrapes matchean game_pk=%s (%s @ %s) con cuotas DISTINTAS -- no se aplica ninguna (duplicado/partido erroneo de cuotasahora)",
                len(entries), cand.game_pk, cand.away_team_name, cand.home_team_name,
            )
            continue

        scraped, values = entries[0]
        await _store_odds(ctx.pool, cand.sport_id, cand.game_pk, values, chat_id=0, message_id=0)
        matched_count += 1

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
    return matched_count, ("ok" if matched_count else "empty")


async def autofetch_single_game(
    ctx: PipelineContext, sport_id: int, game_pk: int, away_team_name: str, home_team_name: str,
    game_datetime_utc: dt.datetime,
) -> bool:
    """Disparo puntual: un solo partido, una sola vez (el detector solo llama a esto en la
    transicion first_time de un gate, ver detector.py). Devuelve True si se encontraron y
    guardaron cuotas (ya disparo el pipeline correspondiente si aplicaba). game_datetime_utc es
    obligatorio -- sin el, _scrape_and_apply no puede descartar un partido ya jugado si el
    scrape (mas lento por Tor) termina tarde.

    2026-07-20 DESACTIVADO el intento previo por odds-api.io (activo desde 2026-07-11): el
    usuario comparo en vivo cuotas reales de bet365.com contra lo que devolvia odds-api.io
    etiquetado como "Bet365" (dos partidos MLB, mismo dia) y no coincidian -- no era un bug de
    mezcla de casas (eso se corrigio aparte el mismo dia), sino que el propio feed "Bet365" de
    odds-api.io no refleja bet365.com en vivo con precision suficiente. Esta funcion alimenta
    picks reales (_check_gates_and_fire), asi que la precision importa mas aqui que en el
    comando manual de Telegram -- se salta odds-api.io por completo y se va directo al scraper
    de Tor (mas lento, pero es la fuente que si se verifico que coincide con bet365.com real).
    get_odds_for_game sigue existiendo en odds_api_client.py por si se recupera con otra fuente."""
    candidate = aliases.CandidateGame(
        sport_id=sport_id, game_pk=game_pk, away_team_id=None, home_team_id=None,
        away_team_name=away_team_name, home_team_name=home_team_name, game_datetime_utc=game_datetime_utc,
    )
    # Retry-on-empty in-place (2026-07-26): un scrape que vuelve VACÍO (no_bookmaker_rows/no_header)
    # con cuotas que sí existen es transitorio (Tor lento/throttle) -> reintentar con backoff amplio.
    # Caída dura del scraper -> no insistir aquí (el detector reintenta en un tick posterior con
    # cooldown, cuando Tor probablemente se haya recuperado).
    retries = AUTOFETCH_RETRIES_LMB if sport_id == 23 else AUTOFETCH_RETRIES
    for attempt in range(1 + retries):
        matched, status = await _scrape_and_apply(ctx, sport_id, [candidate])
        if matched > 0:
            return True
        # 2026-08-02: reintentar en "empty" (decoy/no_header) Y "scraper_failed" (timeout) -> ambos
        # suelen ser un CIRCUITO de Tor por el que cuotasahora sirve el decoy. Antes de reintentar se
        # ROTA el circuito (NEWNYM) para salir por otro; con circuito estable durante cada scrape y
        # rotacion entre intentos, se cicla hasta un circuito bueno.
        if status not in ("empty", "scraper_failed"):
            return False
        if attempt >= retries:
            break
        if game_datetime_utc is not None:
            gdt = game_datetime_utc if game_datetime_utc.tzinfo else game_datetime_utc.replace(tzinfo=dt.timezone.utc)
            if gdt - dt.datetime.now(dt.timezone.utc) < dt.timedelta(minutes=2):
                break  # demasiado cerca del inicio para seguir reintentando
        ok, detail = await rotate_tor_circuit()
        logger.info("autofetch retry %s/%s (%s) game_pk=%s -- NEWNYM %s (%s)",
                    attempt + 1, retries, status, game_pk, "ok" if ok else "FALLO", detail)
        # backoff: los indices extra de LMB (mas alla de los 5 de AUTOFETCH_BACKOFF_S) reusan el ultimo (25s)
        await asyncio.sleep(AUTOFETCH_BACKOFF_S[min(attempt, len(AUTOFETCH_BACKOFF_S) - 1)])
    return False


async def autofetch_league(ctx: PipelineContext, sport_id: int) -> None:
    candidates = await _candidates_needing_odds(ctx.pool, sport_id)
    await _scrape_and_apply(ctx, sport_id, candidates)


async def _autofetch_league_safe(ctx: PipelineContext, sport_id: int) -> None:
    try:
        await autofetch_league(ctx, sport_id)
    except Exception:
        logger.exception("autofetch_tick fallo para sport_id=%s", sport_id)


async def autofetch_tick(ctx: PipelineContext) -> None:
    # Concurrente, no secuencial -- con 3 ligas seguidas a hasta 300s cada una (peor caso 900s)
    # un solo /fetchodds podia bloquear el resto de comandos de Telegram durante 15 minutos
    # (poll_loop procesa un mensaje a la vez, ver telegram.py). En paralelo el peor caso baja a
    # ~300s (la liga mas lenta), no la suma de las 3. Cada liga lanza su propio Chrome -- mas
    # pico de RAM momentaneo, aceptable por ser un ciclo corto cada 900s, no continuo.
    await asyncio.gather(*(_autofetch_league_safe(ctx, sport_id) for sport_id in LEAGUE_KEY))
