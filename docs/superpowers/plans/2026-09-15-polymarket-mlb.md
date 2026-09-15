# Edge Hunter fase A — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Este plan sustituye al de la mañana del mismo día**, que enganchaba la captura en el Gate B de `app/detector.py`. El usuario pidió explícitamente no tocar nada de lo existente, así que aquella versión queda descartada entera.

**Goal:** Una línea independiente que, cuando se completa el lineup de un partido de MLB, captura el mercado de Polymarket, avisa al canal de Edge Hunter y evalúa las condiciones de apuesta en modo papel — sin tocar una sola línea del sistema de picks.

**Architecture:** Un workflow nuevo de n8n (`EDGE_HUNTER_POLYMARKET`) cada 10 minutos: pregunta el calendario y los boxscores a StatsAPI, detecta lineups completos por su cuenta, pide el evento a Gamma y el libro al CLOB, guarda en tablas propias y avisa por Telegram. Solo lee de lo existente.

**Tech Stack:** n8n (nodo Code, JavaScript), Supabase/PostgREST, APIs de Polymarket (Gamma + CLOB), StatsAPI. Sin dependencias nuevas y sin infraestructura nueva.

**Spec:** `docs/superpowers/specs/2026-09-15-polymarket-mlb-design.md`

## Global Constraints

- **Cero modificaciones en lo existente**: ni `autopicks_v2`, ni los 27 workflows, ni sus tablas. Esta línea **solo lee**.
- **Fase A no envía ninguna orden.** Las condiciones se evalúan y se registran como papel. Sin excepción.
- **Solo MLB.**
- **La fecha del slug es la americana (ET)**, nunca la UTC.
- **Tablas propias** con prefijo `edge_hunter_`.
- **El fichero fuente del nodo no lleva credenciales**: marcadores que el script de despliegue sustituye leyendo de n8n, como en `nodo_salud_diaria.js`.
- **DDL antes que código**: la tabla existe antes de desplegar nada que escriba en ella.
- Pendiente del usuario, y **no bloquea nada de este plan**: el chat id del canal de Edge Hunter (hasta que llegue se usa el chat de admin `9340680`) y las condiciones/cantidades, que entran como configuración en la tarea 2.

---

### Task 1: Tablas propias

**Files:**
- Create: `D:/Milb/deploy_edge_hunter_tablas.js`

**Interfaces:**
- Produces: tablas `edge_hunter_snapshots` y `edge_hunter_config`.

- [ ] **Step 1: Escribir el script de DDL**

Copiar el patrón de `D:/Milb/deploy_odds_snapshots_fase_cierre.js` (Management API de Supabase; el patrón viejo de nodo Postgres en n8n **ya no funciona**, esa credencial no existe). SQL:

```sql
CREATE TABLE IF NOT EXISTS edge_hunter_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  game_pk           BIGINT      NOT NULL UNIQUE,
  game_date         DATE,
  away_team         TEXT,
  home_team         TEXT,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  slug              TEXT        NOT NULL,
  encontrado        BOOLEAN     NOT NULL DEFAULT false,
  evento            JSONB,
  libro             JSONB,
  ml_away           NUMERIC,
  ml_home           NUMERIC,
  spread_pct        NUMERIC,
  prob_modelo_away  NUMERIC,
  edge_pct          NUMERIC,
  decision          TEXT,
  papel             BOOLEAN     NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS edge_hunter_config (
  id               INT PRIMARY KEY DEFAULT 1,
  activo           BOOLEAN NOT NULL DEFAULT false,
  edge_minimo      NUMERIC,
  spread_maximo    NUMERIC,
  liquidez_minima  NUMERIC,
  stake            NUMERIC,
  max_diario       NUMERIC,
  max_abiertas     INT,
  mercados         TEXT[],
  actualizado_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT edge_hunter_config_una_sola_fila CHECK (id = 1)
);

INSERT INTO edge_hunter_config (id, activo) VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE edge_hunter_snapshots IS
  'Edge Hunter (2026-09-15): foto del mercado de Polymarket al completarse el lineup de un partido de MLB. Linea independiente del sistema de picks: solo lee de el. `evento` guarda los 17 mercados tal cual.';
COMMENT ON TABLE edge_hunter_config IS
  'Condiciones y topes de apuesta. `activo=false` significa modo papel: se evalua y se registra, no se envia nada. Los valores los da el usuario; viven en tabla y no en codigo para poder cambiarlos sin desplegar.';

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Ejecutar y verificar**

```bash
node D:/Milb/deploy_edge_hunter_tablas.js
```

Verificar por PostgREST: `GET /rest/v1/edge_hunter_config?select=*` debe devolver **una fila con `activo=false`**, y `GET /rest/v1/edge_hunter_snapshots?select=id&limit=1` un `200` con `[]`.

- [ ] **Step 3: Sin commit**

`D:/Milb` no es repositorio. El script queda anotado en `CLAUDE.md` en la tarea 5.

---

### Task 2: La lógica pura, con su banco de pruebas

**Files:**
- Create: `D:/Milb/edge_hunter_logica.js` (funciones puras, sin red)
- Test: `D:/Milb/test_edge_hunter_logica.js` (se ejecuta con `node`, sin framework)

**Interfaces:**
- Produces: `CODIGO_EQUIPO`, `fechaET(iso)`, `construirSlug(away, home, fechaET)`, `mejorBidAsk(libro)`, `spreadPct(bid, ask)`, `lineupCompleto(boxscore)`, `evaluar(snapshot, config)`.

- [ ] **Step 1: Escribir el banco de pruebas que falla**

```js
"use strict";
// Banco de pruebas de la logica pura de Edge Hunter. Sin red y sin framework: `node
// test_edge_hunter_logica.js`. Se hace asi a proposito -- D:\Milb no tiene runner de JS y montar
// uno para seis funciones seria infraestructura sin lectura que la justifique.
const L = require("./edge_hunter_logica");
let fallos = 0;
function ok(nombre, cond) { if (!cond) { fallos++; console.log("FALLA: " + nombre); } }

// -- slug -------------------------------------------------------------------
ok("slug normal", L.construirSlug("Los Angeles Dodgers", "Cincinnati Reds", "2026-09-15") === "mlb-lad-cin-2026-09-15");
// Se mudaron de Oakland y el nombre oficial ya no dice la ciudad, pero Polymarket mantiene `oak`.
// Verificado en vivo: mlb-oak-tb-2026-09-15 -> "Athletics vs. Tampa Bay Rays".
ok("athletics siguen siendo oak", L.construirSlug("Athletics", "Tampa Bay Rays", "2026-09-15") === "mlb-oak-tb-2026-09-15");
// Inventar un slug lo convertiria en un 404 indistinguible de "no hay mercado": son dos fallos
// distintos y no deben confundirse.
ok("equipo desconocido da null", L.construirSlug("Yakult Swallows", "Cincinnati Reds", "2026-09-15") === null);
ok("mapa con 30 equipos", Object.keys(L.CODIGO_EQUIPO).length === 30);

// -- fecha americana --------------------------------------------------------
// Un partido a las 01:45 UTC del 16 es la jornada del 15. Usar la fecha UTC es el error que
// invalido el experimento de los abridores el 2026-09-15.
ok("01:45 UTC del 16 es el 15 en ET", L.fechaET("2026-09-16T01:45:00Z") === "2026-09-15");
ok("22:05 UTC del 15 sigue siendo el 15", L.fechaET("2026-09-15T22:05:00Z") === "2026-09-15");

// -- libro ------------------------------------------------------------------
// Libro real del CLOB (recortado): el mejor de cada lado NO esta en posicion fija, por eso se
// elige por valor y no por indice.
const LIBRO = { bids: [{ price: "0.61" }, { price: "0.68" }], asks: [{ price: "0.75" }, { price: "0.69" }] };
ok("mejor bid/ask por valor", JSON.stringify(L.mejorBidAsk(LIBRO)) === JSON.stringify([0.68, 0.69]));
ok("spread sobre el punto medio", Math.abs(L.spreadPct(0.68, 0.69) - 1.4599) < 0.001);
// Cero significaria "mercado sin coste", que es justo lo que hay que demostrar. Un libro vacio es
// ausencia de dato.
ok("libro vacio da null, no cero", L.mejorBidAsk({ bids: [], asks: [] })[0] === null && L.spreadPct(null, 0.5) === null);

// -- lineup -----------------------------------------------------------------
const nueve = { battingOrder: [1,2,3,4,5,6,7,8,9] };
const ocho = { battingOrder: [1,2,3,4,5,6,7,8] };
ok("lineup completo con 9 y 9", L.lineupCompleto({ teams: { away: nueve, home: nueve } }) === true);
ok("ocho bateadores no es completo", L.lineupCompleto({ teams: { away: nueve, home: ocho } }) === false);
ok("boxscore vacio no revienta", L.lineupCompleto({}) === false);

// -- decision ---------------------------------------------------------------
const SNAP = { ml_away: 0.60, prob_modelo_away: 0.70, spread_pct: 1.4, liquidez: 5000 };
const CFG_APAGADA = { activo: false, edge_minimo: 5, spread_maximo: 3, liquidez_minima: 1000, stake: 10 };
const CFG_ACTIVA = { ...CFG_APAGADA, activo: true };
ok("sin condiciones configuradas no apuesta", L.evaluar(SNAP, {}).apostar === false);
ok("con la config apagada se queda en papel", L.evaluar(SNAP, CFG_APAGADA).papel === true);
ok("cumple condiciones -> apostaria", L.evaluar(SNAP, CFG_ACTIVA).apostar === true);
ok("spread ancho lo descarta", L.evaluar({ ...SNAP, spread_pct: 9 }, CFG_ACTIVA).apostar === false);
ok("poca liquidez lo descarta", L.evaluar({ ...SNAP, liquidez: 10 }, CFG_ACTIVA).apostar === false);
ok("edge corto lo descarta", L.evaluar({ ...SNAP, prob_modelo_away: 0.605 }, CFG_ACTIVA).apostar === false);
// Sin probabilidad del modelo no hay edge que calcular: se captura igual, pero no se apuesta.
ok("sin modelo no apuesta", L.evaluar({ ...SNAP, prob_modelo_away: null }, CFG_ACTIVA).apostar === false);

console.log(fallos ? fallos + " fallo(s)" : "todo en verde");
process.exit(fallos ? 1 : 0);
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node D:/Milb/test_edge_hunter_logica.js`
Expected: `Error: Cannot find module './edge_hunter_logica'`

- [ ] **Step 3: Implementar la lógica**

```js
"use strict";
/**
 * Logica pura de Edge Hunter: sin red, sin estado, testeable con `node test_edge_hunter_logica.js`.
 * Vive aqui y no dentro del nodo de n8n para que se pueda probar antes de desplegar -- el nodo la
 * lleva incrustada al desplegarse (ver deploy_edge_hunter.js).
 */
const CODIGO_EQUIPO = {
  "Arizona Diamondbacks": "ari", "Atlanta Braves": "atl", "Baltimore Orioles": "bal",
  "Boston Red Sox": "bos", "Chicago Cubs": "chc", "Chicago White Sox": "cws",
  "Cincinnati Reds": "cin", "Cleveland Guardians": "cle", "Colorado Rockies": "col",
  "Detroit Tigers": "det", "Houston Astros": "hou", "Kansas City Royals": "kc",
  "Los Angeles Angels": "laa", "Los Angeles Dodgers": "lad", "Miami Marlins": "mia",
  "Milwaukee Brewers": "mil", "Minnesota Twins": "min", "New York Mets": "nym",
  "New York Yankees": "nyy", "Athletics": "oak", "Philadelphia Phillies": "phi",
  "Pittsburgh Pirates": "pit", "San Diego Padres": "sd", "San Francisco Giants": "sf",
  "Seattle Mariners": "sea", "St. Louis Cardinals": "stl", "Tampa Bay Rays": "tb",
  "Texas Rangers": "tex", "Toronto Blue Jays": "tor", "Washington Nationals": "wsh",
};

// La fecha oficial de un partido de MLB es la local del estadio y coincide con la del este de EEUU
// en el primer lanzamiento. La UTC NO vale: la jornada cae a caballo de la medianoche UTC.
function fechaET(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function construirSlug(away, home, fecha) {
  const a = CODIGO_EQUIPO[(away || "").trim()], h = CODIGO_EQUIPO[(home || "").trim()];
  if (!a || !h) return null;
  return "mlb-" + a + "-" + h + "-" + String(fecha).slice(0, 10);
}

function mejorBidAsk(libro) {
  const precios = lado => ((libro || {})[lado] || [])
    .map(n => Number(n && n.price)).filter(Number.isFinite);
  const b = precios("bids"), a = precios("asks");
  return [b.length ? Math.max.apply(null, b) : null, a.length ? Math.min.apply(null, a) : null];
}

function spreadPct(bid, ask) {
  if (bid == null || ask == null) return null;
  const medio = (bid + ask) / 2;
  return medio > 0 ? ((ask - bid) / medio) * 100 : null;
}

function lineupCompleto(boxscore) {
  const lado = s => (((boxscore || {}).teams || {})[s] || {}).battingOrder || [];
  return lado("away").length >= 9 && lado("home").length >= 9;
}

/**
 * Decide, y sobre todo EXPLICA. `apostar` solo puede ser true si la config esta activa y se cumplen
 * todas las condiciones; en cualquier otro caso se registra el motivo, que es lo que permite leer
 * despues por que no se aposto.
 */
function evaluar(snap, config) {
  const cfg = config || {};
  const motivos = [];
  const edge = (snap.prob_modelo_away != null && snap.ml_away != null)
    ? (snap.prob_modelo_away - snap.ml_away) * 100 : null;

  if (!cfg.edge_minimo && cfg.edge_minimo !== 0) motivos.push("sin condiciones configuradas");
  if (edge == null) motivos.push("sin probabilidad del modelo");
  else if (cfg.edge_minimo != null && edge < cfg.edge_minimo) motivos.push("edge " + edge.toFixed(1) + "% < " + cfg.edge_minimo + "%");
  if (cfg.spread_maximo != null && snap.spread_pct != null && snap.spread_pct > cfg.spread_maximo)
    motivos.push("spread " + snap.spread_pct.toFixed(2) + "% > " + cfg.spread_maximo + "%");
  if (cfg.liquidez_minima != null && (snap.liquidez == null || snap.liquidez < cfg.liquidez_minima))
    motivos.push("liquidez insuficiente");

  const cumple = motivos.length === 0;
  return {
    edge_pct: edge,
    apostar: cumple && cfg.activo === true,
    papel: !(cumple && cfg.activo === true),
    motivo: cumple ? (cfg.activo ? "cumple" : "cumple pero la config esta en papel") : motivos.join(" · "),
  };
}

module.exports = { CODIGO_EQUIPO, fechaET, construirSlug, mejorBidAsk, spreadPct, lineupCompleto, evaluar };
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node D:/Milb/test_edge_hunter_logica.js`
Expected: `todo en verde`

---

### Task 3: El nodo de n8n

**Files:**
- Create: `D:/Milb/nodo_edge_hunter.js` (fuente del nodo, **con marcadores, sin credenciales**)
- Create: `D:/Milb/deploy_edge_hunter.js` (crea/actualiza el workflow `EDGE_HUNTER_POLYMARKET`)

**Interfaces:**
- Consumes: `edge_hunter_logica.js` (se incrusta al desplegar), tablas de la tarea 1.
- Produces: workflow `EDGE_HUNTER_POLYMARKET` activo, cada 10 minutos.

- [ ] **Step 1: Escribir el nodo**

Estructura, siguiendo el patrón ya probado de `nodo_salud_diaria.js`:

```js
// EDGE_HUNTER_POLYMARKET -- nodo Code de n8n. Fuente: D:\Milb\nodo_edge_hunter.js.
//
// LINEA INDEPENDIENTE (2026-09-15, encargo del usuario: "no modifiques nada de lo antiguo").
// Solo LEE del sistema de picks (`predictions_log`); escribe unicamente en sus propias tablas
// `edge_hunter_*`. Si esto se cae, Lynx Hunter no se entera.
//
// FASE A: no envia ninguna orden. Evalua las condiciones y registra la apuesta hipotetica.
const SUPA_URL = "__SUPA_URL__";
const SUPA_KEY = "__SUPA_KEY__";
const BOT_TOKEN = "__BOT_TOKEN__";
const TG_EDGE = "__TG_EDGE__";     // canal de Edge Hunter; hasta tenerlo, el chat de admin
const STATS = "https://statsapi.mlb.com/api/v1";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const VENTANA_H = 6;               // solo partidos que empiezan dentro de estas horas

// <<<LOGICA>>>  (deploy_edge_hunter.js incrusta aqui edge_hunter_logica.js sin su module.exports)

const http = (opts) => this.helpers.httpRequest(opts);
```

El cuerpo, en este orden y cada bloque en su `try`:

1. `GET {STATS}/schedule?sportId=1&date=<fechaET(ahora)>` → partidos que empiezan en las próximas `VENTANA_H` horas y aún no han empezado.
2. Para cada uno, `GET {SUPA_URL}/rest/v1/edge_hunter_snapshots?game_pk=eq.<pk>&select=id` — si ya existe, se salta (una captura por partido).
3. `GET {STATS}/game/<pk>/boxscore` → `lineupCompleto(...)`. Si no, se salta.
4. `construirSlug(...)` → `GET {GAMMA}/events?slug=<slug>`. Si no hay evento: se escribe fila con `encontrado=false` y se sigue — **la cobertura tiene que ser una cifra, no una ausencia invisible**.
5. Del evento, el moneyline es el mercado cuya `question` coincide con el título del evento; los demás llevan sufijo (`Spread: ...`, `...: Over 8.5`). De él: `outcomePrices` y `clobTokenIds`.
6. `GET {CLOB}/book?token_id=<token0>` → `mejorBidAsk` + `spreadPct`, y la liquidez del mejor nivel.
7. `GET {SUPA_URL}/rest/v1/predictions_log?game_pk=eq.<pk>&league=eq.MLB&select=p_ml_away` → probabilidad del modelo si existe.
8. `evaluar(snap, config)` con la fila de `edge_hunter_config`.
9. `POST` a `edge_hunter_snapshots` con `?on_conflict=game_pk` y `Prefer: resolution=merge-duplicates` — **sin `on_conflict` PostgREST no hace upsert, hace INSERT, y devuelve 409 en silencio**.
10. Telegram al canal, un mensaje por partido capturado.

Formato del mensaje:

```js
const texto =
  "⚾ <b>Edge Hunter</b> · " + away + " @ " + home + "\n" +
  "Polymarket  " + ml_away + " / " + ml_home + "  ·  libro " + bid + "/" + ask +
  "  ·  spread " + spread.toFixed(2) + "%\n" +
  (edge != null ? "Modelo      " + prob.toFixed(3) + "  ·  edge " + (edge > 0 ? "+" : "") + edge.toFixed(1) + "%\n" : "") +
  "Decisión    " + (d.apostar ? "APOSTARÍA" : "PAPEL") + ": " + d.motivo;
```

- [ ] **Step 2: Escribir el script de despliegue**

Copiar `deploy_lynx_salud_diaria.js` y cambiar: nombre `EDGE_HUNTER_POLYMARKET`, trigger `{ field: "minutes", minutesInterval: 10 }`, webhook `edge-hunter`, y **añadir la incrustación de la lógica**: leer `edge_hunter_logica.js`, quitarle la línea `module.exports = ...` y sustituir el marcador `// <<<LOGICA>>>`. Las credenciales se inyectan igual que allí (leídas de los nodos vivos de n8n), y `__TG_EDGE__` se toma de una constante del script con el chat de admin hasta que el usuario dé el canal.

- [ ] **Step 3: Verificar la sintaxis antes de subirlo**

```bash
node -e "const s=require('fs').readFileSync('D:/Milb/nodo_edge_hunter.js','utf8');new Function('return (async()=>{'+s+'})')" && echo "sintaxis OK"
```

Expected: `sintaxis OK`

---

### Task 4: Desplegar y verificar en vivo

- [ ] **Step 1: Desplegar**

```bash
node D:/Milb/deploy_edge_hunter.js
```

Expected: `creado: <id>` y `activado: si`.

- [ ] **Step 2: Lanzar una pasada a mano**

```bash
curl -s "https://n8n-n8n.0zhp4h.easypanel.host/webhook/edge-hunter"
```

Expected: JSON con `partidos_mirados`, `lineups_completos`, `capturados`, `sin_mercado`.

- [ ] **Step 3: Comprobar contra la tabla**

`GET /rest/v1/edge_hunter_snapshots?select=slug,encontrado,ml_away,spread_pct,edge_pct,decision&order=captured_at.desc&limit=10`

Expected: filas con `encontrado=true`, `spread_pct` entre ~0,5 % y ~3 %, y `decision` explicando por qué no se apuesta (con la config apagada debe decir *"sin condiciones configuradas"*).

⚠️ **Si `spread_pct` sale nulo en todas**, el libro no se está leyendo: mirar `clobTokenIds`.
⚠️ **Si `encontrado=false` en todas**, el mapa de equipos o el formato del slug está mal — el slug queda guardado, así que se ve al momento cuál se intentó.

- [ ] **Step 4: Comprobar que no se ha tocado nada de lo viejo**

```bash
cd D:/Milb/autopicks_v2 && git status --short
```

Expected: sin cambios en `app/`. Y en n8n, los 27 workflows anteriores siguen activos: el nuevo es el 28.

---

### Task 5: Documentar

- [ ] **Step 1: Sección fechada en `CLAUDE.md`**

Qué es Edge Hunter, por qué es una línea aparte, qué tablas usa, y **el aviso de que la fase B no existe hasta que el usuario dé condiciones y cantidades**. Incluir el dato que la motiva (spread ~1,45 % medido frente al 5,26 % de vig de bet365) y el aviso que tiene que viajar con él: **MLB va a −5,2 % de yield y ningún corte de edge es distinguible de cero**.

- [ ] **Step 2: Bloque vivo**

Esto toca el bloqueo nº2 ("en qué casa se apuesta"), que el bloque vivo lista como bloqueado. Añadir que hay una línea midiendo precios alternativos, sin cambiar el estado del bloqueo: medir no es haber decidido.

- [ ] **Step 3: Tabla de archivos de referencia**

Añadir `edge_hunter_logica.js`, `test_edge_hunter_logica.js`, `nodo_edge_hunter.js`, `deploy_edge_hunter.js` y `deploy_edge_hunter_tablas.js`.

---

## Lo que este plan NO hace

- **No envía ni una orden.** La fase B es un plan aparte y necesita las condiciones y cantidades del usuario, además de una semana de papel cuadrada.
- No toca `autopicks_v2` ni ninguno de los 27 workflows.
- No captura el cierre ni ninguna liga que no sea MLB.
