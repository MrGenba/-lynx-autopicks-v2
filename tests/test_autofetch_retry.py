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
