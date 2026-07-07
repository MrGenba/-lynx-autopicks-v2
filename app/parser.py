"""Parser del mensaje de cuotas por Telegram. Tolerante a mercados ausentes -- busca cada
patron de forma independiente en todo el texto, no exige un orden estricto de lineas.

Formato esperado (ejemplo del prompt original):
    DET Tigers vs TEX Rangers
    DET Tigers ML a cuota 1.76 y TEX Rangers ML a cuota 2.01
    Hándicap:
    DET Tigers Hándicap -1.5 a cuota 2.30 y TEX Rangers Hándicap +1.5 a cuota 1.58
    Carreras totales:
    Over 8.5 a cuota 1.86 y Under 8.5 a cuota 1.86

No asigna home/away aqui -- eso se resuelve despues con aliases.match_game() (el flag
`swapped` que devuelve dice si team1=away/team2=home o al reves).
"""
import re
from dataclasses import dataclass, field
from typing import Optional

RE_HEADER = re.compile(r"^\s*(.+?)\s+(?:vs\.?|@)\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
RE_ML = re.compile(
    r"(.+?)\s+ML\s+a\s+cuota\s+([\d.]+)\s+y\s+(.+?)\s+ML\s+a\s+cuota\s+([\d.]+)", re.IGNORECASE
)
RE_HC = re.compile(
    r"(.+?)\s+H[aá]ndicap\s+([+-]?[\d.]+)\s+a\s+cuota\s+([\d.]+)\s+y\s+"
    r"(.+?)\s+H[aá]ndicap\s+([+-]?[\d.]+)\s+a\s+cuota\s+([\d.]+)",
    re.IGNORECASE,
)
RE_TOTALS = re.compile(
    r"Over\s+([\d.]+)\s+a\s+cuota\s+([\d.]+)\s+y\s+Under\s+([\d.]+)\s+a\s+cuota\s+([\d.]+)", re.IGNORECASE
)


@dataclass
class ParsedOdds:
    team1_raw: str
    team2_raw: str
    team1_ml: Optional[float] = None
    team2_ml: Optional[float] = None
    team1_hc_val: Optional[float] = None
    team1_hc_odds: Optional[float] = None
    team2_hc_val: Optional[float] = None
    team2_hc_odds: Optional[float] = None
    total_line: Optional[float] = None
    over_odds: Optional[float] = None
    under_odds: Optional[float] = None
    warnings: list[str] = field(default_factory=list)

    def has_any_market(self) -> bool:
        return any(
            v is not None
            for v in (self.team1_ml, self.team2_ml, self.team1_hc_val, self.total_line)
        )


def parse_odds_message(text: str) -> Optional[ParsedOdds]:
    header = RE_HEADER.search(text)
    if not header:
        return None
    team1_raw, team2_raw = header.group(1).strip(), header.group(2).strip()
    parsed = ParsedOdds(team1_raw=team1_raw, team2_raw=team2_raw)

    ml = RE_ML.search(text)
    if ml:
        parsed.team1_ml = float(ml.group(2))
        parsed.team2_ml = float(ml.group(4))

    hc = RE_HC.search(text)
    if hc:
        parsed.team1_hc_val = float(hc.group(2))
        parsed.team1_hc_odds = float(hc.group(3))
        parsed.team2_hc_val = float(hc.group(5))
        parsed.team2_hc_odds = float(hc.group(6))

    totals = RE_TOTALS.search(text)
    if totals:
        line_over, over_odds, line_under, under_odds = (float(x) for x in totals.groups())
        if line_over != line_under:
            parsed.warnings.append(f"linea de Over ({line_over}) y Under ({line_under}) no coinciden")
        parsed.total_line = line_over
        parsed.over_odds = over_odds
        parsed.under_odds = under_odds

    if not parsed.has_any_market():
        return None
    return parsed
