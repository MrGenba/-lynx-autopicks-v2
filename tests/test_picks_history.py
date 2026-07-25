from app.pipelines import (
    PICKS_HISTORY_COLUMNS,
    build_picks_history_row,
    _norm_market_side,
)


def test_norm_market_side_ml():
    assert _norm_market_side("ML", "AWAY") == ("ML", "away")
    assert _norm_market_side("ML", "HOME") == ("ML", "home")


def test_norm_market_side_ou():
    assert _norm_market_side("OU", "OVER 8.5") == ("OVER", "over")
    assert _norm_market_side("OU", "UNDER 8.5") == ("UNDER", "under")


def test_norm_market_side_hc():
    assert _norm_market_side("HC", "AWAY +1.5") == ("HC_AWAY", "away")
    assert _norm_market_side("HC", "HOME -1.5") == ("HC_HOME", "home")


RESULT = {"data_score": 0.80, "away_mu": 4.20, "home_mu": 4.84}
CAND_ML = {
    "market": "ML", "pick_side": "AWAY", "odds": 3.35, "edge": 0.24, "edge_threshold": 0.18,
    "prob_model": 0.42, "prob_estimated": 0.37, "prob_blended": 0.37, "prob_implied": 0.30,
    "total_line": None, "hc_value": None, "pick_team": "Colorado Rockies", "confidence": None,
}
CAND_OU = {
    "market": "OU", "pick_side": "UNDER 8.5", "odds": 1.96, "edge": 0.20, "edge_threshold": 0.18,
    "prob_model": 0.60, "prob_estimated": 0.60, "prob_blended": None, "prob_implied": 0.51,
    "total_line": 8.5, "hc_value": None, "pick_team": None, "confidence": None,
}


def _assert_only_allowed(table, row):
    assert set(row).issubset(PICKS_HISTORY_COLUMNS[table]), (
        f"columnas fuera del allowlist de {table}: {set(row) - PICKS_HISTORY_COLUMNS[table]}"
    )


def test_build_mlb_ml_row():
    table, row = build_picks_history_row(1, 823759, "2026-07-24", "Colorado Rockies", "Milwaukee Brewers", RESULT, CAND_ML, 2)
    assert table == "mlb_picks_history"
    _assert_only_allowed(table, row)
    # MLB conserva el encoding canonico del best_pick
    assert row["market"] == "ML" and row["pick_side"] == "AWAY"
    assert row["game_pk"] == 823759 and row["game_id"] == "823759"
    assert row["published"] is True and row["result"] == "PENDING"
    assert row["stake"] == 1 and row["prob_model"] == 0.42
    assert row["away_runs_predicted"] == 4.20 and row["notes"] == "autopicks_v2 p2"


def test_build_mlb_ou_row_embeds_line_in_pick_side():
    # pick_side crudo sin linea -> se reconstruye "UNDER 8.5" desde base + total_line
    _, row = build_picks_history_row(1, 900, "2026-07-24", "A", "B", RESULT, {**CAND_OU, "pick_side": "UNDER"}, 1)
    assert row["market"] == "OU" and row["pick_side"] == "UNDER 8.5" and row["total_line"] == 8.5


def test_build_mlb_hc_row_embeds_sign_in_pick_side():
    cand_hc = {"market": "HC", "pick_side": "AWAY", "odds": 2.45, "edge": 0.23, "edge_threshold": 0.18,
               "prob_model": 0.5, "prob_implied": 0.42, "total_line": None, "hc_value": 1.5, "pick_team": "X"}
    _, row = build_picks_history_row(1, 901, "2026-05-27", "A", "B", RESULT, cand_hc, 1)
    assert row["market"] == "HC" and row["pick_side"] == "AWAY +1.5" and row["hc_value"] == 1.5


def test_build_milb_ou_row_normalizes_market_side():
    table, row = build_picks_history_row(11, 5551, "2026-07-24", "Away AAA", "Home AAA", RESULT, CAND_OU, 1)
    assert table == "picks_history"
    _assert_only_allowed(table, row)
    # MiLB normaliza a market OVER/UNDER + columna 'side' minuscula
    assert row["market"] == "UNDER" and row["side"] == "under"
    assert row["liga"] == "MiLB" and row["source"] == "autopicks_v2"
    assert row["total_line"] == 8.5 and row["game_id"] == 5551
    assert row["prob_estimated"] == 0.60  # prob_blended None -> cae a prob_model


def test_build_lmb_ml_row_lowercase_pickside():
    table, row = build_picks_history_row(23, 846370, "2026-07-24", "Tecos", "Acereros", RESULT, CAND_ML, 2)
    assert table == "lmb_picks_history"
    _assert_only_allowed(table, row)
    assert row["market"] == "ML" and row["pick_side"] == "away"
    assert row["source"] == "autopicks_v2" and row["game_id"] == 846370
    # lmb usa columnas *_pred (no *_predicted)
    assert row["away_runs_pred"] == 4.20 and row["home_runs_pred"] == 4.84


def test_no_pick_side_line_leaks_into_milb_side():
    # aunque el pick_side canonico traiga la linea, 'side' queda limpio
    _, row = build_picks_history_row(11, 1, "2026-07-24", "A", "B", RESULT, CAND_OU, 1)
    assert row["side"] in {"over", "under"}
