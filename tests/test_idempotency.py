"""Prueba la garantia real de idempotencia: el INSERT...ON CONFLICT DO NOTHING de
pipeline_runs, ejercitado contra un Postgres real (no un mock) porque lo que se valida es la
restriccion UNIQUE de la base de datos, no logica de la aplicacion."""
import asyncio

import pytest

from tests.conftest import requires_db


async def _claim(pool, sport_id, game_pk, pipeline):
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "INSERT INTO pipeline_runs (sport_id, game_pk, pipeline) VALUES ($1,$2,$3) "
            "ON CONFLICT (sport_id, game_pk, pipeline) DO NOTHING RETURNING id",
            sport_id, game_pk, pipeline,
        )


@requires_db
@pytest.mark.asyncio
async def test_second_claim_is_noop(pool):
    first = await _claim(pool, sport_id=1, game_pk=999, pipeline=1)
    second = await _claim(pool, sport_id=1, game_pk=999, pipeline=1)
    assert first is not None
    assert second is None
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT count(*) FROM pipeline_runs WHERE sport_id=1 AND game_pk=999 AND pipeline=1"
        )
    assert count == 1


@requires_db
@pytest.mark.asyncio
async def test_concurrent_claims_only_one_wins(pool):
    """Simula el detector y el manejador de Telegram intentando reclamar el mismo
    (sport_id, game_pk, pipeline) casi a la vez -- exactamente el escenario de la carrera
    que describe el criterio de aceptacion 'lineup+cuotas en cualquier orden -> un solo pick'."""
    results = await asyncio.gather(*[_claim(pool, sport_id=1, game_pk=555, pipeline=2) for _ in range(10)])
    winners = [r for r in results if r is not None]
    assert len(winners) == 1
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT count(*) FROM pipeline_runs WHERE sport_id=1 AND game_pk=555 AND pipeline=2"
        )
    assert count == 1


@requires_db
@pytest.mark.asyncio
async def test_different_pipelines_can_both_claim(pool):
    """Pipeline 1 y 2 son independientes -- ambos deben poder dispararse para el mismo
    partido (criterio: pitchers-only dispara solo pipeline 1, pero si luego se confirma el
    lineup tambien, pipeline 2 debe poder dispararse por separado)."""
    r1 = await _claim(pool, sport_id=1, game_pk=777, pipeline=1)
    r2 = await _claim(pool, sport_id=1, game_pk=777, pipeline=2)
    assert r1 is not None
    assert r2 is not None


@requires_db
@pytest.mark.asyncio
async def test_restart_simulation_zero_duplicates(pool):
    """Simula un reinicio del proceso a mitad del tick: el primer intento reclama pero el
    proceso 'muere' antes de completar el resto del trabajo; al reiniciar, el segundo intento
    para el MISMO partido/pipeline no debe crear una segunda fila."""
    first = await _claim(pool, sport_id=11, game_pk=42, pipeline=1)
    assert first is not None
    # "reinicio" simulado: se reintenta exactamente la misma reclamacion
    second = await _claim(pool, sport_id=11, game_pk=42, pipeline=1)
    assert second is None
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT count(*) FROM pipeline_runs WHERE sport_id=11 AND game_pk=42")
    assert count == 1
