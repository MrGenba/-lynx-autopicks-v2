"""Interfaz comun de los adaptadores por liga: construyen el objeto 'game' enriquecido que
espera quant_engine*.js a partir de los datos ya existentes en Supabase (solo lectura)."""
from typing import Literal, Optional, Protocol

Mode = Literal["pitchers_only", "full_lineup"]


class Adapter(Protocol):
    async def build_game_object(self, game_pk: int, mode: Mode) -> Optional[dict]:
        """Devuelve el dict 'game' listo para pasar a analyzeMatchup(), o None si faltan
        datos imprescindibles (p.ej. sin ERA/FIP de abridores) -- en ese caso el llamador
        avisa al admin y no calcula nada."""
        ...
