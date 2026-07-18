#!/usr/bin/env node
"use strict";
// Puente entre Python y el scraper vendorizado de cuotasahora.com. Liga por argv, resto por
// stdin (JSON: {"candidateNames": [...], "bookmaker": "Bet365"|"Winamax"}). candidateNames se
// usa para no perforar Totales/Handicap de partidos que no hacen falta (ver comentario en
// makeShouldDrill dentro de scraper_cuotasahora.js). bookmaker (2026-07-18) elige que casa
// buscar -- nunca se sustituye por otra si no se encuentra, ver pickBookmaker() en
// parser_cuotasahora.js. Sin stdin o con campos ausentes, defaults: candidateNames=[],
// bookmaker="Bet365" (comportamiento igual que antes de este cambio). El proxy (si hace falta)
// se lee de PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD dentro de scraper_cuotasahora.js, no aqui.
const { fetchLeagueOdds, shutdown } = require("./scraper_cuotasahora");

const league = process.argv[2];

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    if (process.stdin.isTTY) { resolve(""); return; }
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
    setTimeout(() => resolve(raw), 500); // sin stdin real conectado, no colgarse esperando
  });
}

(async () => {
  try {
    const raw = await readStdin();
    let candidateNames = [];
    let bookmaker = "Bet365";
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        candidateNames = parsed.candidateNames || [];
        bookmaker = parsed.bookmaker || "Bet365";
      } catch (_) { /* sin stdin valido, sigue con defaults */ }
    }
    const result = await fetchLeagueOdds(league, candidateNames, bookmaker);
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
