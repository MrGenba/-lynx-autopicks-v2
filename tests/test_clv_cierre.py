"""Captura de linea de cierre para TODOS los partidos, no solo para los picks publicados
(2026-09-14). Lo que se comprueba aqui es justo lo que motivo el cambio: un partido SIN pick
publicado tiene que dejar su linea de cierre en `odds_snapshots` con fase='cierre'.

No hay Postgres ni Supabase ni scraper: se sustituyen las tres fronteras por dobles.
"""
import asyncio
import datetime as dt
import types

import pytest

from app import clv


class _FakeSupabase:
    def __init__(self):
        self.base_url = "http://x"
        self.headers = {}
        self.insertados = []

    async def insert(self, client, tabla, filas):
        self.insertados.append((tabla, filas))


def _ctx():
    return types.SimpleNamespace(
        pool=None, http_client=None, node_bin="node", vendor_dir="/vendor",
        proxy_server=None, proxy_server_lmb=None, supabase=_FakeSupabase(),
    )


def _partido(pk, away, home, minutos=10):
    return {
        "sport_id": 1, "game_pk": pk, "away_team_name": away, "home_team_name": home,
        "game_datetime_utc": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutos),
    }


@pytest.fixture
def dobles(monkeypatch):
    guardados = []
    scrapeados = [
        {"away": "Aces", "home": "Bulls"},
        {"away": "Cats", "home": "Dogs"},
    ]

    llamadas_scraper = []

    async def fake_scraper(*a, **k):
        llamadas_scraper.append(k.get("candidate_names"))
        return {"games": list(scrapeados)}

    async def fake_guardar(ctx, sport_id, game_pk, fase, valores, **kw):
        guardados.append({"game_pk": game_pk, "fase": fase, "valores": valores})

    async def fake_record(*a, **k):
        return None

    def fake_match(scraped, cands):
        for c in cands:
            if c.away_team_name == scraped["away"] and c.home_team_name == scraped["home"]:
                return c
        return None

    def fake_values(scraped):
        return {"away_ml": 1.8, "home_ml": 2.0, "total_line": 8.5,
                "over_odds": 1.9, "under_odds": 1.9,
                "away_hc_val": -1.5, "away_hc_odds": 2.0,
                "home_hc_val": 1.5, "home_hc_odds": 1.8}

    monkeypatch.setattr(clv, "run_odds_scraper", fake_scraper)
    monkeypatch.setattr(clv, "record_activity", fake_record)
    monkeypatch.setattr(clv, "_match_scraped_game", fake_match)
    monkeypatch.setattr(clv, "_values_from_scraped", fake_values)
    monkeypatch.setattr(clv.odds_snapshots, "guardar", fake_guardar)
    monkeypatch.setattr(clv, "SCRAPER_LEAGUE", {1: "MiLB"})
    monkeypatch.setattr(clv, "LEAGUE_LABEL", {1: "MiLB"})
    return guardados, llamadas_scraper


def test_partido_sin_pick_publicado_deja_cierre(dobles):
    """El caso que antes se perdia: ningun pick publicado, pero hay partidos empezando."""
    dobles, _ = dobles
    ctx = _ctx()
    partidos = [_partido(101, "Aces", "Bulls"), _partido(102, "Cats", "Dogs")]
    n = asyncio.run(clv._capture_league(ctx, 1, [], dt.datetime.now(dt.timezone.utc), partidos=partidos))

    assert n == 0, "sin picks publicados no debe insertarse nada en pick_closing_lines"
    assert {g["game_pk"] for g in dobles} == {101, 102}
    assert all(g["fase"] == "cierre" for g in dobles)
    assert dobles[0]["valores"]["total_line"] == 8.5
    assert ctx.supabase.insertados == []


def test_no_se_repite_el_cierre_del_mismo_partido(dobles):
    """Aunque el scrape devuelva el partido varias veces, una sola foto por partido."""
    dobles, _ = dobles
    ctx = _ctx()
    partidos = [_partido(101, "Aces", "Bulls")]
    asyncio.run(clv._capture_league(ctx, 1, [], dt.datetime.now(dt.timezone.utc), partidos=partidos))
    assert len([g for g in dobles if g["game_pk"] == 101]) == 1


def test_pick_publicado_sigue_yendo_a_pick_closing_lines(dobles):
    """La funcion original no se rompe: el pick publicado sigue generando su fila."""
    dobles, _ = dobles
    ctx = _ctx()
    pick = {**_partido(101, "Aces", "Bulls"), "market": "OU", "pick_side": "under"}
    n = asyncio.run(clv._capture_league(ctx, 1, [pick], dt.datetime.now(dt.timezone.utc),
                                        partidos=[_partido(102, "Cats", "Dogs")]))

    assert n == 1, "el pick publicado debe insertar su fila de cierre"
    tabla, filas = ctx.supabase.insertados[0]
    assert tabla == "pick_closing_lines"
    assert filas[0]["market"] == "OU" and filas[0]["closing_line"] == 8.5
    # y ademas los DOS partidos dejan foto completa, el del pick y el que no tiene pick
    assert {g["game_pk"] for g in dobles} == {101, 102}


def test_sin_partidos_ni_picks_no_scrapea(dobles):
    """Sin nada que capturar NO se llama al scraper: el semaforo de Tor es recurso compartido
    con el camino principal de cuotas, y gastar un turno para nada lo retrasa."""
    guardados, llamadas = dobles
    ctx = _ctx()
    n = asyncio.run(clv._capture_league(ctx, 1, [], dt.datetime.now(dt.timezone.utc), partidos=[]))
    assert n == 0
    assert guardados == []
    assert llamadas == [], "no debe haberse llamado al scraper ni una vez"
