"""Interfaz comun de los adaptadores por liga: construyen el objeto 'game' enriquecido que
espera quant_engine*.js a partir de los datos ya existentes en Supabase (solo lectura)."""
from typing import Literal, Optional, Protocol

Mode = Literal["pitchers_only", "full_lineup"]


class Adapter(Protocol):
    async def build_game_object(
        self,
        game_pk: int,
        mode: Mode,
        away_pitcher_id: Optional[int] = None,
        home_pitcher_id: Optional[int] = None,
    ) -> Optional[dict]:
        """Devuelve el dict 'game' listo para pasar a analyzeMatchup(), o None si faltan
        datos imprescindibles (p.ej. sin ERA/FIP de abridores) -- en ese caso el llamador
        avisa al admin y no calcula nada.

        away_pitcher_id/home_pitcher_id son un fallback OPCIONAL: el detector los lee de
        forma fiable en vivo (MLB Stats API) y los guarda en games_gate_state, mientras que
        la vista/tabla de Supabase puede no tener aun el pitcher_id sincronizado aunque el
        resto del partido ya exista. Cada adaptador los usa solo donde puede actuar sobre
        ellos (consultas propias de stats de abridor); no resuelve el caso en que el partido
        entero todavia no existe en Supabase."""
        ...
