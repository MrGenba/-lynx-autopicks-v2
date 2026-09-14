"""`predictions_log` de MiLB: el calendario tiene que leerse por el cliente resiliente.

Contexto (2026-09-14): la tabla llevaba UNA fila desde el 6-sep porque `_partidos_de_hoy` llamaba a
statsapi.mlb.com directamente y **statsapi devuelve 406 a la IP de la VPS** (verificado en vivo
dentro del contenedor). El 406 abortaba el tick entero, todos los dias, sin guardar nada.

Estos tests fijan las dos cosas que no deben volver a romperse: que se usa `get_schedule` (que
lleva el fallback a r.jina.ai) y que el mapeo conserva los `probablePitcher`, sin los cuales el
adaptador devuelve None y la tabla se quedaria igual de vacia.
"""
import asyncio
import types

import pytest

from app import predictions_log_milb as plog


class _Juego:
    def __init__(self, pk, away, home, ap=None, hp=None):
        self.game_pk = pk
        self.away_team_name = away
        self.home_team_name = home
        self.away_pitcher_id = ap
        self.home_pitcher_id = hp


def test_lee_el_calendario_por_el_cliente_resiliente(monkeypatch):
    """Si alguien vuelve a meter un http_client.get() directo, esto lo caza: el ctx que se pasa
    NO tiene http_client utilizable, asi que solo puede funcionar via get_schedule."""
    llamadas = []

    async def fake_get_schedule(client, sport_id, fecha, league_id=None):
        llamadas.append({"sport_id": sport_id, "fecha": fecha})
        return [_Juego(1, "Aces", "Bulls", 100, 200)]

    monkeypatch.setattr(plog.mlb_stats_client, "get_schedule", fake_get_schedule)
    ctx = types.SimpleNamespace(http_client=object())

    partidos = asyncio.run(plog._partidos_de_hoy(ctx))

    assert len(llamadas) == 1, "debe pasar por mlb_stats_client.get_schedule"
    assert llamadas[0]["sport_id"] == plog.SPORT_ID == 11
    assert len(partidos) == 1


def test_conserva_los_abridores(monkeypatch):
    """Sin pitcher_id el adaptador devuelve None y no se guarda nada: el mapeo no puede perderlos."""
    async def fake_get_schedule(client, sport_id, fecha, league_id=None):
        return [
            _Juego(11, "Aces", "Bulls", 100, 200),
            _Juego(12, "Cats", "Dogs", None, None),   # sin abridores anunciados todavia
        ]

    monkeypatch.setattr(plog.mlb_stats_client, "get_schedule", fake_get_schedule)
    partidos = asyncio.run(plog._partidos_de_hoy(types.SimpleNamespace(http_client=object())))

    a, b = partidos
    assert (a["game_id"], a["away_pitcher_id"], a["home_pitcher_id"]) == (11, 100, 200)
    assert a["away_team_name"] == "Aces" and a["home_team_name"] == "Bulls"
    assert (b["away_pitcher_id"], b["home_pitcher_id"]) == (None, None)
    assert all(len(p["game_date"]) == 10 for p in partidos)


def test_dia_sin_partidos_no_revienta(monkeypatch):
    """Pasa de verdad: el 2026-09-14 sportId=11 devolvio 0 partidos."""
    async def vacio(client, sport_id, fecha, league_id=None):
        return []

    monkeypatch.setattr(plog.mlb_stats_client, "get_schedule", vacio)
    assert asyncio.run(plog._partidos_de_hoy(types.SimpleNamespace(http_client=object()))) == []
