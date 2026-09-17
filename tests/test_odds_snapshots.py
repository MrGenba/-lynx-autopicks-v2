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


# ── El slate de la foto temprana (2026-09-15) ────────────────────────────────────────────────
#
# Que fallaba: `capture_early_snapshot_tick` elegia los partidos cuya `game_date` empezaba por la
# FECHA UTC de hoy. Pero `daily_games.game_date` es un timestamptz y la jornada americana de MiLB
# cae a caballo de la medianoche UTC (de 22:00 a 02:00), asi que a las 11:02 UTC ese filtro metia
# los partidos de ANOCHE -- ya jugados hacia 9-10 h -- y dejaba fuera los de esta noche que
# empiezan pasada la medianoche UTC.
#
# Y el emparejador no lo cazaba porque los candidatos se construian con `game_datetime_utc=None`,
# lo que desactiva la guarda de hora de `2a85a17` (`_hora_compatible` deja pasar "por falta de
# informacion"). Como los nombres se repiten toda la serie, la linea de esta noche se guardaba
# contra el game_pk de anoche. Resultado medido: las 7 unicas filas `early` que llego a haber eran
# fotos de partidos ya terminados, y sus "parejas" con `gate_a` estaban invertidas en el tiempo.
from app.odds_snapshots import VENTANA_SLATE, partidos_del_slate

AHORA = dt.datetime(2026, 9, 15, 11, 2, tzinfo=dt.timezone.utc)


def _p(pk, iso):
    return {"game_id": pk, "game_date": iso, "away_team_name": "A", "home_team_name": "B"}


def test_el_slate_excluye_los_partidos_de_anoche():
    """El caso real: a las 11:02 UTC, un partido que empezo a las 00:35 de ese mismo dia UTC lleva
    diez horas jugado. Fotografiar su linea no mide nada."""
    anoche = _p(1, "2026-09-15T00:35:00+00:00")
    assert partidos_del_slate([anoche], AHORA) == []


def test_el_slate_incluye_los_de_esta_noche_aunque_crucen_la_medianoche_utc():
    """Lo que el filtro viejo tiraba: 01:45 UTC del dia siguiente es la misma jornada americana."""
    pronto = _p(2, "2026-09-15T22:05:00+00:00")
    tarde = _p(3, "2026-09-16T01:45:00+00:00")
    assert [p["game_id"] for p in partidos_del_slate([pronto, tarde], AHORA)] == [2, 3]


def test_el_slate_no_se_estira_al_dia_siguiente():
    """Mas alla de la ventana ya es otra jornada, y ademas la casa no la ha cotizado todavia."""
    pasado = _p(4, "2026-09-16T22:05:00+00:00")
    assert partidos_del_slate([pasado], AHORA) == []
    assert VENTANA_SLATE < dt.timedelta(hours=24)


def test_el_slate_tolera_fechas_invalidas_sin_reventar():
    """La telemetria no puede tumbar nada: una fila rara se ignora y las buenas siguen."""
    bueno = _p(5, "2026-09-15T23:00:00+00:00")
    assert [p["game_id"] for p in partidos_del_slate([_p(6, ""), _p(7, None), bueno], AHORA)] == [5]


# ── Varias pasadas en vez de una (2026-09-17) ────────────────────────────────────────────────
# Por que existen estos tests: con UNA sola pasada a las 11:00 UTC la foto temprana capturaba
# **2 partidos de ~16** durante dias, sin dar error -- a esa hora la casa aun no ha publicado la
# linea de MiLB. El arreglo intenta a varias horas y fotografia cada partido UNA vez, en la primera
# en que ya haya linea. Lo que estos tests fijan es justo lo que no puede volver a romperse: que la
# lista de horas se lea bien y que una segunda pasada no vuelva a scrapear lo ya hecho.
from app.config import _horas_utc
from app.odds_snapshots import _ya_fotografiados


def test_horas_utc_lee_una_lista():
    assert _horas_utc("13,15,17") == [13, 15, 17]


def test_horas_utc_admite_el_nombre_antiguo_en_singular():
    """ODDS_SNAPSHOTS_HOUR_UTC=11 seguia siendo valido: una sola hora es una lista de una."""
    assert _horas_utc("11") == [11]


def test_horas_utc_ordena_y_quita_repetidas():
    assert _horas_utc("17, 13 ,15,13") == [13, 15, 17]


def test_horas_utc_ignora_basura_en_vez_de_reventar():
    """Una variable mal escrita en EasyPanel no puede tumbar el arranque del contenedor."""
    assert _horas_utc("13,manzana,15") == [13, 15]
    assert _horas_utc("25,-3,99") == [13, 15, 17]     # nada valido -> el valor por defecto
    assert _horas_utc("") == [13, 15, 17]


class _SupaFalso:
    """Devuelve los game_id que se le digan, y cuenta las consultas para comprobar el troceado."""
    def __init__(self, ya):
        self.ya = set(ya)
        self.consultas = 0

    async def select(self, _client, _tabla, params):
        self.consultas += 1
        assert params["fase"] == "eq.early"
        pedidos = params["game_id"][len("in.("):-1].split(",")
        return [{"game_id": int(g)} for g in pedidos if int(g) in self.ya]


class _CtxFalso:
    def __init__(self, ya):
        self.supabase = _SupaFalso(ya)
        self.http_client = None


@pytest.mark.asyncio
async def test_ya_fotografiados_devuelve_solo_los_que_tienen_foto():
    ctx = _CtxFalso(ya=[101, 103])
    assert await _ya_fotografiados(ctx, [101, 102, 103, 104]) == {101, 103}


@pytest.mark.asyncio
async def test_ya_fotografiados_trocea_de_50_en_50():
    """Sin trocear, un slate grande montaria una URL interminable. Y una consulta POR PARTIDO
    —que es el error que se colo al escribir esto— seria una llamada por fila."""
    ctx = _CtxFalso(ya=[])
    await _ya_fotografiados(ctx, list(range(1, 121)))
    assert ctx.supabase.consultas == 3      # 120 ids -> 50 + 50 + 20


@pytest.mark.asyncio
async def test_ya_fotografiados_sin_partidos_no_consulta():
    ctx = _CtxFalso(ya=[])
    assert await _ya_fotografiados(ctx, []) == set()
    assert ctx.supabase.consultas == 0
