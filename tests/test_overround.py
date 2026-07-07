from app.overround import check_overround


def test_absent_market_is_ok():
    r = check_overround(None, None)
    assert r.ok is True
    assert r.overround is None


def test_normal_overround_ok():
    r = check_overround(1.90, 1.90)  # overround = 1.0526...
    assert r.ok is True


def test_below_min_boundary_fails():
    # overround < 1.01 (mercado casi sin vig, sospechoso de error de tecleo)
    r = check_overround(2.05, 2.05)  # 1/2.05*2 = 0.9756
    assert r.ok is False


def test_exactly_at_min_boundary_ok():
    # buscamos un par cuyo overround caiga justo en el limite inferior
    r = check_overround(1.9802, 1.9802)  # ~1.0100
    assert r.overround is not None
    assert 1.005 <= r.overround <= 1.015


def test_above_max_boundary_fails():
    r = check_overround(1.50, 1.50)  # 1/1.5*2 = 1.333
    assert r.ok is False


def test_invalid_odds_below_1_01_fails():
    r = check_overround(0.95, 2.0)
    assert r.ok is False
