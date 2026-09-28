import datetime as dt

import pytest

from app.detector import fill_pitcher_ids_from_lineup, mark_lineup_confirmed, upsert_game
from app.mlb_stats_client import ScheduledGame
from tests.conftest import requires_db


GAME_DATE = dt.datetime(2026, 9, 28, 23, 30, tzinfo=dt.timezone.utc)


def scheduled_game(away_pitcher_id, home_pitcher_id):
    return ScheduledGame(
        game_pk=900001,
        status="Scheduled",
        game_datetime_utc=GAME_DATE.isoformat(),
        away_team_id=1,
        home_team_id=2,
        away_team_name="Away",
        home_team_name="Home",
        away_pitcher_id=away_pitcher_id,
        home_pitcher_id=home_pitcher_id,
    )


@requires_db
@pytest.mark.asyncio
async def test_mlb_abridor_probable_cambia_y_lineup_fija_el_real(pool):
    await upsert_game(pool, 1, scheduled_game(101, 201), GAME_DATE)
    await upsert_game(pool, 1, scheduled_game(102, 201), GAME_DATE)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT away_pitcher_id FROM games_gate_state WHERE sport_id=1 AND game_pk=900001"
        )
    assert row["away_pitcher_id"] == 102

    await mark_lineup_confirmed(pool, 1, 900001)
    await fill_pitcher_ids_from_lineup(pool, 1, 900001, 103, 201)
    await upsert_game(pool, 1, scheduled_game(102, 201), GAME_DATE)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT away_pitcher_id, home_pitcher_id FROM games_gate_state "
            "WHERE sport_id=1 AND game_pk=900001"
        )
    assert (row["away_pitcher_id"], row["home_pitcher_id"]) == (103, 201)


@requires_db
@pytest.mark.asyncio
async def test_milb_lineup_no_pisa_abridor_probable_existente(pool):
    await upsert_game(pool, 11, scheduled_game(101, None), GAME_DATE)
    await fill_pitcher_ids_from_lineup(pool, 11, 900001, 103, 201)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT away_pitcher_id, home_pitcher_id FROM games_gate_state "
            "WHERE sport_id=11 AND game_pk=900001"
        )
    assert (row["away_pitcher_id"], row["home_pitcher_id"]) == (101, 201)
