import pytest

from app.aliases import CandidateGame, learn_alias, match_game, norm, resolve_team_id, score
from tests.conftest import requires_db


def test_norm_strips_punctuation_and_case():
    assert norm("DET Tigers!") == "det tigers"
    assert norm("  Tigers,  Detroit  ") == "tigers detroit"


def test_score_exact_match():
    assert score("DET Tigers", "det tigers") == 3


def test_score_prefix_match():
    # "Detroit Tigers" empieza literalmente por "Detroit" -> prefijo, score=2
    assert score("Detroit", "Detroit Tigers") == 2
    # "Tigers" no es prefijo de "Detroit Tigers" (no empieza por ahi) -> cae a solapamiento
    # de palabras: "tigers" aparece como substring en "detroit tigers" -> score=1
    assert score("Tigers", "Detroit Tigers") == 1


def test_score_word_overlap():
    # "Detroit" no aparece en "Tigers", pero comparten cierta señal parcial
    assert score("Detroit", "Tigers") == 0
    # mismo orden -> match exacto tras normalizar
    assert score("Detroit Tigers", "Detroit Tigers") == 3
    # orden distinto -> ya no es exacto, pero cuenta las 2 palabras por solapamiento
    assert score("Tigers Detroit", "Detroit Tigers") == 2


CANDIDATES = [
    CandidateGame(sport_id=1, game_pk=1, away_team_id=100, home_team_id=200,
                  away_team_name="Detroit Tigers", home_team_name="Texas Rangers", game_datetime_utc=None),
    CandidateGame(sport_id=1, game_pk=2, away_team_id=300, home_team_id=400,
                  away_team_name="Boston Red Sox", home_team_name="New York Yankees", game_datetime_utc=None),
]


def test_match_game_direct_orientation():
    r = match_game("DET Tigers", "TEX Rangers", CANDIDATES)
    assert r.ambiguous is False
    assert r.game.game_pk == 1
    assert r.swapped is False


def test_match_game_swapped_orientation():
    r = match_game("TEX Rangers", "DET Tigers", CANDIDATES)
    assert r.ambiguous is False
    assert r.game.game_pk == 1
    assert r.swapped is True


def test_match_game_no_match_below_threshold():
    r = match_game("Completely Unknown", "Also Unknown", CANDIDATES)
    assert r.game is None
    assert r.ambiguous is False
    assert r.candidates == []


def test_match_game_by_team_id_when_available():
    r = match_game("cualquier texto raro", "otro texto raro", CANDIDATES, away_team_id=100, home_team_id=200)
    assert r.game.game_pk == 1
    assert r.swapped is False


def test_match_game_ambiguous_when_scores_tie_low():
    # Guardia anti-falso-positivo (identica a "Buscar Matchup MLB"): solo se dispara con
    # scores bajos (<=2) empatados -- un match de alta confianza no se cuestiona aunque
    # empate con otro (ese es el comportamiento real ya en produccion, se porta tal cual).
    ambiguous_candidates = [
        CandidateGame(sport_id=1, game_pk=10, away_team_id=1, home_team_id=2,
                      away_team_name="Zzz Wildcats", home_team_name="Foo", game_datetime_utc=None),
        CandidateGame(sport_id=1, game_pk=11, away_team_id=3, home_team_id=4,
                      away_team_name="Zzz Sharks", home_team_name="Bar", game_datetime_utc=None),
    ]
    r = match_game("Zzz", "Qqq", ambiguous_candidates)
    assert r.ambiguous is True
    assert len(r.candidates) == 2


@requires_db
@pytest.mark.asyncio
async def test_seed_and_resolve_roundtrip(pool):
    await learn_alias(pool, sport_id=1, alias_text="Tigres de Detroit", team_id=116, team_name="Detroit Tigers")
    resolved = await resolve_team_id(pool, sport_id=1, raw_text="Tigres de Detroit")
    assert resolved == 116


@requires_db
@pytest.mark.asyncio
async def test_resolve_unknown_alias_returns_none(pool):
    resolved = await resolve_team_id(pool, sport_id=1, raw_text="Equipo Que No Existe")
    assert resolved is None


@requires_db
@pytest.mark.asyncio
async def test_relearn_updates_team_id(pool):
    await learn_alias(pool, sport_id=1, alias_text="Los Tigres", team_id=116, team_name="Detroit Tigers")
    await learn_alias(pool, sport_id=1, alias_text="Los Tigres", team_id=999, team_name="Otro Equipo")
    resolved = await resolve_team_id(pool, sport_id=1, raw_text="Los Tigres")
    assert resolved == 999
