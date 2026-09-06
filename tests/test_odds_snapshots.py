"""Fotos de la linea antes/despues del anuncio de abridores (2026-09-06).

La hipotesis que motiva esto: en MiLB los abridores salen el mismo dia (verificado: 0% de los
partidos de D+1/D+2/D+3 los tienen publicados), asi que la casa cotiza sin informacion de pitcheo.
Estas fotos permiten medir si la linea se mueve cuando aparece.
"""
import datetime as dt

import pytest

from app.odds_snapshots import LEAGUE_LABEL, SCRAPER_LEAGUE, _valores, guardar


def _scraped(ml=(2.10, 1.80), total=(8.5, 1.91, 1.95), rl=(-1.5, 2.45, 1.5, 1.51)):
    return {
        "away_team": "Toledo Mud Hens", "home_team": "Louisville Bats", "time": "23:05",
        "moneyline": {"away": ml[0], "home": ml[1]},
        "total": {"line": total[0], "over_odds": total[1], "under_odds": total[2]},
        "run_line": {"home": {"line": rl[0], "odds": rl[1]}, "away": {"line": rl[2], "odds": rl[3]}},
    }


def test_valores_extrae_los_tres_mercados():
    v = _valores(_scraped())
    assert v["away_ml"] == 2.10 and v["home_ml"] == 1.80
    assert v["total_line"] == 8.5 and v["over_odds"] == 1.91 and v["under_odds"] == 1.95
    assert v["away_hc_val"] == 1.5 and v["away_hc_odds"] == 1.51
    assert v["home_hc_val"] == -1.5 and v["home_hc_odds"] == 2.45


def test_valores_no_filtra_por_overround():
    """A diferencia del camino de produccion, aqui NO se descarta una linea rara: para telemetria
    esas son justo las interesantes."""
    v = _valores(_scraped(ml=(1.10, 1.10)))   # overround absurdo, ~82%
    assert v["away_ml"] == 1.10 and v["home_ml"] == 1.10


def test_valores_tolera_mercados_ausentes():
    v = _valores({"moneyline": {"away": 2.0, "home": 1.8}})
    assert v["away_ml"] == 2.0
    assert v["total_line"] is None and v["home_hc_odds"] is None


class _Resp:
    status_code = 201
    def raise_for_status(self): pass


class _HttpFake:
    def __init__(self): self.llamadas = []
    async def post(self, url, headers=None, json=None, timeout=None):
        self.llamadas.append({"url": url, "headers": headers, "json": json})
        return _Resp()


class _SupaFake:
    base_url = "https://ejemplo.supabase.co"
    headers = {"apikey": "k", "Authorization": "Bearer k"}


class _CtxFake:
    def __init__(self):
        self.http_client = _HttpFake()
        self.supabase = _SupaFake()


@pytest.mark.asyncio
async def test_guardar_arma_la_fila_y_pide_upsert():
    ctx = _CtxFake()
    await guardar(ctx, 11, 815630, "early", _valores(_scraped()),
                  away_team="Toledo Mud Hens", home_team="Louisville Bats",
                  game_date="2026-09-06", starters_known=False)
    assert len(ctx.http_client.llamadas) == 1
    c = ctx.http_client.llamadas[0]
    # on_conflict es imprescindible: sin el, PostgREST devuelve 409 en vez de actualizar
    # (comprobado contra la tabla real, no por lectura de la documentacion).
    assert "/rest/v1/odds_snapshots?on_conflict=game_id,fase" in c["url"]
    # merge-duplicates: repetir el job actualiza en vez de duplicar (indice unico game_id+fase)
    assert "resolution=merge-duplicates" in c["headers"]["Prefer"]
    fila = c["json"][0]
    assert fila["game_id"] == 815630 and fila["fase"] == "early" and fila["liga"] == "MiLB"
    assert fila["starters_known"] is False
    assert fila["game_date"] == "2026-09-06"
    assert fila["away_ml"] == 2.10 and fila["total_line"] == 8.5
    dt.datetime.fromisoformat(fila["captured_at"])  # timestamp valido


@pytest.mark.asyncio
async def test_guardar_no_escribe_si_no_hay_ninguna_cuota():
    ctx = _CtxFake()
    await guardar(ctx, 11, 1, "early", _valores({}))
    assert ctx.http_client.llamadas == []


@pytest.mark.asyncio
async def test_guardar_nunca_propaga_el_error():
    """Es telemetria: un fallo de Supabase no puede tumbar el pipeline de picks."""
    class _Revienta(_HttpFake):
        async def post(self, *a, **k): raise RuntimeError("supabase caido")
    ctx = _CtxFake()
    ctx.http_client = _Revienta()
    await guardar(ctx, 11, 1, "gate_a", _valores(_scraped()))   # no debe lanzar


def test_solo_milb_de_momento():
    assert set(SCRAPER_LEAGUE) == {11}
    assert LEAGUE_LABEL[11] == "MiLB"
