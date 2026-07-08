// Parser de texto renderizado (innerText) de cuotasahora.com (sucesor de oddsportal.com).
// A diferencia de bet365, es un comparador estático sin Cloudflare ni WebSocket que proteger --
// el reto aquí es puramente de estructura: la ficha de cada partido muestra por defecto la
// tabla de Moneyline (1X2) con el desglose completo por casa de apuestas, pero Hándicap/Totales
// solo muestran una lista de líneas agregadas (mejor cuota disponible, sin desglose) hasta que
// se entra en una línea concreta -- momento en el que sí aparece el desglose por casa.

const RE_ODDS = /^\d+\.\d+$/;
const RE_PAYOUT = /^\d+(\.\d+)?%$|^-$/;
const RE_SIGNED_LINE = /^[+-]\d+(\.\d+)?$/;
const RE_TIME = /^\d{1,2}:\d{2}$/;

function parseBookmakerRows(lines, startIdx, endIdx) {
  const rows = [];
  for (let i = startIdx; i < endIdx - 3; i++) {
    if (lines[i + 1] !== "OBTENER BONO") continue;
    const name = lines[i];
    let j = i + 2;
    let line = null;
    if (RE_SIGNED_LINE.test(lines[j])) { line = parseFloat(lines[j]); j++; }
    if (RE_ODDS.test(lines[j]) && RE_ODDS.test(lines[j + 1]) && RE_PAYOUT.test(lines[j + 2])) {
      rows.push({ bookmaker: name, line, odds1: parseFloat(lines[j]), odds2: parseFloat(lines[j + 1]), payout: lines[j + 2] });
      i = j + 2;
    }
  }
  return rows;
}

function pickBookmaker(rows, preferred) {
  if (!rows.length) return null;
  return rows.find((r) => r.bookmaker.toLowerCase() === preferred.toLowerCase()) || rows[0];
}

// Lista agregada (antes de entrar en una línea concreta): cada línea de texto trae la
// etiqueta de pestaña + valor con signo ya combinados, ej. "Hándicap asiático -1.5".
function parseAggregateLines(lines, tabLabel, startIdx, endIdx) {
  const re = new RegExp("^" + tabLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+([+-]\\d+(?:\\.\\d+)?)$");
  const out = [];
  for (let i = startIdx; i < endIdx - 3; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const count = parseInt(lines[i + 1], 10);
    if (!Number.isFinite(count) || !RE_ODDS.test(lines[i + 2]) || !RE_ODDS.test(lines[i + 3])) continue;
    out.push({ line: parseFloat(m[1]), count, odds1: parseFloat(lines[i + 2]), odds2: parseFloat(lines[i + 3]) });
  }
  return out;
}

// El hándicap de béisbol es prácticamente siempre ±1.5 (run line) -- se prioriza esa línea
// exacta si existe en vez de la de mayor liquidez, para que coincida con lo que espera el
// motor cuantitativo. Los totales no tienen un valor fijo (varían según el partido), así que
// ahí sí se usa la línea con más casas ofreciéndola como proxy de "línea principal del mercado".
function pickMainLine(aggLines, { preferAbs } = {}) {
  if (!aggLines.length) return null;
  if (preferAbs != null) {
    const exact = aggLines.find((l) => Math.abs(l.line) === preferAbs);
    if (exact) return exact;
  }
  return aggLines.reduce((best, cur) => (cur.count > best.count ? cur : best), aggLines[0]);
}

// Cabecera de la ficha de partido: "Equipo Local - Equipo Visitante" (confirmado: el orden de
// visualización es siempre local primero, sin importar el orden de los slugs en la URL).
// Si aparece "Resultado final" o un marcador de entrada en vivo antes de la pestaña "1X2",
// el partido ya empezó/terminó y se descarta (fuera de alcance, solo cuotas pre-match).
function parseMatchHeader(lines) {
  const titleIdx = lines.findIndex((l) => l.includes(" - ") && !RE_TIME.test(l));
  if (titleIdx === -1) return null;
  const [home_team, away_team] = lines[titleIdx].split(" - ").map((s) => s.trim());

  const tabIdx = lines.findIndex((l, i) => i > titleIdx && l === "1X2");
  if (tabIdx === -1) return null;
  const between = lines.slice(titleIdx, tabIdx);
  const isLive = between.some((l) => l === "Resultado final" || /^\d+I$/.test(l));
  const time = between.find((l) => RE_TIME.test(l)) || null;

  return { home_team, away_team, time, isLive, tabIdx };
}

module.exports = { parseBookmakerRows, pickBookmaker, parseAggregateLines, pickMainLine, parseMatchHeader, RE_ODDS, RE_PAYOUT };
