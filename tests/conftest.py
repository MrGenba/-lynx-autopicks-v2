"""Fixture de Postgres real para los tests que dependen de la base de datos (aliases,
idempotencia). Requiere DATABASE_URL_TEST apuntando a un Postgres vacio/desechable -- si no
esta definida, esos tests se saltan (no se mockea la base de datos: la garantia que se prueba
es la propia restriccion UNIQUE de Postgres, no logica de aplicacion)."""
import os

import asyncpg
import pytest
import pytest_asyncio

from app import db

DATABASE_URL_TEST = os.environ.get("DATABASE_URL_TEST")

requires_db = pytest.mark.skipif(
    not DATABASE_URL_TEST, reason="DATABASE_URL_TEST no definida -- test de integracion con Postgres real, ver README de tests/"
)


@pytest_asyncio.fixture
async def pool():
    if not DATABASE_URL_TEST:
        pytest.skip("DATABASE_URL_TEST no definida")
    p = await asyncpg.create_pool(DATABASE_URL_TEST, min_size=1, max_size=5)
    await db.run_migrations(p)
    # Limpiar todas las tablas antes de cada test para que no haya estado compartido entre tests.
    async with p.acquire() as conn:
        await conn.execute(
            "TRUNCATE team_aliases, games_gate_state, game_odds, pipeline_runs, candidates_log, "
            "telegram_pending_clarification, telegram_state RESTART IDENTITY CASCADE"
        )
    yield p
    await p.close()
