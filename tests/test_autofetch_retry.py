import datetime as dt
import types

import pytest

from app import odds_autofetch

# ctx minimo: el bucle de reintentos solo necesita ctx.pool, y con pool=None la telemetria de
# tor_activity (record_activity) se salta sola -- aqui se prueba la logica de reintento, no el
# registro. _scrape_and_apply va mockeado, asi que no se toca nada mas del contexto.
CTX = types.SimpleNamespace(pool=None)


def _future(minutes=180):
    return dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes)


async def _noop_sleep(*_a, **_k):
    return None


def _patch(monkeypatch, sequence):
    """Mockea _scrape_and_apply para devolver la secuencia dada; cuenta llamadas."""
    calls = {"n": 0}

    async def fake(ctx, sport_id, cands):
        i = calls["n"]
        calls["n"] += 1
        return sequence[min(i, len(sequence) - 1)]

    monkeypatch.setattr(odds_autofetch, "_scrape_and_apply", fake)
    monkeypatch.setattr(odds_autofetch.asyncio, "sleep", _noop_sleep)
    return calls


@pytest.mark.asyncio
async def test_empty_then_ok_reintenta(monkeypatch):
    calls = _patch(monkeypatch, [(0, "empty"), (0, "empty"), (2, "ok")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is True
    assert calls["n"] == 3  # 2 reintentos + el bueno


@pytest.mark.asyncio
async def test_todo_vacio_se_rinde_sin_excepcion(monkeypatch):
    calls = _patch(monkeypatch, [(0, "empty")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1 + odds_autofetch.AUTOFETCH_RETRIES  # 3 intentos totales


@pytest.mark.asyncio
async def test_caida_dura_tambien_reintenta_rotando(monkeypatch):
    # 2026-08-02 el comportamiento cambió a propósito: "scraper_failed" (timeout) suele ser el
    # MISMO problema que "empty" (un circuito de Tor por el que cuotasahora sirve el decoy), así
    # que también reintenta, rotando el circuito entre intentos. Este test afirmaba lo contrario
    # (calls==1) y llevaba fallando desde entonces; se actualiza a la intención vigente.
    calls = _patch(monkeypatch, [(0, "scraper_failed")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1 + odds_autofetch.AUTOFETCH_RETRIES


@pytest.mark.asyncio
async def test_status_desconocido_no_reintenta(monkeypatch):
    # La salida temprana sigue existiendo para cualquier status que NO sea empty/scraper_failed.
    calls = _patch(monkeypatch, [(0, "otro_status")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_ok_al_primer_intento(monkeypatch):
    calls = _patch(monkeypatch, [(2, "ok")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is True
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_no_reintenta_si_el_partido_esta_por_empezar(monkeypatch):
    calls = _patch(monkeypatch, [(0, "empty")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future(minutes=1))
    assert got is False
    assert calls["n"] == 1  # a <2min del inicio, no sigue reintentando


# --- sondeo periodico (autofetch_league) -------------------------------------------------
# 2026-08-14: antes solo reintentaba el disparo puntual; el sondeo se rendia al primer fallo
# sin rotar circuito, que es justo la defensa contra el "decoy" de cuotasahora.

def _patch_league(monkeypatch, sequence, candidates=1):
    calls = {"n": 0, "rotaciones": 0}

    async def fake_scrape(ctx, sport_id, cands):
        i = calls["n"]
        calls["n"] += 1
        return sequence[min(i, len(sequence) - 1)]

    async def fake_candidates(pool, sport_id):
        return ["candidato"] * candidates

    async def fake_rotate():
        calls["rotaciones"] += 1
        return True, "ok"

    monkeypatch.setattr(odds_autofetch, "_scrape_and_apply", fake_scrape)
    monkeypatch.setattr(odds_autofetch, "_candidates_needing_odds", fake_candidates)
    monkeypatch.setattr(odds_autofetch, "rotate_tor_circuit", fake_rotate)
    monkeypatch.setattr(odds_autofetch.asyncio, "sleep", _noop_sleep)
    return calls


@pytest.mark.asyncio
async def test_sondeo_reintenta_rotando_tras_fallo(monkeypatch):
    calls = _patch_league(monkeypatch, [(0, "scraper_failed"), (1, "ok")])
    await odds_autofetch.autofetch_league(CTX, 1)
    assert calls["n"] == 2
    assert calls["rotaciones"] == 1  # rotó el circuito ANTES del segundo intento


@pytest.mark.asyncio
async def test_sondeo_no_reintenta_si_va_bien(monkeypatch):
    calls = _patch_league(monkeypatch, [(2, "ok")])
    await odds_autofetch.autofetch_league(CTX, 1)
    assert calls["n"] == 1
    assert calls["rotaciones"] == 0


@pytest.mark.asyncio
async def test_sondeo_acotado_a_un_reintento(monkeypatch):
    """No debe heredar los 5-11 reintentos del disparo puntual: corre para 3 ligas en paralelo."""
    calls = _patch_league(monkeypatch, [(0, "empty")])
    await odds_autofetch.autofetch_league(CTX, 1)
    assert calls["n"] == 1 + odds_autofetch.AUTOFETCH_LEAGUE_RETRIES == 2
    assert calls["rotaciones"] == 1


@pytest.mark.asyncio
async def test_sondeo_sin_candidatos_no_scrapea_ni_rota(monkeypatch):
    """Sin candidatos no hay nada que scrapear -- rotar el circuito ahí sería gasto puro."""
    calls = _patch_league(monkeypatch, [(0, "empty")], candidates=0)
    await odds_autofetch.autofetch_league(CTX, 1)
    assert calls["n"] == 0
    assert calls["rotaciones"] == 0


# --- descarte de trabajo obsoleto al salir de la cola -------------------------------------
# 2026-08-15: medido en produccion que scrapes de LMB salian de la cola tras ~7h de espera y
# devolvian "sin_match" porque el partido llevaba horas jugado. Trabajo tirado que ademas
# martillea cuotasahora.

def _cand(minutes_from_now, con_hora=True):
    from app import aliases
    gdt = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes_from_now)) if con_hora else None
    return aliases.CandidateGame(
        sport_id=1, game_pk=1, away_team_id=None, home_team_id=None,
        away_team_name="A", home_team_name="B", game_datetime_utc=gdt,
    )


@pytest.mark.parametrize("minutos,esperado", [
    (120, False),   # empieza en 2h -> vigente
    (1, False),     # a punto de empezar -> vigente
    (-5, False),    # empezo hace 5min -> dentro del margen de 10min
    (-30, True),    # empezo hace media hora -> obsoleto
    (-420, True),   # el caso real: 7h de espera en cola
])
def test_ya_empezado(minutos, esperado):
    ahora = dt.datetime.now(dt.timezone.utc)
    assert odds_autofetch._ya_empezado(_cand(minutos), ahora) is esperado


def test_sin_hora_no_se_descarta():
    """Sin game_datetime_utc no se tira el trabajo: no se descarta por falta de dato."""
    ahora = dt.datetime.now(dt.timezone.utc)
    assert odds_autofetch._ya_empezado(_cand(0, con_hora=False), ahora) is False


def test_naive_datetime_se_trata_como_utc():
    """asyncpg puede devolver naive segun la columna -- no debe reventar con TypeError."""
    from app import aliases
    c = aliases.CandidateGame(
        sport_id=1, game_pk=1, away_team_id=None, home_team_id=None,
        away_team_name="A", home_team_name="B",
        game_datetime_utc=dt.datetime.utcnow() - dt.timedelta(hours=3),
    )
    assert odds_autofetch._ya_empezado(c, dt.datetime.now(dt.timezone.utc)) is True


@pytest.mark.asyncio
async def test_stale_no_dispara_reintento_ni_rotacion(monkeypatch):
    """'stale' no es un fallo transitorio: reintentar y rotar circuito ahi seria gasto puro."""
    calls = _patch_league(monkeypatch, [(0, "stale")])
    await odds_autofetch.autofetch_league(CTX, 1)
    assert calls["n"] == 1
    assert calls["rotaciones"] == 0


@pytest.mark.asyncio
async def test_stale_corta_el_disparo_puntual(monkeypatch):
    calls = _patch(monkeypatch, [(0, "stale")])
    got = await odds_autofetch.autofetch_single_game(CTX, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1
