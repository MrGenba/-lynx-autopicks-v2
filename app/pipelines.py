"""El disparador de pipelines -- llamado tanto por el detector (tick cada 180s) como por el
manejador de mensajes de Telegram cuando llegan cuotas. Es la MISMA funcion en ambos casos,
lo que evita divergencia entre "quien se dio cuenta primero".

Idempotencia: el INSERT...ON CONFLICT DO NOTHING en pipeline_runs es lo que garantiza un solo
disparo real por partido/pipeline, incluso si el detector y Telegram llegan casi a la vez o si
el proceso se reinicia a mitad. La comprobacion de "ya existe" de mas arriba es solo una
optimizacion (evita reconstruir el objeto game innecesariamente); la garantia real esta en la
restriccion UNIQUE de la base de datos, no en la logica de la aplicacion.
"""
import datetime as dt
import json
import logging
import math
from dataclasses import dataclass
from typing import Optional
from zoneinfo import ZoneInfo

import asyncpg
import httpx

from app.adapters import Adapter, Mode
from app.node_bridge import NodeBridgeError, run_quant
from app.supabase_client import SupabaseClient
from app.telegram import TelegramClient

logger = logging.getLogger(__name__)

LEAGUE_KEY = {1: "mlb", 11: "milb", 23: "lmb"}
LEAGUE_LABEL = {1: "MLB", 11: "MiLB", 23: "LMB"}

# Aviso de banda de edge MLB (2026-09-02, creado con Fable): HC/OU con edge en [8%, umbral de
# publicacion) -- la banda que el analisis in-sample dio rentable (HC 8-18%: hit 73.3% ROI +36%
# n=15; OU: hit 55.3% ROI +5.6% n=47; ML en esa banda PIERDE, por eso queda fuera. Ver CLAUDE.md
# "¿MLB bate al mercado?"). Es SOLO un aviso al chat privado del admin, NUNCA publica al canal ni
# toca el umbral del 18% (regla del proyecto: umbrales intocables sin backtest concluyente -- el
# paper-trading paper_trade_mlb_pockets.js esta validando la banda fuera de muestra).
# Dedup en memoria por (game_pk, market, side): se avisa en la PRIMERA pasada que cruza (abridores
# o lineup); la pasada de lineup solo re-avisa si es un cruce nuevo que abridores no señalo.
# Se pierde el dedup si el contenedor se reinicia -- peor caso, un aviso duplicado, aceptable.
EDGE_ALERT_SPORT_ID = 1
EDGE_ALERT_MARKETS = {"HC", "OU"}
EDGE_ALERT_MIN = 0.08
_edge_alert_keys: set = set()

# Dedup en memoria del aviso "pick bloqueado por cuota pre-lineup" (FIX #3, ver try_fire_pipeline).
# Sin esto el detector avisaria en cada tick (cada 180s) del mismo partido. Se pierde al reiniciar
# el contenedor -- peor caso, un aviso repetido, aceptable.
_stale_odds_notice_keys: set = set()
CANDIDATES_HISTORY_TABLE = {1: "mlb_candidates_history", 11: "candidates_history", 23: "lmb_candidates_history"}
# Columnas reales por tabla (verificadas contra Supabase 2026-07-11 antes de escribir -- mismo
# bug ya sufrido una vez con prob_edge faltante en mlb_picks_history, ver CLAUDE.md/KNOWN_ISSUES).
# Solo se envian las columnas que existen de verdad en cada tabla, nunca el superset completo.
CANDIDATES_HISTORY_COLUMNS = {
    "mlb_candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "matchup_label", "prob_model", "market_prob", "fair_odds",
        "model_version", "source", "odds_captured_at",
    },
    "candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "matchup_label", "away_team", "home_team", "source",
        "odds_captured_at",
    },
    "lmb_candidates_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "prob_estimated",
        "prob_implied", "prob_edge", "edge", "edge_threshold", "data_score", "published", "result",
        "total_line", "hc_value", "diag_flags", "away_runs_predicted", "home_runs_predicted",
        "league", "created_at", "source", "odds_captured_at",
    },
}

# Tabla de picks PUBLICADOS por liga (Fix A, 2026-07-25). Cada tabla tiene su propio encoding de
# market/side (verificado con filas reales antes de escribir, mismo criterio que candidates):
#   - mlb_picks_history : market ML/HC/OU, pick_side 'AWAY'/'OVER 8.5'/'AWAY +1.5' (igual que best_pick)
#   - picks_history     : market ML/OVER/UNDER/HC_AWAY/HC_HOME, columna 'side' minuscula, 'liga'
#   - lmb_picks_history : market ML/OVER/UNDER/HC_AWAY/HC_HOME, pick_side minuscula, cols *_pred (no *_predicted)
PICKS_HISTORY_TABLE = {1: "mlb_picks_history", 11: "picks_history", 23: "lmb_picks_history"}
PICKS_HISTORY_COLUMNS = {
    "mlb_picks_history": {
        "game_pk", "game_id", "game_date", "away_team", "home_team", "market", "pick_side",
        "odds", "hc_value", "total_line", "prob_model", "prob_implied", "prob_edge", "edge",
        "edge_threshold", "data_score", "confidence", "stake", "stake_recommended", "published",
        "result", "notes", "away_runs_predicted", "home_runs_predicted",
    },
    "picks_history": {
        "game_id", "game_date", "matchup_label", "market", "side", "team_label", "odds",
        "prob_estimated", "prob_implied", "prob_blended", "edge", "stake", "stake_recommended",
        "total_line", "hc_value", "data_score", "confidence", "liga", "published", "result",
        "away_team", "home_team", "source",
    },
    "lmb_picks_history": {
        "game_id", "game_date", "market", "pick_side", "pick_team", "odds", "hc_value",
        "total_line", "prob_estimated", "prob_implied", "prob_edge", "edge", "edge_threshold",
        "data_score", "confidence", "result", "stake", "stake_recommended", "matchup_label",
        "published", "away_team", "home_team", "source", "away_runs_pred", "home_runs_pred",
    },
}

# Stake fijo 0.25u (entero x4 = 1) hasta recalibracion -- mismo valor que produccion n8n.
STAKE_FIXED = 1


def _norm_market_side(market: Optional[str], pick_side: Optional[str]) -> tuple[str, str]:
    """Normaliza market/pick_side a (market, side) para picks_history (MiLB) y lmb_picks_history:
    market -> ML / OVER / UNDER / HC_AWAY / HC_HOME ; side -> away/home/over/under.
    Acepta AMBOS encodings: el ya-normalizado del motor MiLB/LMB (market 'OVER'/'UNDER'/'HC_AWAY'/
    'HC_HOME'/'ML') y el canonico de MLB ('OU'/'HC'/'ML' con la linea/signo en pick_side).
    Fix 2026-07-25: antes solo miraba 'OU'/'HC' y caia al else -> 'ML' para los 'OVER'/'UNDER'
    reales de MiLB (un pick UNDER se guardaba como market='ML')."""
    m = (market or "").upper()
    ps = (pick_side or "").lower().split(" ")[0]
    if ps in ("over", "under", "home", "away"):
        side = ps
    elif m == "OVER":
        side = "over"
    elif m == "UNDER":
        side = "under"
    elif m == "HC_HOME":
        side = "home"
    elif m == "HC_AWAY":
        side = "away"
    else:
        side = "away"
    if m in ("OU", "OVER", "UNDER"):
        norm = "OVER" if side == "over" else "UNDER"
    elif m in ("HC", "HC_AWAY", "HC_HOME"):
        norm = "HC_AWAY" if side == "away" else "HC_HOME"
    else:
        norm = "ML"
    return norm, side


def _pick_missing_line(cand: dict) -> bool:
    """True si el pick es impublicable por falta de numero: un OU sin total_line o un HC sin
    hc_value. ML no necesita linea. Usado como guard antes de publicar (2026-07-25)."""
    m = (cand.get("market") or "").upper()
    if m in ("OU", "OVER", "UNDER"):
        return cand.get("total_line") is None
    if m in ("HC", "HC_AWAY", "HC_HOME"):
        return cand.get("hc_value") is None
    return False


def build_picks_history_row(
    sport_id: int, game_pk: int, game_date, away_team: str, home_team: str,
    result: dict, pub_cand: dict, pipeline: int,
) -> tuple[str, dict]:
    """Construye la fila de *_picks_history para el pick PUBLICADO (best_pick / su candidato).
    Solo se envian columnas que existen de verdad en cada tabla (PICKS_HISTORY_COLUMNS) para no
    reintroducir el fallo de 'columna inexistente'. Ver CLAUDE.md/KNOWN_ISSUES (Fix A 2026-07-25)."""
    table = PICKS_HISTORY_TABLE[sport_id]
    allowed = PICKS_HISTORY_COLUMNS[table]
    market = pub_cand.get("market")
    pick_side = pub_cand.get("pick_side")
    odds = pub_cand.get("odds")
    prob_model = pub_cand.get("prob_model") or pub_cand.get("prob_estimated")
    prob_implied = pub_cand.get("prob_implied")
    prob_blended = pub_cand.get("prob_blended")
    prob_final = prob_blended if prob_blended is not None else prob_model
    prob_edge = (prob_final - prob_implied) if (prob_final is not None and prob_implied is not None) else None
    total_line = pub_cand.get("total_line")
    hc_value = pub_cand.get("hc_value")
    edge = pub_cand.get("edge")
    edge_threshold = pub_cand.get("edge_threshold")
    data_score = result.get("data_score")
    confidence = pub_cand.get("confidence")
    # 2026-08-29: el motor vendorizado (quant_engine*.js) devuelve away_runs/home_runs, no
    # away_mu/home_mu -- esas claves nunca existieron, away_runs_predicted/home_runs_predicted
    # llevaban NULL desde la migracion a autopicks_v2 (jul-2026). Bug de telemetria (el edge/
    # prob_estimated se calculan bien dentro del motor con sus propias variables internas), pero
    # sin esto no se puede auditar el modelo de MiLB/LMB.
    away_mu = result.get("away_runs")
    home_mu = result.get("home_runs")
    matchup = f"{away_team} @ {home_team}"
    pick_team = pub_cand.get("pick_team") or _pick_team_for(pick_side, away_team, home_team)
    notes = f"autopicks_v2 p{pipeline}"

    if table == "mlb_picks_history":
        # MLB: market ML/HC/OU + pick_side con linea/signo embebidos ("UNDER 8.5", "AWAY +1.5").
        # Se reconstruye desde la base + total_line/hc_value en vez de confiar en el pick_side crudo,
        # que puede venir inconsistente ("UNDER" vs "UNDER 8.5") segun quien escribio el candidato.
        base = (pick_side or "").upper().split(" ")[0]  # AWAY/HOME/OVER/UNDER
        if market == "OU":
            pick_side_db = base + (f" {total_line}" if total_line is not None else "")
        elif market == "HC":
            sign = "+" if (hc_value is not None and hc_value >= 0) else ""
            pick_side_db = base + (f" {sign}{hc_value}" if hc_value is not None else "")
        else:
            pick_side_db = base
        full = {
            "game_pk": game_pk, "game_id": str(game_pk), "game_date": game_date,
            "away_team": away_team, "home_team": home_team,
            "market": market, "pick_side": pick_side_db, "odds": odds,
            "hc_value": hc_value, "total_line": total_line,
            "prob_model": prob_model, "prob_implied": prob_implied, "prob_edge": prob_edge,
            "edge": edge, "edge_threshold": edge_threshold, "data_score": data_score,
            "confidence": confidence, "stake": STAKE_FIXED, "stake_recommended": STAKE_FIXED,
            "published": True, "result": "PENDING", "notes": notes,
            "away_runs_predicted": away_mu, "home_runs_predicted": home_mu,
        }
    elif table == "picks_history":
        norm_market, side = _norm_market_side(market, pick_side)
        full = {
            "game_id": game_pk, "game_date": game_date, "matchup_label": matchup,
            "market": norm_market, "side": side, "team_label": pick_team, "odds": odds,
            "prob_estimated": prob_final, "prob_implied": prob_implied, "prob_blended": prob_blended,
            "edge": edge, "stake": STAKE_FIXED, "stake_recommended": STAKE_FIXED,
            "total_line": total_line, "hc_value": hc_value, "data_score": data_score,
            "confidence": confidence, "liga": "MiLB", "published": True, "result": "PENDING",
            "away_team": away_team, "home_team": home_team, "source": "autopicks_v2",
        }
    else:  # lmb_picks_history
        norm_market, side = _norm_market_side(market, pick_side)
        full = {
            "game_id": game_pk, "game_date": game_date,
            "market": norm_market, "pick_side": side, "pick_team": pick_team, "odds": odds,
            "hc_value": hc_value, "total_line": total_line,
            "prob_estimated": prob_final, "prob_implied": prob_implied, "prob_edge": prob_edge,
            "edge": edge, "edge_threshold": edge_threshold, "data_score": data_score,
            "confidence": confidence, "result": "PENDING",
            "stake": STAKE_FIXED, "stake_recommended": STAKE_FIXED, "matchup_label": matchup,
            "published": True, "away_team": away_team, "home_team": home_team, "source": "autopicks_v2",
            "away_runs_pred": away_mu, "home_runs_pred": home_mu,
        }
    return table, {k: v for k, v in full.items() if k in allowed}


@dataclass
class PipelineContext:
    pool: asyncpg.Pool
    adapters: dict[int, Adapter]
    telegram: TelegramClient  # bot NUEVO -- polling (recibe cuotas) + avisos al admin
    picks_telegram: TelegramClient  # @Lynx_HunterBot (produccion) -- SOLO para publicar picks al
    # canal de produccion existente; enviar mensajes no choca con el webhook de n8n de ese bot,
    # solo RECIBIR (polling) chocaria, y este bot nunca hace polling en este sistema.
    admin_chat_id: int
    picks_channel_id: int
    node_bin: str
    vendor_dir: str
    supabase: SupabaseClient  # lectura de vistas + escritura SOLO en *_candidates_history (ver supabase_client.py)
    http_client: httpx.AsyncClient
    # Proxy para vendor/run_odds_scraper.js (Tor local) -- ver app/odds_autofetch.py. None = sin
    # proxy (el scraper fallara igual que produccion, bloqueado por cuotasahora.com).
    proxy_server: Optional[str] = None
    # Proxy SEPARADO solo para LMB (2a instancia Tor con salida en Mexico) -- ver Config. 2026-08-02.
    proxy_server_lmb: Optional[str] = None
    # odds-api.io (2026-07-11) -- fuente primaria nueva, ver app/odds_api_client.py. None =
    # desactivada, cae directo al scraper de Tor (comportamiento identico a antes de esto).
    odds_api_key: Optional[str] = None
    # oddspapi.io (2026-08-29) -- respaldo de Tor SOLO para MiLB/LMB, ver
    # app/oddspapi_client.py y odds_autofetch._try_oddspapi_fallback. None = sin respaldo.
    oddspapi_key: Optional[str] = None


async def get_odds(pool: asyncpg.Pool, sport_id: int, game_pk: int) -> Optional[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM game_odds WHERE sport_id = $1 AND game_pk = $2", sport_id, game_pk
        )


def _num(v):
    """asyncpg devuelve las columnas NUMERIC de game_odds como Decimal -- json.dumps no sabe
    serializarlas (run_quant.js solo necesita precision de float, no la exactitud de Decimal)."""
    return float(v) if v is not None else None


def build_quant_payload(game: dict, odds: asyncpg.Record) -> dict:
    return {
        "game": game,
        "away_ml": _num(odds["away_ml"]),
        "home_ml": _num(odds["home_ml"]),
        "away_hc_val": _num(odds["away_hc_val"]),
        "away_hc_odds": _num(odds["away_hc_odds"]),
        "home_hc_val": _num(odds["home_hc_val"]),
        "home_hc_odds": _num(odds["home_hc_odds"]),
        "total_line": _num(odds["total_line"]),
        "over_odds": _num(odds["over_odds"]),
        "under_odds": _num(odds["under_odds"]),
    }


def _fmt_odds(v) -> str:
    return f"{float(v):.2f}" if v is not None else "?"


def _lineup_incomplete(sport_id: int, pipeline: int, game_obj: dict) -> bool:
    """MLB/MiLB ajustan mu por calidad real de lineup (Fase 2, ver quant_engine_mlb.js/quant_engine.js)
    -- si lineup_watch aun no lo reevaluo, el motor sigue calculando pero SIN ese ajuste, en
    silencio (mismo resultado que pitchers_only aunque el pipeline se llame "full_lineup").
    LMB no tiene este ajuste en absoluto (quant_engine_lmb.js no referencia lineup_factor por
    ningun lado) -- avisar ahi seria ruido constante, no una alerta real, asi que se excluye."""
    if pipeline != 2 or sport_id not in (1, 11):
        return False
    return game_obj.get("lineup_factor_away") is None or game_obj.get("lineup_factor_home") is None


_LEAGUE_HEADER = {
    "MLB": "⚾️ *MLB* 🇺🇸",
    "MiLB": "⚾️ *MiLB* 🇺🇸",
    "LMB": "⚾️ *LMB* 🇲🇽",
}


def _n(v) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _pct(v, d: int = 1) -> str:
    n = _n(v)
    return "N/A" if n is None else f"{n * 100:.{d}f} %"


def _dec2(v) -> Optional[float]:
    n = _n(v)
    return None if n is None else round(n, 2)


def _to_odds_decimal(v) -> Optional[float]:
    o = _n(v)
    if o is None or o == 0:
        return None
    if 1.01 <= o <= 15:
        return _dec2(o)
    return _dec2(o / 100 + 1 if o > 0 else 100 / abs(o) + 1)


def _min_odds_for_target(prob_tip, push_prob=0, target: float = 0.18) -> Optional[float]:
    p = _n(prob_tip)
    pp = _n(push_prob) or 0
    if p is None or p <= 0:
        return None
    return _dec2((1 + target - pp) / p)


def _market_tag(c: dict) -> str:
    m = str(c.get("market") or "").upper()
    if m == "ML":
        return "ML"
    if m in ("HC", "HC_AWAY", "HC_HOME"):
        return "HC"
    if m in ("OVER", "UNDER", "OU"):
        return "TOTAL"
    return m or "N/A"


def _pick_side_team(c: dict, away: str, home: str) -> str:
    side = str(c.get("pick_side") or "").upper()
    if c.get("pick_team"):
        return c["pick_team"]
    if "AWAY" in side:
        return away
    if "HOME" in side:
        return home
    return away


def _side_label(c: dict, away: str, home: str) -> str:
    """Lado apostado en texto legible para los mensajes del canal de cuotas: nombre del equipo en
    ML/HC (el usuario pidio 2026-09-04 ver el equipo, no 'HOME'/'AWAY') y over/under tal cual en
    totales, donde el lado no es un equipo. No toca el pick_side que se guarda en la BD."""
    side = str(c.get("pick_side") or "")
    upper = side.upper()
    if "OVER" in upper or "UNDER" in upper:
        return side
    if c.get("pick_team"):
        return str(c["pick_team"])
    if "AWAY" in upper:
        return away
    if "HOME" in upper:
        return home
    return side


def _handicap_line(c: dict, game_obj: dict, away: str, home: str) -> Optional[float]:
    side = str(c.get("pick_side") or "").upper()
    away_ln = _n(game_obj.get("away_hc_line") if game_obj.get("away_hc_line") is not None else game_obj.get("away_hc_val"))
    home_ln = _n(game_obj.get("home_hc_line") if game_obj.get("home_hc_line") is not None else (game_obj.get("home_hc_val") if game_obj.get("home_hc_val") is not None else (-away_ln if away_ln is not None else None)))
    side_line = _n(c.get("hc_value"))
    if side_line is not None:
        return side_line
    if "AWAY" in side:
        return away_ln
    if "HOME" in side:
        return home_ln
    if c.get("pick_team") == away:
        return away_ln
    if c.get("pick_team") == home:
        return home_ln
    return None


def _total_line(c: dict, game_obj: dict) -> Optional[float]:
    return _n(c.get("total_line") if c.get("total_line") is not None else game_obj.get("total_line"))


def _pick_label(c: dict, game_obj: dict, away: str, home: str) -> str:
    m = _market_tag(c)
    team = _pick_side_team(c, away, home)
    if m == "ML":
        return f"{team} ML"
    if m == "HC":
        ln = _handicap_line(c, game_obj, away, home)
        ln_txt = "N/A" if ln is None else (f"+{_js_num_str(ln)}" if ln >= 0 else _js_num_str(ln))
        return f"{team} Handicap {ln_txt}"
    if m == "TOTAL":
        side = str(c.get("pick_side") or "").upper()
        tl = _total_line(c, game_obj)
        tl_txt = _js_num_str(tl)
        if str(c.get("market") or "").upper() == "UNDER" or "UNDER" in side:
            return f"Under {tl_txt}"
        return f"Over {tl_txt}"
    return team


def _js_num_str(v) -> str:
    """JS interpola numeros sin ceros decimales sobrantes (7 en vez de 7.0, 7.5 se queda 7.5) --
    replica ese comportamiento para que "Over 7"/"Handicap +1.5" salgan igual que en produccion,
    en vez del 7.0/1.5 que da un f-string de Python sobre un float sin mas."""
    if v is None:
        return "N/A"
    n = _n(v)
    if n is None:
        return str(v)
    return str(int(n)) if n == int(n) else str(n)


def _pf100(v) -> Optional[int]:
    n = _n(v)
    if n is None:
        return None
    return round(n * 100) if n <= 2 else round(n)


def _build_metrics(game_obj: dict, result: dict, lead: dict) -> str:
    parts = []
    away_exp = _n(result.get("away_runs") if result.get("away_runs") is not None else result.get("away_mu"))
    home_exp = _n(result.get("home_runs") if result.get("home_runs") is not None else result.get("home_mu"))
    if away_exp is not None and home_exp is not None:
        parts.append(f"score exp {away_exp:.2f}-{home_exp:.2f}")
    sp_ax = _n(game_obj.get("away_p_opp_xwoba") if game_obj.get("away_p_opp_xwoba") is not None else game_obj.get("away_p_xwoba"))
    sp_hx = _n(game_obj.get("home_p_opp_xwoba") if game_obj.get("home_p_opp_xwoba") is not None else game_obj.get("home_p_xwoba"))
    if sp_ax is not None and sp_hx is not None:
        parts.append(f"SP xwOBA {sp_ax:.3f} vs {sp_hx:.3f}")
    bp_af = _n(game_obj.get("away_bullpen_fip"))
    bp_hf = _n(game_obj.get("home_bullpen_fip"))
    if bp_af is not None and bp_hf is not None:
        parts.append(f"bullpen FIP {bp_af:.2f} vs {bp_hf:.2f}")
    lx_a = _n(game_obj.get("away_team_xwoba") if game_obj.get("away_team_xwoba") is not None else game_obj.get("away_team_woba"))
    lx_h = _n(game_obj.get("home_team_xwoba") if game_obj.get("home_team_xwoba") is not None else game_obj.get("home_team_woba"))
    lx_label = "xwOBA" if (_n(game_obj.get("away_team_xwoba")) is not None or _n(game_obj.get("home_team_xwoba")) is not None) else "wOBA"
    if lx_a is not None and lx_h is not None:
        parts.append(f"lineup {lx_label} {lx_a:.3f} vs {lx_h:.3f}")
    t = _n(game_obj.get("temperature_2m"))
    tail = _n(game_obj.get("wind_tailwind"))
    if t is not None or tail is not None:
        env_t = f"{t:.0f}C" if t is not None else "?"
        env_w = f"{tail:.1f}kmh" if tail is not None else "?"
        parts.append(f"env {env_t} / tail {env_w}")
    return " | ".join(parts) if parts else "N/A"


def _date_only(v) -> Optional[str]:
    if not v:
        return None
    s = str(v)
    return s[:10] if len(s) >= 10 and s[4] == "-" and s[7] == "-" else None


def _date_only_to_es(date_only: Optional[str]) -> Optional[str]:
    if not date_only:
        return None
    parts = date_only.split("-")
    if len(parts) != 3:
        return date_only
    return f"{parts[2]}/{parts[1]}/{parts[0]}"


def _dt_parts(raw, tz_name: str) -> Optional[dict]:
    if not raw:
        return None
    try:
        s = str(raw).replace("Z", "+00:00")
        d = dt.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    local = d.astimezone(ZoneInfo(tz_name))
    return {"date": local.strftime("%d/%m/%Y"), "time": local.strftime("%H:%M")}


def _game_time_label(raw, date_only: Optional[str]) -> str:
    es = _dt_parts(raw, "Europe/Madrid")
    et = _dt_parts(raw, "America/New_York")
    if es and et:
        if es["date"] == et["date"]:
            return f"{es['date']} · {es['time']}h ES / {et['time']}h ET"
        return f"ES {es['date']} {es['time']}h / ET {et['date']} {et['time']}h"
    d = _date_only_to_es(date_only)
    if d and es:
        return f"{d} · {es['time']}h ES / hora N/A ET"
    if d:
        return f"{d} · hora N/A ES / hora N/A ET"
    return "hora N/A ES / hora N/A ET"


def _build_lectura_simple(pick_txt, odds, edge_ev, prob_tip, prob_imp, pick_side) -> str:
    edge_pct = f"{edge_ev * 100:.1f}%" if edge_ev is not None else "?"
    odds_txt = f"{odds:.2f}" if odds is not None else "?"
    prob_txt = f"{prob_tip * 100:.0f}%" if prob_tip is not None else "?"
    side = " ".join(str(pick_side or pick_txt).split())
    return f"{side} @{odds_txt} · ventaja {edge_pct} (modelo {prob_txt} vs {_pct(prob_imp)} mercado)"


def _build_analisis_fallback(away_exp, home_exp, total_exp, data_score, edge_ev) -> str:
    parts = []
    if away_exp is not None and home_exp is not None:
        total_txt = f"{total_exp:.1f}" if total_exp is not None else f"{away_exp + home_exp:.1f}"
        parts.append(f"Proyección {away_exp:.2f}+{home_exp:.2f}={total_txt} carreras")
    ds = _n(data_score)
    if ds is not None:
        parts.append(f"data score {round(ds * 100)}%")
    if edge_ev is not None:
        parts.append(f"edge {edge_ev * 100:.1f}%")
    return (" · ".join(parts) + ".") if parts else "Análisis no disponible."


def _innings_no_estandar(game_obj: dict) -> Optional[int]:
    """Entradas programadas cuando NO son 9 (dobles jornadas de 7); None si son 9 o se desconocen.

    Misma normalizacion que format_pick_message: por debajo de 5 se considera dato basura y se
    trata como 9 (no bloquear por un valor corrupto).
    """
    innings_raw = _n(game_obj.get("scheduled_innings"))
    if innings_raw is None or innings_raw < 5:
        return None
    innings = round(innings_raw)
    return innings if innings != 9 else None


def format_pick_message(
    league_label: str, pipeline: int, away_team: str, home_team: str,
    game_obj: dict, result: dict, lineup_incomplete: bool = False,
) -> str:
    """Mismo formato que ya usa producción (nodo n8n 'Formatear MLB'/'Formatear MiLB'/
    'Formatear LMB') -- a petición del usuario 2026-07-21, para que los picks de Auto-Picks v2
    (experimental) se lean igual que los de producción. No usa Claude (claudeRead en la versión
    n8n) porque Auto-Picks v2 no tiene esa API key configurada -- usa directamente el fallback
    local que la propia versión n8n ya tiene para cuando Claude no responde."""
    best_pick = result.get("best_pick") or {}
    candidates = sorted(result.get("candidates") or [], key=lambda c: (_n(c.get("edge")) if _n(c.get("edge")) is not None else -999), reverse=True)
    lead = best_pick or (candidates[0] if candidates else {})

    innings_raw = _n(game_obj.get("scheduled_innings"))
    innings = round(innings_raw) if innings_raw is not None and innings_raw >= 5 else 9
    dh = str(game_obj.get("double_header") or "N")
    game_no = _n(game_obj.get("game_number"))
    dh_label = f" DH G{round(game_no)}" if dh == "Y" and game_no is not None else (" DH" if dh == "Y" else "")

    odds = _to_odds_decimal(lead.get("odds"))
    prob_blended = _n(lead.get("prob_blended"))
    # 2026-08-05: MLB emite prob_model; MiLB/LMB emiten raw_prob_estimated (prob del modelo antes de
    # calibrar) pero NO prob_model -> el mensaje salia "Prob. modelo: N/A". Fallback a
    # raw_prob_estimated, y en ultimo caso a prob_estimated (el calibrado), para no mostrar N/A.
    prob_model = _n(lead.get("prob_model")) or _n(lead.get("raw_prob_estimated")) or _n(lead.get("prob_estimated"))
    prob_tip = _n(lead.get("prob_estimated") if lead.get("prob_estimated") is not None else (prob_blended if prob_blended is not None else prob_model))
    prob_imp = _n(lead.get("prob_implied"))
    push_prob = _n(lead.get("push_prob")) or 0
    edge_ev = _n(lead.get("edge"))
    if edge_ev is None and prob_tip is not None and odds is not None:
        edge_ev = prob_tip * odds + push_prob - 1
    edge_model = (prob_model * odds + push_prob - 1) if (prob_model is not None and odds is not None) else None
    edge_prob = (prob_tip - prob_imp) if (prob_tip is not None and prob_imp is not None) else None
    fair_tip = _dec2(1 / prob_tip) if (prob_tip is not None and prob_tip > 0) else None
    min_odds_18 = _min_odds_for_target(prob_tip, push_prob, 0.18)
    stake = 0.25  # stake fijo hasta nueva calibración, igual que produccion

    pick_txt = _pick_label(lead, game_obj, away_team, home_team)
    market = _market_tag(lead)
    away_pitcher = game_obj.get("away_pitcher_name") or "N/A"
    home_pitcher = game_obj.get("home_pitcher_name") or "N/A"
    stadium = game_obj.get("venue_name") or game_obj.get("stadium_name") or "N/A"
    pf_runs = _pf100(game_obj.get("park_factor_runs") if game_obj.get("park_factor_runs") is not None else game_obj.get("park_factor"))
    pf_hr_raw = game_obj.get("park_factor_hr")
    if pf_hr_raw is None and league_label == "LMB":
        pf_hr_raw = game_obj.get("park_factor") if game_obj.get("park_factor") is not None else game_obj.get("park_factor_runs")
    pf_hr = _pf100(pf_hr_raw)
    alt = _n(game_obj.get("altitude_m"))
    temp = _n(game_obj.get("temperature_2m"))
    tail = _n(game_obj.get("wind_tailwind"))
    wdir = _n(game_obj.get("wind_direction") if game_obj.get("wind_direction") is not None else game_obj.get("wind_direction_10m"))
    wspeed = _n(game_obj.get("wind_speed_10m"))
    has_weather = any(x is not None for x in (temp, tail, wspeed, wdir))
    env_parts = []
    if alt is not None:
        env_parts.append(f"{alt:.0f}m alt")
    if has_weather:
        if tail is not None:
            wind_txt = (f"favor +{tail:.1f}" if tail >= 0 else f"frente {tail:.1f}") + "km/h"
        elif wspeed is not None:
            wind_txt = f"{wspeed:.1f}km/h dir" + (f" {wdir:.0f}°" if wdir is not None else "")
        else:
            wind_txt = None
        if wind_txt:
            env_parts.append(f"viento {wind_txt}")
        elif wdir is not None:
            env_parts.append(f"{wdir:.0f}°")
        if temp is not None:
            env_parts.append(f"{temp:.0f}°C")
    env_line = ", ".join(env_parts) if env_parts else "sin datos climáticos"

    metrics = _build_metrics(game_obj, result, lead)
    away_runs_exp = _n(result.get("away_runs") if result.get("away_runs") is not None else result.get("away_mu"))
    home_runs_exp = _n(result.get("home_runs") if result.get("home_runs") is not None else result.get("home_mu"))
    total_runs_exp = _n(result.get("total_runs"))
    if total_runs_exp is None and away_runs_exp is not None and home_runs_exp is not None:
        total_runs_exp = round((away_runs_exp + home_runs_exp) * 10) / 10

    lectura_simple = _build_lectura_simple(pick_txt, odds, edge_ev, prob_tip, prob_imp, lead.get("pick_side"))
    analisis = _build_analisis_fallback(away_runs_exp, home_runs_exp, total_runs_exp, result.get("data_score"), edge_ev)

    game_date_only = _date_only(game_obj.get("game_date"))
    game_datetime_raw = game_obj.get("game_datetime_utc") or game_obj.get("forecast_time_utc")

    # Produccion (n8n) no tiene el concepto de "pipeline" -- esto es especifico de Auto-Picks v2
    # (2 pasadas por partido: abridores confirmados, luego lineup completo). El usuario pidio
    # explicitamente ver "(lineup pick)" en el encabezado para distinguir de que pasada viene.
    pipeline_tag = " (lineup pick)" if pipeline == 2 else " (abridores pick)"
    lines = [
        _LEAGUE_HEADER.get(league_label, f"⚾️ *{league_label}*") + pipeline_tag,
        f"⚾️ {away_team} @ {home_team} ({innings}inn{dh_label})",
        f"📅 {_game_time_label(game_datetime_raw, game_date_only)}",
        "",
        f"🎯 Mercado: {market}",
        f"🎰 Apuesta: {pick_txt}",
        f"💰 Cuota: {odds:.2f}" if odds is not None else "💰 Cuota: N/A",
        "📊 Prob. modelo: " + _pct(prob_model) + (
            f" → blend {_pct(prob_blended)}" if (prob_blended is not None and prob_model is not None and abs(prob_blended - prob_model) > 0.005) else ""
        ),
        f"📊 Prob. mercado: {_pct(prob_imp)}",
        f"💰 Cuota justa: {fair_tip:.2f}" if fair_tip is not None else "💰 Cuota justa: -",
        "📈 Edge EV (blend): " + _pct(edge_ev) + (
            f" · bruto {_pct(edge_model)}" if (edge_model is not None and edge_ev is not None and abs(edge_model - edge_ev) > 0.005) else ""
        ),
        f"📈 Ventaja prob.: {edge_prob * 100:.1f} pp" if edge_prob is not None else "📈 Ventaja prob.: -",
        f"🔢 Stake: {stake:.2f}/1.0",
        "",
        f"👥 Lanzadores: {away_pitcher} vs {home_pitcher}",
        "🏟 Campo: " + stadium + " (" + (f"pf {pf_runs}" + (f" · HR {pf_hr}" if pf_hr is not None else "") if pf_runs is not None else "pf neutral") + ")",
        f"🌡 Entorno: {env_line}",
        f"📊 Métricas clave: {metrics}",
        f"🧠 Lectura simple: {lectura_simple}",
        "",
        f"📉 Cuota mínima EV +18%: {min_odds_18:.2f}" if min_odds_18 is not None else "📉 Cuota mínima EV +18%: N/A",
        "",
    ]

    ds_display = f"{round(_n(result.get('data_score')) * 100)}%" if _n(result.get("data_score")) is not None else "N/A"
    lines.append(f"📊 {ds_display} ·")
    for c in candidates:
        c_odds = _to_odds_decimal(c.get("odds"))
        c_prob = _n(c.get("prob_estimated") if c.get("prob_estimated") is not None else (c.get("prob_blended") if c.get("prob_blended") is not None else c.get("prob_model")))
        c_push = _n(c.get("push_prob")) or 0
        c_ev = _n(c.get("edge"))
        if c_ev is None and c_prob is not None and c_odds is not None:
            c_ev = c_prob * c_odds + c_push - 1
        thr = _n(c.get("edge_threshold")) or 0.18
        icon = "✅" if (c_ev is not None and c_ev >= thr) else "-"
        c_odds_txt = f"{c_odds:.2f}" if c_odds is not None else "N/A"
        c_ev_txt = f"{c_ev * 100:.1f}" if c_ev is not None else "N/A"
        lines.append(f"{icon} {_pick_label(c, game_obj, away_team, home_team)} @{c_odds_txt} · EV {c_ev_txt}% (min {thr * 100:.0f}%)")
    lines.append("")
    lines.append(f"📋 {analisis}")
    lines.append(f"🧮 data_score: {_n(result.get('data_score')) or 0:.2f}")

    if lineup_incomplete:
        lines.append("")
        lines.append("⚠️ lineup_factor aún sin calcular en producción — este pick NO llevó ajuste por calidad real del lineup.")

    return "\n".join(lines)


def format_full_analysis(league_label: str, pipeline: int, away_team: str, home_team: str, result: dict, lineup_incomplete: bool = False) -> str:
    """Desglose completo de TODOS los mercados evaluados (no solo el mejor) -- para el chat
    privado del admin via @Cuotasodds_bot, en todo pipeline run, se haya publicado o no."""
    pipeline_label = "abridores" if pipeline == 1 else "lineup completo"
    data_score = result.get("data_score") or 0
    candidates = sorted(result.get("candidates") or [], key=lambda c: (c.get("edge") or -999), reverse=True)
    best_pick = result.get("best_pick")
    published_key = (best_pick.get("market"), best_pick.get("pick_side")) if best_pick else None

    lines = [
        f"🔍 Análisis completo ({league_label} · {pipeline_label})",
        f"{away_team} @ {home_team}",
        f"data_score: {data_score:.2f}",
        "",
    ]
    if not candidates:
        lines.append("Sin candidatos calculables (faltan cuotas de algún mercado).")
    for c in candidates:
        market = c.get("market")
        pick_side = c.get("pick_side")
        odds = c.get("odds")
        edge = c.get("edge") or 0
        threshold = c.get("edge_threshold") or 0.18
        prob_model = c.get("prob_model") or c.get("prob_estimated") or 0
        prob_implied = c.get("prob_implied") or 0
        prob_blended = c.get("prob_blended")
        confidence = c.get("confidence")
        mark = "✅" if edge >= threshold else "➖"
        key = (market, pick_side)
        published_mark = "  📣 PUBLICADO" if published_key == key else ""
        blended_txt = f"  |  Prob. blend: {prob_blended * 100:.1f}%" if prob_blended is not None else ""
        conf_txt = f"  |  Confianza: {confidence}" if confidence else ""
        # La linea (total de OU / handicap de HC) en la etiqueta del mercado -- el usuario la pidio
        # explicitamente: "UNDER — under" no dice el numero, "UNDER 8.5 — under" si. ML no lleva
        # linea. Se usa el total_line/hc_value del propio candidato (mismos nombres de mercado que
        # _pick_missing_line) y _js_num_str para no arrastrar el .0 (8.5 pero 8, no 8.0).
        _m_up = (market or "").upper()
        if _m_up in ("OU", "OVER", "UNDER") and c.get("total_line") is not None:
            market_lbl = f"{market} {_js_num_str(c.get('total_line'))}"
        elif _m_up in ("HC", "HC_AWAY", "HC_HOME") and c.get("hc_value") is not None:
            _hv = c.get("hc_value")
            market_lbl = f"{market} {'+' if _hv >= 0 else ''}{_js_num_str(_hv)}"
        else:
            market_lbl = market
        lines.append(f"{mark} {market_lbl} — {_side_label(c, away_team, home_team)}{published_mark}")
        lines.append(
            f"   Cuota: {_fmt_odds(odds)}  |  Prob. modelo: {prob_model * 100:.1f}%  |  "
            f"Prob. mercado: {prob_implied * 100:.1f}%{blended_txt}"
        )
        lines.append(f"   Edge: {edge * 100:.1f}% (umbral {threshold * 100:.0f}%){conf_txt}")

    if lineup_incomplete:
        lines.append("")
        lines.append("⚠️ lineup_factor aún sin calcular en producción — este análisis NO llevó ajuste por calidad real del lineup.")
    return "\n".join(lines)


def _pick_team_for(pick_side: Optional[str], away_team: str, home_team: str) -> Optional[str]:
    if not pick_side:
        return None
    upper = pick_side.upper()
    if upper.startswith("AWAY"):
        return away_team
    if upper.startswith("HOME"):
        return home_team
    return None


def build_candidates_history_rows(
    sport_id: int, game_pk: int, game_date, away_team: str, home_team: str, result: dict, published_key,
    odds_captured_at=None,
) -> tuple[str, list[dict]]:
    """Mapea los candidatos de un pipeline run al esquema real de *_candidates_history (Supabase),
    marcados con source='autopicks_v2' para distinguirlos de los de produccion (n8n). Solo se
    incluyen columnas que existen de verdad en cada tabla (CANDIDATES_HISTORY_COLUMNS) -- ver
    comentario en la constante, mismo bug que el prob_edge de mlb_picks_history a evitar."""
    table = CANDIDATES_HISTORY_TABLE[sport_id]
    allowed = CANDIDATES_HISTORY_COLUMNS[table]
    league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    # 2026-08-29: el motor vendorizado (quant_engine*.js) devuelve away_runs/home_runs, no
    # away_mu/home_mu -- esas claves nunca existieron, away_runs_predicted/home_runs_predicted
    # llevaban NULL desde la migracion a autopicks_v2 (jul-2026). Bug de telemetria (el edge/
    # prob_estimated se calculan bien dentro del motor con sus propias variables internas), pero
    # sin esto no se puede auditar el modelo de MiLB/LMB.
    away_mu = result.get("away_runs")
    home_mu = result.get("home_runs")
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    # 2026-07-25 (fix telemetria): el motor devuelve data_score a nivel de RESULTADO, no por
    # candidato -> antes se guardaba c.get("data_score")=None -> 0 en la tabla, ocultando la
    # calidad de datos real (se veian todos los candidatos MiLB con data_score=0). Usar el del
    # resultado como respaldo cuando el candidato no lo trae.
    result_ds = result.get("data_score")
    # FIX #2 (2026-09-02): momento en que se capturo la cuota usada (game_odds.updated_at). Sin
    # esto es imposible saber si un candidato se evaluo con una cuota rancia -- el problema que
    # el usuario detecto con el pick UNDER de Toledo (publicado a 2.05 cuando el mercado ya estaba
    # a 1.87). Con esta columna, los backtests futuros pueden filtrar por antiguedad de cuota.
    odds_ts_iso = odds_captured_at.isoformat() if hasattr(odds_captured_at, "isoformat") else odds_captured_at

    rows = []
    for c in result.get("candidates") or []:
        market = c.get("market")
        pick_side = c.get("pick_side")
        prob_model = c.get("prob_model") or c.get("prob_estimated")
        prob_implied = c.get("prob_implied")
        prob_blended = c.get("prob_blended")
        prob_final = prob_blended if prob_blended is not None else prob_model
        full_row = {
            "game_id": game_pk, "game_date": game_date, "market": market, "pick_side": pick_side,
            "pick_team": c.get("pick_team") or _pick_team_for(pick_side, away_team, home_team),
            "odds": c.get("odds"),
            "prob_estimated": prob_final, "prob_implied": prob_implied,
            "prob_edge": (prob_final - prob_implied) if (prob_final is not None and prob_implied is not None) else None,
            "edge": c.get("edge"), "edge_threshold": c.get("edge_threshold"),
            "data_score": c.get("data_score") if c.get("data_score") is not None else result_ds,
            "published": (market, pick_side) == published_key,
            "result": "PENDING",
            "total_line": c.get("total_line"), "hc_value": c.get("hc_value"),
            "diag_flags": [],
            "away_runs_predicted": away_mu, "home_runs_predicted": home_mu,
            "league": league_label, "created_at": now_iso,
            "matchup_label": f"{away_team} @ {home_team}",
            "prob_model": prob_model, "market_prob": prob_implied,
            "fair_odds": round(1 / prob_final, 2) if prob_final else None,
            "model_version": "autopicks_v2",
            "away_team": away_team, "home_team": home_team,
            "source": "autopicks_v2",
            "odds_captured_at": odds_ts_iso,
        }
        rows.append({k: v for k, v in full_row.items() if k in allowed})
    return table, rows


async def try_fire_pipeline(ctx: PipelineContext, sport_id: int, game_pk: int, pipeline: int, mode: Mode, away_team: str, home_team: str) -> None:
    async with ctx.pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM pipeline_runs WHERE sport_id=$1 AND game_pk=$2 AND pipeline=$3", sport_id, game_pk, pipeline
        )
    if existing:
        return

    odds = await get_odds(ctx.pool, sport_id, game_pk)
    if odds is None:
        return  # no deberia llamarse sin cuotas, pero por si acaso no hacemos nada

    adapter = ctx.adapters.get(sport_id)
    if adapter is None:
        logger.error("no hay adaptador para sport_id=%s", sport_id)
        return

    async with ctx.pool.acquire() as conn:
        gate_row = await conn.fetchrow(
            "SELECT away_pitcher_id, home_pitcher_id, game_datetime_utc, lineup_confirmed_at "
            "FROM games_gate_state WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk,
        )
    gate_away_pid = gate_row["away_pitcher_id"] if gate_row else None
    gate_home_pid = gate_row["home_pitcher_id"] if gate_row else None
    gate_dt = gate_row["game_datetime_utc"] if gate_row else None

    # FIX #3 (2026-09-02): la cuota debe ser POSTERIOR a la noticia que el modelo ya conoce.
    # Aplica a las 3 ligas (esta funcion es agnostica de liga; el detector recorre sport_id 1/11/23)
    # y a TODOS los caminos de disparo (Gate A/B del detector, cuotas manuales por Telegram,
    # autofetch periodico), porque todos pasan por aqui.
    #
    # Por que solo pipeline 2 (lineup) y no pipeline 1 (abridores): los dos timestamps NO son
    # igual de fiables como proxy de "cuando se entero el mercado".
    #   - lineup_confirmed_at: el detector sondea cada 180s dentro de la ventana de 6h, asi que
    #     cae a ~3 min de la publicacion real del lineup -> buen proxy, la comparacion es valida.
    #   - pitchers_confirmed_at: se sella con now() la PRIMERA vez que el detector ve el partido,
    #     y los abridores suelen anunciarse horas o dias antes de que el partido entre en la
    #     ventana de 6h -> ese timestamp es "cuando el partido entro en nuestro radar", NO cuando
    #     se entero el mercado. Compararlo daria falsos positivos constantes. Para pipeline 1 el
    #     que manda es el chequeo de edad absoluta de detector.py (ODDS_MAX_AGE_BEFORE_FIRE).
    #
    # Si la cuota es anterior al lineup, se compara un modelo que YA sabe el lineup contra un
    # precio que todavia no lo sabia: el edge resultante es la diferencia entre dos momentos
    # informativos, no valor real, y se evapora en cuanto el mercado reacciona (caso Toledo
    # 2026-09-02, ver CLAUDE.md "CUOTA RANCIA"). NO se reclama la fila de pipeline_runs -> el
    # proximo tick reintenta cuando haya cuota fresca, igual que hace el camino de game_obj None.
    if pipeline == 2 and gate_row is not None:
        lineup_at = gate_row["lineup_confirmed_at"]
        odds_at = odds["updated_at"] if "updated_at" in odds else None
        if lineup_at is not None and odds_at is not None and odds_at < lineup_at:
            logger.warning(
                "pipeline 2 NO disparado para sport_id=%s game_pk=%s: la cuota es de %s, anterior "
                "al lineup confirmado a las %s -- precio pre-noticia, se reintentara con cuota fresca",
                sport_id, game_pk, odds_at, lineup_at,
            )
            # Avisar al admin UNA vez por partido: si esto pasa, es que el re-scrape de Gate B
            # agoto sus reintentos (5 + rotacion Tor + respaldo oddspapi en MiLB/LMB). No dejarlo
            # solo en el log -- la leccion recurrente del proyecto es que los fallos silenciosos
            # cuestan semanas de diagnostico.
            _k = (sport_id, game_pk)
            if _k not in _stale_odds_notice_keys:
                _stale_odds_notice_keys.add(_k)
                try:
                    await ctx.telegram.send_message(
                        ctx.admin_chat_id,
                        f"⏳ {LEAGUE_LABEL.get(sport_id, sport_id)} {away_team} @ {home_team}: pick de "
                        f"lineup NO publicado -- la única cuota disponible es anterior al lineup "
                        f"confirmado (precio pre-noticia, edge irreal). Reintentando con cuota fresca.",
                    )
                except Exception:
                    logger.exception("fallo avisando de cuota pre-lineup game_pk=%s", game_pk)
            return

    # gate_dt (hora real del primer lanzamiento, de games_gate_state) -> el clima fresco se coge de
    # la hora del partido de verdad, no de la aproximacion fija de las 20:00 UTC. 2026-08-04.
    game_obj = await adapter.build_game_object(game_pk, mode, gate_away_pid, gate_home_pid, gate_dt)
    if game_obj is None:
        # Datos incompletos (p.ej. ERA de abridores aun sin poblar) -- NO se reclama la fila,
        # asi que se puede reintentar en un proximo tick del detector sin violar idempotencia.
        await ctx.telegram.send_message(
            ctx.admin_chat_id,
            f"⚠️ {LEAGUE_LABEL.get(sport_id, sport_id)} game_pk={game_pk}: datos insuficientes para calcular ({mode}), reintentando en próximos ticks.",
        )
        return

    # La hora del partido NO viene en las vistas de matchup (game_date es solo DATE) -> el mensaje
    # salia "hora N/A ES / hora N/A ET". Se toma de games_gate_state, donde el detector guardo la
    # hora real (game_datetime_utc, con la que dispara el gate). Aplica a MLB/MiLB/LMB y ambos
    # pipelines. 2026-07-31.
    if gate_row and gate_row.get("game_datetime_utc") and not game_obj.get("game_datetime_utc"):
        # ISO string, NO el datetime crudo de asyncpg: game_obj se serializa entero con json.dumps
        # dentro de build_quant_payload -> run_quant, y un datetime revienta json.dumps con TypeError
        # (fallo silencioso que dejaba la fila pipeline_runs claimed pero sin quant_result ni error,
        # 0 picks del 30-jul al 02-ago). _dt_parts hace str()+fromisoformat, asi que el ISO va bien.
        game_obj["game_datetime_utc"] = gate_row["game_datetime_utc"].isoformat()

    # Punto de reclamo atomico -- a partir de aqui, cualquier llamada concurrente para el
    # mismo (sport_id, game_pk, pipeline) recibira claim=None y no hara nada.
    async with ctx.pool.acquire() as conn:
        claim = await conn.fetchrow(
            "INSERT INTO pipeline_runs (sport_id, game_pk, pipeline) VALUES ($1,$2,$3) "
            "ON CONFLICT (sport_id, game_pk, pipeline) DO NOTHING RETURNING id",
            sport_id, game_pk, pipeline,
        )
    if claim is None:
        return
    run_id = claim["id"]

    payload = build_quant_payload(game_obj, odds)
    try:
        result = await run_quant(ctx.node_bin, ctx.vendor_dir, LEAGUE_KEY[sport_id], payload)
    except NodeBridgeError as e:
        logger.exception("run_quant fallo para game_pk=%s pipeline=%s", game_pk, pipeline)
        async with ctx.pool.acquire() as conn:
            await conn.execute("UPDATE pipeline_runs SET error=$1 WHERE id=$2", str(e), run_id)
        await ctx.telegram.send_message(ctx.admin_chat_id, f"❌ Error calculando game_pk={game_pk}: {str(e)[:200]}")
        return

    async with ctx.pool.acquire() as conn:
        for cand in result.get("candidates", []):
            edge = cand.get("edge") or 0
            threshold = cand.get("edge_threshold") or 0.18
            await conn.execute(
                "INSERT INTO candidates_log (pipeline_run_id, market, pick_side, pick_team, odds, "
                "prob_estimated, prob_implied, edge, edge_threshold, confidence, publicable) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                run_id, cand.get("market"), cand.get("pick_side"), cand.get("pick_team") or cand.get("away_team"),
                cand.get("odds"), cand.get("prob_model") or cand.get("prob_estimated"), cand.get("prob_implied"),
                edge, threshold, cand.get("confidence"), edge >= threshold,
            )

    best_pick = result.get("best_pick")
    data_score = result.get("data_score") or 0
    published = bool(best_pick)
    published_key = (best_pick.get("market"), best_pick.get("pick_side")) if best_pick else None
    telegram_message_id = None

    league_label = LEAGUE_LABEL.get(sport_id, str(sport_id))
    lineup_incomplete = _lineup_incomplete(sport_id, pipeline, game_obj)

    # Guard 2026-07-25: no publicar un OU sin linea de totales ni un HC sin handicap -- la cuota es
    # impublicable sin el numero (bug real: se publico "Under N/A" en un DH de 7 entradas cuando las
    # cuotas trajeron el precio over/under pero no la linea). El candidato SI se guarda igualmente
    # (para calibracion); solo se suprime la publicacion.
    if best_pick:
        _pc = next((c for c in (result.get("candidates") or [])
                    if (c.get("market"), c.get("pick_side")) == published_key), best_pick)
        _m = (_pc.get("market") or "").upper()
        if _pick_missing_line(_pc):
            logger.warning("pick NO publicado por falta de linea: game_pk=%s market=%s", game_pk, _m)
            try:
                await ctx.telegram.send_message(
                    ctx.admin_chat_id,
                    f"⚠️ {league_label} {away_team} @ {home_team}: pick {_m} NO publicado -- las cuotas "
                    f"llegaron sin la línea (total/hándicap). No se puede apostar sin el número.",
                )
            except Exception:
                logger.exception("fallo avisando del pick sin linea")
            best_pick = None
            published = False
            published_key = None

    # Guard 2026-09-04: no publicar en partidos que no sean de 9 entradas (dobles jornadas de 7).
    # Caso real que lo destapo: Rochester @ Syracuse DH G1 (7 entradas) con la casa cotizando total
    # 11.5 -- una linea de 9. El motor proyecta BIEN las 7 entradas (3.89+3.85=7.74 carreras), pero
    # restar eso contra una linea de 9 fabrica un edge del 23.3% que no existe: cada lado de la
    # resta mide una cosa distinta. cuotasahora sirve una unica pagina por enfrentamiento, asi que
    # no hay forma de saber a cual de los dos partidos del DH pertenece el precio -- de hecho el
    # mismo juego de cuotas se habia guardado dos dias antes para el OTRO partido de esa doble.
    # Verificado en el historico (carreras reales menos linea / acierto del UNDER):
    #     9 entradas: +0.13, UNDER 50.1% (n=337) -- mercado eficiente
    #     7 entradas: -1.96, UNDER 75.0% (n=24)  -- las dos entradas que faltan
    # Y 3 de los 5 picks publicados sobre partidos de 7 entradas que llegaron a resolverse acabaron
    # VOID: la casa no los liquido como nuestro evento. Mismo criterio conservador que la guarda de
    # arriba -- el candidato SI se guarda (calibracion), solo se suprime la publicacion.
    if best_pick:
        _inn = _innings_no_estandar(game_obj)
        if _inn is not None:
            logger.warning(
                "pick NO publicado: partido de %s entradas, la linea del mercado es de 9 (game_pk=%s)",
                _inn, game_pk,
            )
            try:
                await ctx.telegram.send_message(
                    ctx.admin_chat_id,
                    f"⚠️ {league_label} {away_team} @ {home_team}: pick NO publicado -- el partido es "
                    f"de {_inn} entradas y la cuota que sirve la casa es de 9. No se puede comparar "
                    f"la proyección con esa línea.",
                )
            except Exception:
                logger.exception("fallo avisando del pick de entradas no estandar")
            best_pick = None
            published = False
            published_key = None

    # Candidatos evaluados -> mismo pool de calibracion que produccion (*_candidates_history en
    # Supabase, source='autopicks_v2'). No critico: si falla, no bloquea el envio de mensajes.
    try:
        table, rows = build_candidates_history_rows(
            sport_id, game_pk, game_obj.get("game_date"), away_team, home_team, result, published_key,
            odds_captured_at=odds["updated_at"] if "updated_at" in odds else None,
        )
        await ctx.supabase.insert(ctx.http_client, table, rows)
    except Exception:
        logger.exception("fallo guardando candidates_history en Supabase para game_pk=%s pipeline=%s", game_pk, pipeline)

    # El admin (@Cuotasodds_bot) recibe SIEMPRE el analisis completo (todos los mercados
    # evaluados, no solo el mejor), se haya publicado o no en el canal de produccion.
    full_text = format_full_analysis(league_label, pipeline, away_team, home_team, result, lineup_incomplete)
    await ctx.telegram.send_message(ctx.admin_chat_id, full_text)

    # Aviso destacado de banda de edge MLB (ver constantes EDGE_ALERT_* arriba). Solo informativo,
    # solo al admin -- nunca bloquea ni altera la publicacion normal.
    if sport_id == EDGE_ALERT_SPORT_ID:
        try:
            avisos = []
            for c in result.get("candidates") or []:
                m = (c.get("market") or "").upper()
                e = c.get("edge") or 0
                thr = c.get("edge_threshold") or 0.18
                if m in EDGE_ALERT_MARKETS and EDGE_ALERT_MIN <= e < thr:
                    k = (game_pk, m, (c.get("pick_side") or "").upper())
                    if k in _edge_alert_keys:
                        continue
                    _edge_alert_keys.add(k)
                    linea = c.get("total_line") if m == "OU" else c.get("hc_value")
                    avisos.append(
                        f"  {m} {_side_label(c, away_team, home_team)}" + (f" {linea}" if linea is not None else "")
                        + f" @ {c.get('odds')}  ·  edge {e * 100:.1f}%"
                    )
            if avisos:
                pipeline_label = "abridores" if pipeline == 1 else "lineup completo"
                await ctx.telegram.send_message(
                    ctx.admin_chat_id,
                    f"🔔 AVISO edge MLB — banda 8-18% (no se publica)\n"
                    f"{away_team} @ {home_team} · {pipeline_label}\n" + "\n".join(avisos),
                )
        except Exception:
            logger.exception("fallo el aviso de banda de edge MLB para game_pk=%s", game_pk)

    if published:
        text = format_pick_message(league_label, pipeline, away_team, home_team, game_obj, result, lineup_incomplete)
        await ctx.picks_telegram.send_message(ctx.picks_channel_id, text)

        # Fix A (2026-07-25): ademas de publicar en el canal, PERSISTIR el pick en *_picks_history
        # para que aparezca en el dashboard y lo resuelva LYNX_RESOLVE_PICKS. Antes Auto-Picks v2
        # solo escribia el candidato (published=true) pero nunca el pick -> ~29% de picks publicados
        # quedaban huerfanos. Idempotente: no reinserta si ya existe ese (game, market, side).
        try:
            pub_cand = next(
                (c for c in (result.get("candidates") or [])
                 if (c.get("market"), c.get("pick_side")) == published_key),
                best_pick,
            )
            picks_table, pick_row = build_picks_history_row(
                sport_id, game_pk, game_obj.get("game_date"), away_team, home_team, result, pub_cand, pipeline,
            )
            id_col = "game_pk" if picks_table == "mlb_picks_history" else "game_id"
            side_col = "side" if picks_table == "picks_history" else "pick_side"
            existing = await ctx.supabase.select(
                ctx.http_client, picks_table,
                {id_col: f"eq.{pick_row[id_col]}", "market": f"eq.{pick_row['market']}",
                 side_col: f"eq.{pick_row[side_col]}", "select": "id", "limit": "1"},
            )
            if existing:
                logger.info("pick ya presente en %s (game=%s %s %s), no se duplica",
                            picks_table, pick_row[id_col], pick_row["market"], pick_row[side_col])
            else:
                await ctx.supabase.insert(ctx.http_client, picks_table, [pick_row])
        except Exception as e:
            # Fix B: NO tragar el fallo en silencio -- un pick publicado que no se guarda no aparece
            # en el dashboard ni se resuelve. Log + aviso explicito al admin.
            logger.exception("FALLO guardando el pick publicado en *_picks_history game_pk=%s pipeline=%s", game_pk, pipeline)
            try:
                await ctx.telegram.send_message(
                    ctx.admin_chat_id,
                    f"❌ Pick PUBLICADO no guardado en tabla de picks (game_pk={game_pk}, "
                    f"{league_label} p{pipeline}): {str(e)[:180]} -- no aparecera en dashboard ni se resolvera.",
                )
            except Exception:
                logger.exception("ademas fallo el aviso al admin del pick no guardado")

    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "UPDATE pipeline_runs SET quant_result=$1, data_score=$2, best_pick=$3, published=$4, "
            "published_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$5",
            json.dumps(result), data_score, json.dumps(best_pick) if best_pick else None, published, run_id,
        )

    logger.info(
        "pipeline %s disparado: sport_id=%s game_pk=%s published=%s data_score=%.2f",
        pipeline, sport_id, game_pk, published, data_score,
    )
