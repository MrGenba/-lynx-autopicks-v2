"""Validacion de overround por mercado -- (1/oddsA + 1/oddsB) debe estar en [1.01, 1.15]."""
from dataclasses import dataclass
from typing import Optional

OVERROUND_MIN = 1.01
OVERROUND_MAX = 1.15


@dataclass
class OverroundCheck:
    overround: Optional[float]
    ok: bool
    reason: Optional[str] = None


def check_overround(odds_a: Optional[float], odds_b: Optional[float]) -> OverroundCheck:
    if odds_a is None or odds_b is None:
        return OverroundCheck(overround=None, ok=True)  # mercado ausente, no hay nada que validar
    if odds_a < 1.01 or odds_b < 1.01:
        return OverroundCheck(overround=None, ok=False, reason=f"cuota invalida (<1.01): {odds_a}/{odds_b}")
    overround = (1 / odds_a) + (1 / odds_b)
    if overround < OVERROUND_MIN or overround > OVERROUND_MAX:
        return OverroundCheck(
            overround=round(overround, 4), ok=False,
            reason=f"overround {overround:.4f} fuera de rango [{OVERROUND_MIN}, {OVERROUND_MAX}]",
        )
    return OverroundCheck(overround=round(overround, 4), ok=True)
