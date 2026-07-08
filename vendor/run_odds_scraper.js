#!/usr/bin/env node
"use strict";
// Puente entre Python y el scraper vendorizado de cuotasahora.com. A diferencia de
// run_quant.js no necesita stdin -- solo la liga por argv. Escribe el resultado de
// fetchLeagueOdds() como JSON a stdout. El proxy (si hace falta) se lee de PROXY_SERVER/
// PROXY_USERNAME/PROXY_PASSWORD dentro de scraper_cuotasahora.js, no aqui.
const { fetchLeagueOdds, shutdown } = require("./scraper_cuotasahora");

const league = process.argv[2];

(async () => {
  try {
    const result = await fetchLeagueOdds(league);
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
