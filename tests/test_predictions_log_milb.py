"""predictions_log de MiLB (2026-09-06): mu de TODOS los partidos del dia, con o sin cuotas.

Existe para poder medir la calibracion de nivel sin sesgo de seleccion: hoy solo se conserva el mu
de los 237 partidos que consiguieron precio, de ~1.700 con marcador.
"""
import pytest

from app.predictions_log_milb import (
    LEAGUE_KEY, LEAGUE_LABEL, STD_LINE, _nb_k_del_motor, capture_predictions_tick,
)


def test_clave_de_liga_en_minusculas():
    """run_quant.js mapea 'milb' (minusculas). Con 'MiLB' devuelve 'liga desconocida' y el job
    fallaria entero -- error cometido y cazado al probarlo el 2026-09-06."""
    assert LEAGUE_KEY == "milb"
    assert LEAGUE_LABEL == "MiLB"   # esta es la etiqueta que va a la columna `league`


def test_nb_k_se_lee_del_motor_no_esta_duplicado():
    """Duplicar el numero a mano es como la tabla de CLAUDE.md acabo diciendo 7 mientras el motor
    llevaba dos meses en 3.7. Se lee del fichero."""
    k = _nb_k_del_motor("vendor")
    assert k is not None
    assert 1 < k < 20          # rango sano, sin fijar el valor exacto para no re-crear el problema


def test_nb_k_no_revienta_si_no_encuentra_el_motor():
    assert _nb_k_del_motor("/ruta/que/no/existe") is None


def test_linea_estandar_es_fija():
    """No es la linea del mercado: es una referencia fija para que las probabilidades sean
    comparables entre dias."""
    assert STD_LINE == 9.5


class _SupaFake:
    def __init__(self, ya=None):
        self.ya = ya or set()
        self.insertados = []
    async def select_one(self, client, tabla, params):
        pk = int(params["game_pk"].split(".")[1])
        return {"id": 1} if pk in self.ya else None
    async def insert(self, client, tabla, filas):
        assert tabla == "predictions_log"
        self.insertados.extend(filas)


class _RespFake:
    def __init__(self, payload): self._p = payload
    def raise_for_status(self): pass
    def json(self): return self._p


class _HttpFake:
    """El calendario y los abridores se leen de la API EN VIVO, no de daily_games: el sync de
    Supabase va por detras (1 de 21 partidos con abridores frente a 12 de 15 en la API,
    medido el 2026-09-06)."""
    def __init__(self, juegos): self.juegos = juegos
    async def get(self, url, params=None, timeout=None):
        assert "statsapi.mlb.com" in url and params["sportId"] == 11
        return _RespFake({"dates": [{"games": self.juegos}]})


def _juego_api(pk, ap=None, hp=None):
    return {"gamePk": pk, "teams": {
        "away": {"team": {"name": "A"}, "probablePitcher": {"id": ap} if ap else None},
        "home": {"team": {"name": "B"}, "probablePitcher": {"id": hp} if hp else None}}}


class _AdapterFake:
    def __init__(self, devuelve=None): self.devuelve = devuelve
    async def build_game_object(self, *a, **k): return self.devuelve


class _CtxFake:
    def __init__(self, supa, adapter, juegos):
        self.supabase = supa
        self.http_client = _HttpFake(juegos)
        self.adapters = {11: adapter}
        self.node_bin = "node"
        self.vendor_dir = "vendor"


@pytest.mark.asyncio
async def test_no_reescribe_lo_ya_guardado():
    supa = _SupaFake(ya={111})
    ctx = _CtxFake(supa, _AdapterFake({"x": 1}), [_juego_api(111, 1, 2)])
    await capture_predictions_tick(ctx)
    assert supa.insertados == []       # ya estaba -> no se duplica


@pytest.mark.asyncio
async def test_pasa_al_adaptador_los_abridores_de_la_API(monkeypatch):
    """Sin esto la cobertura cae al 5%: daily_games no tiene los pitcher_id a tiempo."""
    import app.predictions_log_milb as mod
    recibidos = {}

    class _AdapterEspia:
        async def build_game_object(self, game_pk, mode, ap=None, hp=None, dt_=None):
            recibidos[game_pk] = (ap, hp)
            return {"game_id": game_pk}

    async def _quant_fake(*a, **k):
        return {"away_runs": 4.0, "home_runs": 4.2, "over_win": 0.4, "under_win": 0.6,
                "away_ml_win": 0.49, "home_ml_win": 0.51, "data_score": 0.6}
    monkeypatch.setattr(mod, "run_quant", _quant_fake)

    supa = _SupaFake()
    ctx = _CtxFake(supa, _AdapterEspia(), [_juego_api(555, 700, 800)])
    await capture_predictions_tick(ctx)
    assert recibidos[555] == (700, 800)


@pytest.mark.asyncio
async def test_guarda_mu_y_probabilidades(monkeypatch):
    import datetime as dt
    import app.predictions_log_milb as mod
    hoy = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

    async def _quant_fake(node_bin, vendor_dir, liga, payload):
        assert liga == "milb"                      # minusculas o el motor no arranca
        assert payload["total_line"] == STD_LINE   # linea fija, no la del mercado
        assert payload["over_odds"] is None        # sin cuotas: es el punto
        return {"away_runs": 4.5, "home_runs": 4.7, "over_win": 0.42,
                "under_win": 0.58, "away_ml_win": 0.48, "home_ml_win": 0.52, "data_score": 0.71}
    monkeypatch.setattr(mod, "run_quant", _quant_fake)

    supa = _SupaFake()
    ctx = _CtxFake(supa, _AdapterFake({"game_id": 222}), [_juego_api(222, 1, 2)])
    await capture_predictions_tick(ctx)

    assert len(supa.insertados) == 1
    f = supa.insertados[0]
    assert f["game_pk"] == 222 and f["league"] == "MiLB"
    assert f["mu_away"] == 4.5 and f["mu_home"] == 4.7
    assert f["std_line"] == 9.5 and f["p_under_std"] == 0.58
    assert f["k_usado"] is not None


@pytest.mark.asyncio
async def test_un_partido_sin_datos_no_tumba_el_resto(monkeypatch):
    """Cada partido va con su propio try: el punto de esta tabla es no tener sesgo de seleccion,
    asi que perder el lote entero por un partido malo seria justo el fallo a evitar."""
    import datetime as dt
    import app.predictions_log_milb as mod
    hoy = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

    async def _quant_fake(*a, **k):
        return {"away_runs": 4.0, "home_runs": 4.2, "over_win": 0.4, "under_win": 0.6,
                "away_ml_win": 0.49, "home_ml_win": 0.51, "data_score": 0.6}
    monkeypatch.setattr(mod, "run_quant", _quant_fake)

    class _AdapterMixto:
        async def build_game_object(self, game_pk, *a, **k):
            return None if game_pk == 1 else {"game_id": game_pk}   # el primero sin datos

    supa = _SupaFake()
    ctx = _CtxFake(supa, _AdapterMixto(), [_juego_api(1), _juego_api(2, 5, 6)])
    await capture_predictions_tick(ctx)

    assert len(supa.insertados) == 1
    assert supa.insertados[0]["game_pk"] == 2
