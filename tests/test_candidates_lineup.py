"""Los candidatos de PIPELINE 2 (lineup) van a su propia tabla, no a `*_candidates_history`.

Por que existe este fichero (2026-09-16): `*_candidates_history` tiene UNIQUE
(game_id, market, pick_side), asi que el INSERT de pipeline 2 chocaba, PostgREST devolvia 409,
`raise_for_status()` lanzaba y el `try/except` de `try_fire_pipeline` lo enterraba en un
`logger.exception`. Medido en `pipeline_runs`: 532 runs de pipeline 2 en MLB (500 con
quant_result) y 344/310 en MiLB -- ~800 evaluaciones CON lineup calculadas y tiradas en silencio.

Lo que estos tests fijan es justo lo que no se puede volver a romper: que pipeline 2 escriba
APARTE y que pipeline 1 siga escribiendo exactamente donde escribia.
"""
import pytest
from app.pipelines import (
    CANDIDATES_HISTORY_TABLE,
    CANDIDATES_LINEUP_TABLE,
    CANDIDATES_HISTORY_COLUMNS,
    build_candidates_history_rows,
)

RESULT = {
    "data_score": 0.74, "away_runs": 4.10, "home_runs": 4.55,
    "candidates": [
        {"market": "ML", "pick_side": "AWAY", "odds": 2.05, "edge": 0.02, "edge_threshold": 0.18,
         "prob_model": 0.49, "prob_estimated": 0.48, "prob_blended": 0.48, "prob_implied": 0.487,
         "prob_implied_raw": 0.4878, "raw_prob_estimated": 0.51},
        {"market": "ML", "pick_side": "HOME", "odds": 1.72, "edge": -0.11, "edge_threshold": 0.18,
         "prob_model": 0.51, "prob_estimated": 0.52, "prob_blended": 0.52, "prob_implied": 0.513,
         "prob_implied_raw": 0.5814, "raw_prob_estimated": 0.49},
    ],
}
ARGS = (1, 823658, "2026-09-13", "Away Team", "Home Team", RESULT, ("ML", "AWAY"))


def test_pipeline_1_sigue_en_candidates_history():
    """Lo que NO debe cambiar: el destino por defecto es el de siempre."""
    tabla, filas = build_candidates_history_rows(*ARGS)
    assert tabla == "mlb_candidates_history"
    assert len(filas) == 2
    # y sin pasar `pipeline` explicito, tambien
    assert build_candidates_history_rows(*ARGS, pipeline=1)[0] == "mlb_candidates_history"


def test_pipeline_2_va_a_la_tabla_de_lineup():
    tabla, filas = build_candidates_history_rows(*ARGS, pipeline=2)
    assert tabla == "mlb_candidates_lineup"
    assert len(filas) == 2


@pytest.mark.parametrize("sport_id", [1, 11, 23])
def test_las_tres_ligas_tienen_su_gemela(sport_id):
    """Un KeyError aqui dejaria a esa liga sin guardar, que es el fallo que se esta arreglando."""
    assert sport_id in CANDIDATES_LINEUP_TABLE
    assert CANDIDATES_LINEUP_TABLE[sport_id] != CANDIDATES_HISTORY_TABLE[sport_id]
    assert CANDIDATES_LINEUP_TABLE[sport_id].endswith("_lineup")


@pytest.mark.parametrize("sport_id", [1, 11, 23])
def test_el_contenido_es_identico_salvo_la_tabla(sport_id):
    """Las tablas nuevas se clonaron con LIKE, asi que las filas deben ser las MISMAS.
    Si algun dia divergen, es que alguien toco una allowlist y no la otra."""
    args = (sport_id, 823658, "2026-09-13", "Away Team", "Home Team", RESULT, ("ML", "AWAY"))
    _, p1 = build_candidates_history_rows(*args, pipeline=1)
    _, p2 = build_candidates_history_rows(*args, pipeline=2)
    assert [sorted(f.keys()) for f in p1] == [sorted(f.keys()) for f in p2]
    for a, b in zip(p1, p2):
        for k in a:
            if k == "created_at":
                continue   # es now(), cambia entre las dos llamadas
            assert a[k] == b[k], f"{k} difiere entre pipeline 1 y 2"


@pytest.mark.parametrize("sport_id", [1, 11, 23])
def test_solo_columnas_que_existen_de_verdad(sport_id):
    """La allowlist se indexa por la tabla BASE. Si se indexara por la de lineup daria KeyError,
    y ese es exactamente el modo de fallo (columna inexistente -> PostgREST tira la fila entera)
    que este proyecto ya ha pagado tres veces."""
    args = (sport_id, 823658, "2026-09-13", "Away Team", "Home Team", RESULT, None)
    permitidas = CANDIDATES_HISTORY_COLUMNS[CANDIDATES_HISTORY_TABLE[sport_id]]
    for f in build_candidates_history_rows(*args, pipeline=2)[1]:
        assert set(f.keys()) <= permitidas


def test_published_se_respeta_en_pipeline_2():
    """El pick publicado se marca igual en las dos tablas: si no, la de lineup no serviria para
    auditar que se publico y que no."""
    _, filas = build_candidates_history_rows(*ARGS, pipeline=2)
    pub = [f for f in filas if f["published"]]
    assert len(pub) == 1
    assert (pub[0]["market"], pub[0]["pick_side"]) == ("ML", "AWAY")


def test_sin_candidatos_no_se_escribe_nada():
    """Sin esto, un resultado vacio mandaria un POST vacio a Supabase en cada tick."""
    vacio = {"data_score": 0.5, "away_runs": 4.0, "home_runs": 4.0, "candidates": []}
    tabla, filas = build_candidates_history_rows(
        1, 1, "2026-09-13", "A", "H", vacio, None, pipeline=2)
    assert tabla == "mlb_candidates_lineup"
    assert filas == []
