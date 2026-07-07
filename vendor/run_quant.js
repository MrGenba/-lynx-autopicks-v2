#!/usr/bin/env node
"use strict";
// Puente entre Python y los motores vendorizados (sin modificar). Lee un JSON por stdin
// con el input exacto que espera analyzeMatchup(), escribe el resultado como JSON a stdout.
const path = require("path");

const ENGINE_MAP = {
  mlb: "quant_engine_mlb.js",
  milb: "quant_engine.js",
  lmb: "quant_engine_lmb.js",
};

const league = process.argv[2];
const engineFile = ENGINE_MAP[league];
if (!engineFile) {
  process.stderr.write(JSON.stringify({ error: "liga desconocida: " + league }));
  process.exit(2);
}

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw);
    const engine = require(path.join(__dirname, engineFile));
    const result = engine.analyzeMatchup(input);
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exit(1);
  }
});
