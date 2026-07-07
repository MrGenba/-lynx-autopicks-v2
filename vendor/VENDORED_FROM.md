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
