"""Procesa cada mensaje entrante de Telegram: primero comprueba si hay una desambiguacion
pendiente para este chat (independiente del estado del detector, ver migracion 0001), luego
comandos /status /pending /picks, y si no, intenta parsear un mensaje de cuotas.
"""
import datetime as dt
import json
import logging
import re

import asyncpg

from app import aliases
from app import commands as cmds
from app.overround import check_overround
from app.parser import ParsedOdds, parse_odds_message
from app.pipelines import PipelineContext, try_fire_pipeline

logger = logging.getLogger(__name__)

CLARIFICATION_TTL = dt.timedelta(minutes=10)
RE_BARE_NUMBER = re.compile(r"^\s*(\d+)\s*$")


def _validated_market_odds(parsed: ParsedOdds) -> tuple[dict, list[str]]:
    """Aplica overround por mercado -- si un mercado falla, se anula SOLO ese mercado
    (nunca llega a game_odds ni se calcula con el), el resto sigue su curso."""
    warnings = list(parsed.warnings)
    values = {
        "away_ml": None, "home_ml": None,
        "away_hc_val": None, "away_hc_odds": None, "home_hc_val": None, "home_hc_odds": None,
        "total_line": None, "over_odds": None, "under_odds": None,
    }

    if parsed.team1_ml is not None and parsed.team2_ml is not None:
        chk = check_overround(parsed.team1_ml, parsed.team2_ml)
        if chk.ok:
            values["away_ml"], values["home_ml"] = parsed.team1_ml, parsed.team2_ml
        else:
            warnings.append(f"ML descartado: {chk.reason}")

    if parsed.team1_hc_odds is not None and parsed.team2_hc_odds is not None:
        chk = check_overround(parsed.team1_hc_odds, parsed.team2_hc_odds)
        if chk.ok:
            values["away_hc_val"], values["away_hc_odds"] = parsed.team1_hc_val, parsed.team1_hc_odds
            values["home_hc_val"], values["home_hc_odds"] = parsed.team2_hc_val, parsed.team2_hc_odds
        else:
            warnings.append(f"Hándicap descartado: {chk.reason}")

    if parsed.over_odds is not None and parsed.under_odds is not None:
        chk = check_overround(parsed.over_odds, parsed.under_odds)
        if chk.ok:
            values["total_line"], values["over_odds"], values["under_odds"] = (
                parsed.total_line, parsed.over_odds, parsed.under_odds,
            )
        else:
            warnings.append(f"Totales descartados: {chk.reason}")

    return values, warnings


def _swap_if_needed(values: dict, swapped: bool) -> dict:
    if not swapped:
        return values
    return {
        "away_ml": values["home_ml"], "home_ml": values["away_ml"],
        "away_hc_val": values["home_hc_val"], "away_hc_odds": values["home_hc_odds"],
        "home_hc_val": values["away_hc_val"], "home_hc_odds": values["away_hc_odds"],
        "total_line": values["total_line"], "over_odds": values["over_odds"], "under_odds": values["under_odds"],
    }


async def _store_odds(pool: asyncpg.Pool, sport_id: int, game_pk: int, values: dict, chat_id: int, message_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO game_odds (sport_id, game_pk, away_ml, home_ml, away_hc_val, away_hc_odds,
              home_hc_val, home_hc_odds, total_line, over_odds, under_odds, submitted_by_chat_id,
              telegram_message_id, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
            ON CONFLICT (sport_id, game_pk) DO UPDATE SET
              away_ml = COALESCE(EXCLUDED.away_ml, game_odds.away_ml),
              home_ml = COALESCE(EXCLUDED.home_ml, game_odds.home_ml),
              away_hc_val = COALESCE(EXCLUDED.away_hc_val, game_odds.away_hc_val),
              away_hc_odds = COALESCE(EXCLUDED.away_hc_odds, game_odds.away_hc_odds),
              home_hc_val = COALESCE(EXCLUDED.home_hc_val, game_odds.home_hc_val),
              home_hc_odds = COALESCE(EXCLUDED.home_hc_odds, game_odds.home_hc_odds),
              total_line = COALESCE(EXCLUDED.total_line, game_odds.total_line),
              over_odds = COALESCE(EXCLUDED.over_odds, game_odds.over_odds),
              under_odds = COALESCE(EXCLUDED.under_odds, game_odds.under_odds),
              updated_at = now()
            """,
            sport_id, game_pk, values["away_ml"], values["home_ml"], values["away_hc_val"], values["away_hc_odds"],
            values["home_hc_val"], values["home_hc_odds"], values["total_line"], values["over_odds"], values["under_odds"],
            chat_id, message_id,
        )


async def _check_gates_and_fire(ctx: PipelineContext, sport_id: int, game_pk: int, away: str, home: str) -> None:
    async with ctx.pool.acquire() as conn:
        gate = await conn.fetchrow(
            "SELECT pitchers_confirmed_at, lineup_confirmed_at FROM games_gate_state WHERE sport_id=$1 AND game_pk=$2",
            sport_id, game_pk,
        )
    if gate is None:
        return
    if gate["pitchers_confirmed_at"] is not None:
        await try_fire_pipeline(ctx, sport_id, game_pk, 1, "pitchers_only", away, home)
    if gate["lineup_confirmed_at"] is not None:
        await try_fire_pipeline(ctx, sport_id, game_pk, 2, "full_lineup", away, home)


async def _get_today_candidates(pool: asyncpg.Pool) -> list[aliases.CandidateGame]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT sport_id, game_pk, away_team_id, home_team_id, away_team_name, home_team_name "
            "FROM games_gate_state WHERE game_datetime_utc::date = current_date"
        )
    return [
        aliases.CandidateGame(
            sport_id=r["sport_id"], game_pk=r["game_pk"], away_team_id=r["away_team_id"], home_team_id=r["home_team_id"],
            away_team_name=r["away_team_name"], home_team_name=r["home_team_name"], game_datetime_utc=None,
        )
        for r in rows
    ]


async def _ask_disambiguation(ctx: PipelineContext, chat_id: int, text: str, values: dict, candidates: list[aliases.CandidateGame]) -> None:
    lines = ["No estoy seguro de a qué partido te refieres, ¿cuál es?"]
    payload_candidates = []
    for i, c in enumerate(candidates[:5], start=1):
        lines.append(f"{i}. {c.away_team_name} @ {c.home_team_name}")
        payload_candidates.append({"sport_id": c.sport_id, "game_pk": c.game_pk, "away": c.away_team_name, "home": c.home_team_name})
    async with ctx.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO telegram_pending_clarification (chat_id, raw_message_text, parsed_odds, candidate_games, expires_at) "
            "VALUES ($1,$2,$3,$4,$5) "
            "ON CONFLICT (chat_id) DO UPDATE SET raw_message_text=EXCLUDED.raw_message_text, "
            "parsed_odds=EXCLUDED.parsed_odds, candidate_games=EXCLUDED.candidate_games, "
            "created_at=now(), expires_at=EXCLUDED.expires_at",
            chat_id, text, json.dumps(values), json.dumps(payload_candidates),
            dt.datetime.now(dt.timezone.utc) + CLARIFICATION_TTL,
        )
    await ctx.telegram.send_message(chat_id, "\n".join(lines))


async def _handle_clarification_reply(ctx: PipelineContext, chat_id: int, text: str) -> bool:
    """Devuelve True si el mensaje se consumio como respuesta a una desambiguacion pendiente."""
    m = RE_BARE_NUMBER.match(text)
    async with ctx.pool.acquire() as conn:
        pending = await conn.fetchrow(
            "SELECT * FROM telegram_pending_clarification WHERE chat_id=$1 AND expires_at > now()", chat_id
        )
    if pending is None:
        return False
    if not m:
        return False  # no es una respuesta numerica -- se procesa como mensaje normal

    idx = int(m.group(1)) - 1
    candidates = json.loads(pending["candidate_games"])
    if idx < 0 or idx >= len(candidates):
        await ctx.telegram.send_message(chat_id, f"Número fuera de rango, elige entre 1 y {len(candidates)}.")
        return True

    chosen = candidates[idx]
    values = json.loads(pending["parsed_odds"])
    sport_id, game_pk = chosen["sport_id"], chosen["game_pk"]

    async with ctx.pool.acquire() as conn:
        await conn.execute("DELETE FROM telegram_pending_clarification WHERE chat_id=$1", chat_id)

    # No sabemos si el usuario escribio team1=away o team1=home -- ya se resolvio implicitamente
    # al elegir el partido: comparamos que lado del texto original coincide mejor.
    raw_text = pending["raw_message_text"]
    header_match = re.search(r"^\s*(.+?)\s+(?:vs\.?|@)\s+(.+?)\s*$", raw_text, re.IGNORECASE | re.MULTILINE)
    team1_raw = header_match.group(1).strip() if header_match else chosen["away"]
    swapped = aliases.score(team1_raw, chosen["home"]) > aliases.score(team1_raw, chosen["away"])
    final_values = _swap_if_needed(values, swapped)

    await _store_odds(ctx.pool, sport_id, game_pk, final_values, chat_id, 0)
    await aliases.learn_alias(ctx.pool, sport_id, team1_raw, chosen["home_team_id"] if swapped else chosen["away_team_id"], chosen["home"] if swapped else chosen["away"])

    await ctx.telegram.send_message(chat_id, f"✅ Cuotas asignadas a {chosen['away']} @ {chosen['home']}.")
    await _check_gates_and_fire(ctx, sport_id, game_pk, chosen["away"], chosen["home"])
    return True


async def handle_message(ctx: PipelineContext, chat_id: int, text: str, message_id: int) -> None:
    # Bot de uso privado -- se ignora cualquier mensaje que no venga del chat del admin. Sin
    # respuesta ni error visible para quien no sea el admin (no revela que el bot "existe" o
    # reacciona a nada).
    if chat_id != ctx.admin_chat_id:
        logger.warning("mensaje ignorado de chat_id no autorizado: %s", chat_id)
        return

    if await _handle_clarification_reply(ctx, chat_id, text):
        return

    stripped = text.strip()
    if stripped.startswith("/status"):
        await cmds.cmd_status(ctx)
        return
    if stripped.startswith("/pending"):
        await cmds.cmd_pending(ctx)
        return
    if stripped.startswith("/picks"):
        await cmds.cmd_picks(ctx)
        return
    if stripped.startswith("/tick"):
        await cmds.cmd_tick(ctx)
        return
    if stripped.startswith("/clock"):
        await cmds.cmd_clock(ctx)
        return

    parsed = parse_odds_message(text)
    if parsed is None:
        return  # no reconocido como mensaje de cuotas -- se ignora silenciosamente

    values, warnings = _validated_market_odds(parsed)
    if warnings:
        await ctx.telegram.send_message(chat_id, "⚠️ Cuotas sospechosas:\n" + "\n".join(warnings))
    if all(v is None for v in values.values()):
        return  # todos los mercados fallaron validacion, nada que guardar

    candidates = await _get_today_candidates(ctx.pool)
    team1_id = team2_id = None
    resolved_sport_id = None
    for sport_id in (1, 11, 23):
        t1 = await aliases.resolve_team_id(ctx.pool, sport_id, parsed.team1_raw)
        t2 = await aliases.resolve_team_id(ctx.pool, sport_id, parsed.team2_raw)
        if t1 is not None and t2 is not None:
            resolved_sport_id, team1_id, team2_id = sport_id, t1, t2
            break

    pool_candidates = [c for c in candidates if resolved_sport_id is None or c.sport_id == resolved_sport_id]
    match = aliases.match_game(parsed.team1_raw, parsed.team2_raw, pool_candidates, team1_id, team2_id)

    if match.ambiguous or match.game is None:
        if not match.candidates:
            await ctx.telegram.send_message(chat_id, f"No encontré ningún partido para \"{parsed.team1_raw} vs {parsed.team2_raw}\" hoy.")
            return
        await _ask_disambiguation(ctx, chat_id, text, values, match.candidates)
        return

    game = match.game
    final_values = _swap_if_needed(values, match.swapped)
    await _store_odds(ctx.pool, game.sport_id, game.game_pk, final_values, chat_id, message_id)

    learn_team1 = game.home_team_id if match.swapped else game.away_team_id
    learn_team1_name = game.home_team_name if match.swapped else game.away_team_name
    learn_team2 = game.away_team_id if match.swapped else game.home_team_id
    learn_team2_name = game.away_team_name if match.swapped else game.home_team_name
    if learn_team1 is not None:
        await aliases.learn_alias(ctx.pool, game.sport_id, parsed.team1_raw, learn_team1, learn_team1_name)
    if learn_team2 is not None:
        await aliases.learn_alias(ctx.pool, game.sport_id, parsed.team2_raw, learn_team2, learn_team2_name)

    await ctx.telegram.send_message(chat_id, f"✅ Cuotas guardadas: {game.away_team_name} @ {game.home_team_name}.")
    await _check_gates_and_fire(ctx, game.sport_id, game.game_pk, game.away_team_name, game.home_team_name)
