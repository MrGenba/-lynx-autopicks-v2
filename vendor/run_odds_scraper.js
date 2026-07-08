#!/usr/bin/env node
"use strict";
// Puente entre Python y el scraper vendorizado de cuotasahora.com. Liga por argv, lista
// opcional de nombres de equipo candidatos por stdin (JSON: {"candidateNames": [...]}) -- se
// usa para no perforar Totales/Handicap de partidos que no hacen falta (ver comentario en
// makeShouldDrill dentro de scraper_cuotasahora.js). Sin stdin o con lista vacia, se comporta
// igual que antes (perfora todos los partidos de la liga). El proxy (si hace falta) se lee de
// PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD dentro de scraper_cuotasahora.js, no aqui.
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
    if (raw.trim()) {
      try { candidateNames = JSON.parse(raw).candidateNames || []; } catch (_) { /* sin stdin valido, sigue con [] */ }
    }
    const result = await fetchLeagueOdds(league, candidateNames);
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
