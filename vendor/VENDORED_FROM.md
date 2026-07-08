# Origen de los motores vendorizados

Estos 3 archivos son extraídos **verbatim** de los nodos reales de n8n (no de las copias locales en `D:\Milb\quant_engine*.js`, que estaban desincronizadas — ver hallazgo de la Fase 0). Se les quitó únicamente el envoltorio `const engine = (() => { ... })();` propio del nodo de n8n y el pegamento posterior (`$input.all()`, etc.), y se cambió el `return {...}` final por `module.exports = {...}` para que sean módulos Node normales. **Ninguna línea de lógica fue modificada.**

| Archivo local | Nodo n8n origen | sha256 (primeros 16) | Fecha de sync |
|---|---|---|---|
| `quant_engine_mlb.js` | "Motor MLB" (workflow `blFBFDgejVSXilfR`, Bot Unificado) | `c217b4b359b9f623` | 2026-07-07 |
| `quant_engine.js` | "Motor MiLB" (mismo workflow) | `d4d0fae614151725` | 2026-07-07 |
| `quant_engine_lmb.js` | "Motor LMB" (mismo workflow) | `fea0477e82fc7133` | 2026-07-07 |

**Confirmado en esta sincronización**: `quant_engine_mlb.js` local (en `D:\Milb`, fuera de este proyecto) tenía `RUN_CALIBRATION_FACTOR = 1.08` marcado como "no desplegado" — el nodo real en n8n tiene `1.0` (revertido 2026-07-05, ver comentario en el propio código). Esta copia vendorizada usa el valor **real y correcto** (1.0).

**Cómo re-sincronizar en el futuro** (si el motor real cambia en n8n): repetir el mismo patrón —
```js
GET https://n8n-n8n.0zhp4h.easypanel.host/api/v1/workflows/blFBFDgejVSXilfR
// extraer node.parameters.jsCode del nodo "Motor {Liga}"
// quitar la línea 1 "const engine = (() => {" y todo desde la línea "})();" en adelante
// cambiar el "return {...}" final (el último, con analyzeMatchup) por "module.exports = {...}"
```
No usar `scripts/sync_vendor_from_n8n.py` sin revisar el diff a mano — un cambio de calibración en producción debe copiarse aquí deliberadamente, no automáticamente en cada arranque.

## Scraper de cuotas (`scraper_cuotasahora.js` + `parser_cuotasahora.js` + `run_odds_scraper.js`)

Vendorizados desde `D:\Milb\odds_bet365\` (2026-07-08/09) con **una única diferencia** respecto
al original: `ensureBrowser()` en `scraper_cuotasahora.js` lee `PROXY_SERVER`/`PROXY_USERNAME`/
`PROXY_PASSWORD` del entorno y los pasa a `chromium.launch({proxy:...})` -- necesario porque el
VPS de Francia donde corre `autopicks-app` está bloqueado por cuotasahora.com (confirmado
2026-07-08 con una petición HTTP plana desde n8n, timeout). Producción (`odds_bet365/` + el nodo
n8n "Actualizar Cuotas bet365") NO usa proxy y seguirá bloqueada hasta que se le añada uno
también, si hiciera falta -- ese cambio no se ha propagado ahí a propósito (fuera del alcance de
esta sesión).

| Archivo local | Origen | sha256 original (completo) |
|---|---|---|
| `parser_cuotasahora.js` | `D:\Milb\odds_bet365\parser_cuotasahora.js`, sin cambios | `02bacb20e25ccea696be83b016876e4e6ec402e6f01a145c5570c86bb2f1850e` |
| `scraper_cuotasahora.js` | `D:\Milb\odds_bet365\scraper_cuotasahora.js`, + soporte de proxy | `f61bcf7b7ae4d06d8ad5dd45d350d2f8d93657ad248109c11e3be673b25b56a1` |
| `run_odds_scraper.js` | nuevo, ~20 líneas (mismo patrón que `run_quant.js`) | n/a |
