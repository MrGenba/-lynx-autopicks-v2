from app.clv import _side_base, closing_for_pick

VALUES = {
    "away_ml": 2.05, "home_ml": 1.80,
    "away_hc_val": 1.5, "away_hc_odds": 1.72, "home_hc_val": -1.5, "home_hc_odds": 2.10,
    "total_line": 8.5, "over_odds": 1.91, "under_odds": 1.90,
}


def test_side_base():
    assert _side_base("OVER 8.5") == "over"
    assert _side_base("UNDER 8.5") == "under"
    assert _side_base("AWAY +1.5") == "away"
    assert _side_base("HOME") == "home"
    assert _side_base(None) == ""


def test_closing_ml():
    assert closing_for_pick(VALUES, "ML", "AWAY") == (2.05, 1.80, None)
    assert closing_for_pick(VALUES, "ML", "HOME") == (1.80, 2.05, None)


def test_closing_ou_embeds_line_and_opposite():
    # el lado del pick primero, el contrario despues (para de-vig), + la linea
    assert closing_for_pick(VALUES, "OU", "OVER 8.5") == (1.91, 1.90, 8.5)
    assert closing_for_pick(VALUES, "OU", "UNDER 8.5") == (1.90, 1.91, 8.5)
    # tambien acepta market ya normalizado
    assert closing_for_pick(VALUES, "OVER", "over") == (1.91, 1.90, 8.5)


def test_closing_hc():
    assert closing_for_pick(VALUES, "HC", "AWAY +1.5") == (1.72, 2.10, 1.5)
    assert closing_for_pick(VALUES, "HC", "HOME -1.5") == (2.10, 1.72, -1.5)
    assert closing_for_pick(VALUES, "HC_HOME", "home") == (2.10, 1.72, -1.5)


def test_closing_none_when_market_line_missing():
    empty = {k: None for k in VALUES}
    assert closing_for_pick(empty, "ML", "AWAY") == (None, None, None)
