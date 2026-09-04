"""Fusion de listados duplicados del mismo partido (2026-09-04).

cuotasahora lista el mismo enfrentamiento dos veces con las mismas lineas y precios
ligeramente distintos. El fail-safe original descartaba los dos, y con eso LMB no conseguia
cuotas: tres intentos seguidos en `sin_match` con `2 scrapeados - 0 asignados`. Estos tests
fijan el criterio: fusionar solo cuando se puede afirmar que es el MISMO evento, y siempre al
precio mas conservador.
"""
from app.odds_autofetch import _fusionar_duplicados, _values_from_scraped


def _scraped(time="01:00", ml=(1.83, 1.83), total=(11.5, 1.87, 1.80), rl=(-1.5, 2.60, 1.5, 1.45)):
    return {
        "away_team": "Tabasco", "home_team": "Puebla", "time": time,
        "moneyline": {"away": ml[0], "home": ml[1]},
        "total": {"line": total[0], "over_odds": total[1], "under_odds": total[2]},
        "run_line": {"home": {"line": rl[0], "odds": rl[1]}, "away": {"line": rl[2], "odds": rl[3]}},
    }


def _par(a, b):
    return [(a, _values_from_scraped(a)), (b, _values_from_scraped(b))]


def test_caso_real_lmb_tabasco_puebla():
    # Las dos entradas reales devueltas por cuotasahora el 2026-09-04.
    e1 = _scraped(total=(11.5, 1.87, 1.80), rl=(-1.5, 2.60, 1.5, 1.45))
    e2 = _scraped(total=(11.5, 1.83, 1.83), rl=(-1.5, 2.70, 1.5, 1.43))
    f = _fusionar_duplicados(_par(e1, e2))
    assert f is not None
    # Precio mas conservador (el minimo) en cada mercado.
    assert f["over_odds"] == 1.83
    assert f["under_odds"] == 1.80
    assert f["home_hc_odds"] == 2.60
    assert f["away_hc_odds"] == 1.43
    # Las lineas, que coincidian, se conservan.
    assert f["total_line"] == 11.5
    assert f["home_hc_val"] == -1.5
    assert f["away_hc_val"] == 1.5


def test_no_fusiona_si_la_linea_de_totales_difiere():
    # Distinta linea = no se puede afirmar que hablen del mismo mercado -> se descarta todo.
    e1 = _scraped(total=(11.5, 1.87, 1.80))
    e2 = _scraped(total=(9.5, 1.87, 1.80))
    assert _fusionar_duplicados(_par(e1, e2)) is None


def test_no_fusiona_si_la_hora_difiere():
    # Distinta hora = son partidos distintos (el de hoy y el de manana, o un fantasma).
    assert _fusionar_duplicados(_par(_scraped(time="01:00"), _scraped(time="23:05"))) is None


def test_no_fusiona_si_difiere_el_handicap():
    e1 = _scraped(rl=(-1.5, 2.60, 1.5, 1.45))
    e2 = _scraped(rl=(-2.5, 2.60, 2.5, 1.45))
    assert _fusionar_duplicados(_par(e1, e2)) is None


def test_un_listado_sin_totales_no_bloquea_la_fusion():
    # Si solo uno trae el total, no hay contradiccion: se conserva el que existe.
    e1 = _scraped(total=(11.5, 1.87, 1.80))
    e2 = _scraped(total=(11.5, 1.83, 1.83))
    v2 = _values_from_scraped(e2)
    for k in ("total_line", "over_odds", "under_odds"):
        v2[k] = None
    f = _fusionar_duplicados([(e1, _values_from_scraped(e1)), (e2, v2)])
    assert f is not None
    assert f["total_line"] == 11.5
    assert f["over_odds"] == 1.87
    assert f["under_odds"] == 1.80


def test_la_fusion_nunca_mejora_el_precio():
    # Invariante que hace seguro el cambio: el precio fusionado nunca es mayor que el peor de los
    # listados, asi que el edge solo puede salir menor -- esto no puede inventar un pick.
    e1 = _scraped(total=(11.5, 2.10, 1.70))
    e2 = _scraped(total=(11.5, 1.83, 1.83))
    f = _fusionar_duplicados(_par(e1, e2))
    v1, v2 = _values_from_scraped(e1), _values_from_scraped(e2)
    for campo in ("away_ml", "home_ml", "away_hc_odds", "home_hc_odds", "over_odds", "under_odds"):
        assert f[campo] <= min(v1[campo], v2[campo])
