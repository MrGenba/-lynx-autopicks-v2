from app.pipelines import _lineup_incomplete


def _lineup():
    return {
        "lineup_factor_away": 1.0215,
        "lineup_factor_home": 1.0151,
        "lineup_away_detected_at": "2026-09-25T20:20:01+00:00",
        "lineup_home_detected_at": "2026-09-25T20:30:01+00:00",
        "lineup_reevaluado_at": "2026-09-25T20:31:35+00:00",
    }


def test_mlb_lineup_exige_ambos_factores_pero_no_reevaluacion():
    lineup = _lineup()
    assert not _lineup_incomplete(1, 2, lineup)
    assert not _lineup_incomplete(1, 2, {**lineup, "lineup_reevaluado_at": "2026-09-25T20:27:37+00:00"})
    assert _lineup_incomplete(1, 2, {**lineup, "lineup_factor_home": None})
    assert not _lineup_incomplete(1, 2, {**lineup, "lineup_home_detected_at": None})
    assert not _lineup_incomplete(1, 2, {**lineup, "lineup_reevaluado_at": None})


def test_el_filtro_nuevo_no_bloquea_abridores_ni_milb():
    assert not _lineup_incomplete(1, 1, {})
    assert not _lineup_incomplete(11, 2, {"lineup_factor_away": 1, "lineup_factor_home": 1})
