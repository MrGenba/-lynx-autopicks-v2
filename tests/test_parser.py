from app.parser import parse_odds_message

FULL_MESSAGE = """DET Tigers vs TEX Rangers
DET Tigers ML a cuota 1.76 y TEX Rangers ML a cuota 2.01
Hándicap:
DET Tigers Hándicap -1.5 a cuota 2.30 y TEX Rangers Hándicap +1.5 a cuota 1.58
Carreras totales:
Over 8.5 a cuota 1.86 y Under 8.5 a cuota 1.86"""


def test_parses_full_message():
    p = parse_odds_message(FULL_MESSAGE)
    assert p is not None
    assert p.team1_raw == "DET Tigers"
    assert p.team2_raw == "TEX Rangers"
    assert p.team1_ml == 1.76 and p.team2_ml == 2.01
    assert p.team1_hc_val == -1.5 and p.team1_hc_odds == 2.30
    assert p.team2_hc_val == 1.5 and p.team2_hc_odds == 1.58
    assert p.total_line == 8.5 and p.over_odds == 1.86 and p.under_odds == 1.86


def test_ml_only():
    text = "DET Tigers vs TEX Rangers\nDET Tigers ML a cuota 1.76 y TEX Rangers ML a cuota 2.01"
    p = parse_odds_message(text)
    assert p is not None
    assert p.team1_ml == 1.76
    assert p.team1_hc_val is None
    assert p.total_line is None


def test_hc_only():
    text = (
        "DET Tigers vs TEX Rangers\nHándicap:\n"
        "DET Tigers Hándicap -1.5 a cuota 2.30 y TEX Rangers Hándicap +1.5 a cuota 1.58"
    )
    p = parse_odds_message(text)
    assert p is not None
    assert p.team1_ml is None
    assert p.team1_hc_val == -1.5


def test_totals_only():
    text = "DET Tigers vs TEX Rangers\nCarreras totales:\nOver 8.5 a cuota 1.86 y Under 8.5 a cuota 1.86"
    p = parse_odds_message(text)
    assert p is not None
    assert p.total_line == 8.5
    assert p.team1_ml is None


def test_no_markets_returns_none():
    p = parse_odds_message("DET Tigers vs TEX Rangers\nhola, sin cuotas aqui")
    assert p is None


def test_unrelated_message_returns_none():
    assert parse_odds_message("/status") is None
    assert parse_odds_message("hola que tal") is None


def test_at_separator_also_works():
    text = "DET Tigers @ TEX Rangers\nDET Tigers ML a cuota 1.76 y TEX Rangers ML a cuota 2.01"
    p = parse_odds_message(text)
    assert p is not None
    assert p.team1_raw == "DET Tigers"


def test_mismatched_total_line_warns():
    text = "DET Tigers vs TEX Rangers\nCarreras totales:\nOver 8.5 a cuota 1.86 y Under 9 a cuota 1.90"
    p = parse_odds_message(text)
    assert p is not None
    assert any("no coinciden" in w for w in p.warnings)
