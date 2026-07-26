import datetime as dt

import pytest

from app import odds_autofetch


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
    got = await odds_autofetch.autofetch_single_game(None, 1, 123, "A", "B", _future())
    assert got is True
    assert calls["n"] == 3  # 2 reintentos + el bueno


@pytest.mark.asyncio
async def test_todo_vacio_se_rinde_sin_excepcion(monkeypatch):
    calls = _patch(monkeypatch, [(0, "empty")])
    got = await odds_autofetch.autofetch_single_game(None, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1 + odds_autofetch.AUTOFETCH_RETRIES  # 3 intentos totales


@pytest.mark.asyncio
async def test_caida_dura_no_reintenta(monkeypatch):
    calls = _patch(monkeypatch, [(0, "scraper_failed")])
    got = await odds_autofetch.autofetch_single_game(None, 1, 123, "A", "B", _future())
    assert got is False
    assert calls["n"] == 1  # NO reintenta ante caída dura


@pytest.mark.asyncio
async def test_ok_al_primer_intento(monkeypatch):
    calls = _patch(monkeypatch, [(2, "ok")])
    got = await odds_autofetch.autofetch_single_game(None, 1, 123, "A", "B", _future())
    assert got is True
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_no_reintenta_si_el_partido_esta_por_empezar(monkeypatch):
    calls = _patch(monkeypatch, [(0, "empty")])
    got = await odds_autofetch.autofetch_single_game(None, 1, 123, "A", "B", _future(minutes=1))
    assert got is False
    assert calls["n"] == 1  # a <2min del inicio, no sigue reintentando
