"""Resolucion de equipo/partido a partir de texto libre.

Porta el patron real usado en el nodo n8n "Buscar Matchup MLB" (norm()/score()) y anade una
tabla de alias (sembrada desde MLB Stats API + aprendida de desambiguaciones del usuario) como
capa rapida antes de caer al fuzzy-matching directo contra los partidos del dia.
"""
import datetime as dt
import re
import unicodedata
from dataclasses import dataclass
from typing import Optional

import asyncpg
import httpx

STATS_API = "https://statsapi.mlb.com/api/v1"
SPORT_IDS = (1, 11, 23)  # MLB, MiLB AAA, LMB


def norm(s: Optional[str]) -> str:
    """Identico al norm() de Buscar Matchup MLB: minusculas, sin puntuacion, espacios colapsados."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def score(a: Optional[str], b: Optional[str]) -> int:
    """Identico al score() de Buscar Matchup MLB: 3=exacto, 2=uno empieza con el otro,
    si no cuenta palabras de a que aparecen como substring en b."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0
    if na == nb:
        return 3
    if nb.startswith(na) or na.startswith(nb):
        return 2
    return sum(1 for w in na.split(" ") if w and w in nb)


@dataclass
class CandidateGame:
    sport_id: int
    game_pk: int
    away_team_id: Optional[int]
    home_team_id: Optional[int]
    away_team_name: str
    home_team_name: str
    game_datetime_utc: Optional[dt.datetime]
    game_no_hint: Optional[int] = None


@dataclass
class MatchResult:
    game: Optional[CandidateGame]
    swapped: bool
    ambiguous: bool
    candidates: list[CandidateGame]


async def seed_all(pool: asyncpg.Pool) -> int:
    """Siembra team_aliases desde MLB Stats API para los 3 sport_id -- variantes:
    'ABR Nickname', nombre completo, solo nickname, solo abreviatura. Idempotente
    (ON CONFLICT DO NOTHING) -- no pisa alias aprendidos ni se duplica al re-ejecutar."""
    inserted = 0
    async with httpx.AsyncClient(timeout=15.0) as client:
        async with pool.acquire() as conn:
            for sport_id in SPORT_IDS:
                resp = await client.get(f"{STATS_API}/teams", params={"sportId": sport_id})
                resp.raise_for_status()
                teams = resp.json().get("teams", [])
                for team in teams:
                    team_id = team.get("id")
                    full_name = team.get("name")
                    nickname = team.get("teamName")
                    abbrev = team.get("abbreviation")
                    if not team_id:
                        continue
                    variants = set()
                    if abbrev and nickname:
                        variants.add(f"{abbrev} {nickname}")
                    if full_name:
                        variants.add(full_name)
                    if nickname:
                        variants.add(nickname)
                    if abbrev:
                        variants.add(abbrev)
                    for variant in variants:
                        alias_norm = norm(variant)
                        if not alias_norm:
                            continue
                        result = await conn.execute(
                            "INSERT INTO team_aliases (sport_id, team_id, team_name, alias_text, alias_norm, source) "
                            "VALUES ($1,$2,$3,$4,$5,'seed') ON CONFLICT (sport_id, alias_norm) DO NOTHING",
                            sport_id, team_id, full_name or nickname, variant, alias_norm,
                        )
                        if result.endswith(" 1"):
                            inserted += 1
    return inserted


async def learn_alias(pool: asyncpg.Pool, sport_id: int, alias_text: str, team_id: int, team_name: str) -> None:
    alias_norm = norm(alias_text)
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO team_aliases (sport_id, team_id, team_name, alias_text, alias_norm, source) "
            "VALUES ($1,$2,$3,$4,$5,'learned') "
            "ON CONFLICT (sport_id, alias_norm) DO UPDATE SET team_id = EXCLUDED.team_id, team_name = EXCLUDED.team_name",
            sport_id, team_id, team_name, alias_text, alias_norm,
        )


async def resolve_team_id(pool: asyncpg.Pool, sport_id: int, raw_text: str) -> Optional[int]:
    """Busqueda exacta en team_aliases (sembrados + aprendidos). None si no hay match exacto --
    el fuzzy-matching directo contra los partidos del dia (match_game) es el siguiente paso."""
    alias_norm = norm(raw_text)
    if not alias_norm:
        return None
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT team_id FROM team_aliases WHERE sport_id = $1 AND alias_norm = $2", sport_id, alias_norm
        )
    return row["team_id"] if row else None


def match_game(
    away_raw: str,
    home_raw: str,
    candidates: list[CandidateGame],
    away_team_id: Optional[int] = None,
    home_team_id: Optional[int] = None,
    game_no_hint: Optional[int] = None,
) -> MatchResult:
    """Resuelve el partido concreto entre los candidatos de hoy.

    Primero intenta por team_id (si se resolvieron via alias table) -- mas fiable. Si no hay
    team_id o no hay match unico, cae al fuzzy score() directo contra away_team_name/home_team_name,
    igual que "Buscar Matchup MLB": ambas orientaciones, mayor score gana, guardia anti-ambiguedad
    (score<=2 y el segundo empata o supera -> ambiguo).
    """
    if away_team_id is not None and home_team_id is not None:
        by_id = [
            g for g in candidates
            if {g.away_team_id, g.home_team_id} == {away_team_id, home_team_id}
        ]
        if len(by_id) == 1:
            g = by_id[0]
            swapped = g.away_team_id != away_team_id
            return MatchResult(game=g, swapped=swapped, ambiguous=False, candidates=[g])
        if len(by_id) > 1:
            # varios partidos entre el mismo par (doble cartelera) -- desambiguar por hint o dejarlo ambiguo
            if game_no_hint in (1, 2):
                hinted = [g for g in by_id if g.game_no_hint == game_no_hint]
                if len(hinted) == 1:
                    g = hinted[0]
                    return MatchResult(game=g, swapped=g.away_team_id != away_team_id, ambiguous=False, candidates=[g])
            return MatchResult(game=None, swapped=False, ambiguous=True, candidates=by_id)

    scored = []
    for g in candidates:
        direct = score(away_raw, g.away_team_name) + score(home_raw, g.home_team_name)
        swapped_score = score(away_raw, g.home_team_name) + score(home_raw, g.away_team_name)
        use_swapped = swapped_score > direct
        s = swapped_score if use_swapped else direct
        if s < 2:
            continue
        scored.append((s, use_swapped, g))

    if not scored:
        return MatchResult(game=None, swapped=False, ambiguous=False, candidates=[])

    scored.sort(key=lambda t: t[0], reverse=True)
    best_score, best_swapped, best_game = scored[0]

    if len(scored) > 1 and best_score <= 2 and scored[1][0] >= best_score:
        return MatchResult(game=None, swapped=False, ambiguous=True, candidates=[s[2] for s in scored[:5]])

    return MatchResult(game=best_game, swapped=best_swapped, ambiguous=False, candidates=[best_game])
