"""El render del dashboard es una f-string grande sin cobertura natural (solo se ve al abrir la
pagina en produccion). Estos tests lo ejercitan con datos representativos para que un fallo de
formato o un campo NULL no aparezca por primera vez en el movil del usuario."""
import pytest

from app import dashboard


def _game(**over):
    base = {
        "sport_id": 1, "game_pk": 777, "away_team_name": "Boston Red Sox",
        "home_team_name": "New York Yankees", "status": "Scheduled",
        "hora_local": "14/08 01:05", "game_datetime_utc": None,
        "gate_a": True, "gate_b": False, "last_attempt_age_s": 300,
        "away_ml": None, "home_ml": None, "away_hc_val": None, "away_hc_odds": None,
        "home_hc_val": None, "home_hc_odds": None, "total_line": None,
        "over_odds": None, "under_odds": None, "odds_age_s": None, "picks": 0,
    }
    base.update(over)
    return base


def _event(**over):
    base = {
        "kind": "scrape", "league": "MiLB", "ok": True, "status": "ok", "n_scraped": 13,
        "n_matched": 4, "duration_ms": 240000, "detail": None, "source": "autofetch",
        "exit_ip": "185.220.101.1", "ts_local": "14/08 00:31:02",
    }
    base.update(over)
    return base


def _state(**over):
    base = {
        "tor": {"ok": True, "ip": "185.220.101.1", "is_tor": True, "detail": "", "latency_ms": 812},
        "games": [
            _game(),
            _game(game_pk=778, sport_id=11, away_ml=1.86, home_ml=1.95, total_line=8.5,
                  over_odds=1.9, under_odds=1.9, away_hc_val=1.5, away_hc_odds=1.55,
                  home_hc_val=-1.5, home_hc_odds=2.4, odds_age_s=120, gate_b=True, picks=1),
        ],
        "summary": {"s6": 8, "s6_ok": 5, "s24": 30, "s24_ok": 18, "r24": 4,
                    "last_ok_age_s": 900, "last_any_age_s": 120, "last_rotate_age_s": 3600},
        "events": [_event(), _event(kind="rotate", ok=False, status="misma_ip",
                                    n_scraped=None, n_matched=None, detail="auth rechazada")],
        "db_error": None,
    }
    base.update(over)
    return base


def test_render_completo():
    html = dashboard.render_html(_state())
    assert html.startswith("<!doctype html>")
    assert "Boston Red Sox" in html and "New York Yankees" in html
    assert "185.220.101.1" in html
    assert "1.86 / 1.95" in html          # ML formateado a 2 decimales
    assert "Con cuotas" in html            # partido con cuotas
    assert "Confirmado, SIN cuotas" in html  # gate confirmado y sin cuotas -> el caso a cazar
    assert "1/2" in html                   # contador de partidos con cuotas
    assert "cambio tor" in html            # instruccion de rotacion


def test_render_sin_datos_no_revienta():
    """Contenedor recien arrancado: sin partidos, sin eventos, sin historial."""
    html = dashboard.render_html(_state(
        games=[], events=[],
        summary={"s6": 0, "s6_ok": 0, "s24": 0, "s24_ok": 0, "r24": 0,
                 "last_ok_age_s": None, "last_any_age_s": None, "last_rotate_age_s": None},
    ))
    assert "Sin partidos descubiertos" in html
    assert "nunca" in html
    assert "sin scrapes aún" in html


def test_render_tor_caido_marca_error():
    html = dashboard.render_html(_state(
        tor={"ok": False, "ip": None, "is_tor": None, "detail": "ConnectError: [Errno 111]", "latency_ms": 20000},
    ))
    assert "Tor NO responde" in html
    assert "ConnectError" in html


def test_salida_sin_tor_se_distingue_de_tor_ok():
    """Caso silencioso y peligroso: el proxy responde pero la petición NO salió por Tor, así que
    cuotasahora ve la IP del VPS (bloqueada). No debe pintarse en verde."""
    html = dashboard.render_html(_state(
        tor={"ok": True, "ip": "51.75.1.1", "is_tor": False, "detail": "", "latency_ms": 90},
    ))
    assert "Salida sin Tor" in html
    assert "banner warn" in html


def test_db_caida_sigue_mostrando_estado_de_tor():
    html = dashboard.render_html(_state(games=[], events=[], summary={}, db_error="OSError: pool cerrado"))
    assert "Sin datos de Postgres" in html
    assert "185.220.101.1" in html  # el bloque de Tor no depende de Postgres


@pytest.mark.parametrize("seconds,expected", [
    (None, "nunca"), (0, "hace 0s"), (45, "hace 45s"), (90, "hace 1min"),
    (3600, "hace 1h00"), (7860, "hace 2h11"), (200000, "hace 2d"),
])
def test_age(seconds, expected):
    assert dashboard._age(seconds) == expected
