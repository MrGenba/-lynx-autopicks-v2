# Cuotas de Polymarket para MLB al completarse el lineup

**Fecha**: 2026-09-15
**Estado**: diseño aprobado, pendiente de plan de implementación
**Encargo del usuario**: *"quiero que en MLB saques las cuotas de polymarket cuando tengas los
lineup completos"*

---

## Por qué esto importa más de lo que parece

El proyecto tiene identificado desde el 2026-09-10 que **su palanca más grande no es el modelo, es
el precio**: con el mismo acierto, las mismas apuestas pasan de **+5,5 % a +12,5 % de yield** solo
cambiando de un libro al 9,3 % de vig a uno al 2,5 %. Nuestro vig medido en MLB con bet365 es
**5,26 %**.

Medido el 2026-09-15 contra la API de Gamma, los mercados de MLB de Polymarket publican precios que
**suman 1.000 exacto**:

| Partido (15-sep) | Precios | Liquidez |
|---|---|---|
| Dodgers vs Reds | 0.685 / 0.315 | 269.859 $ |
| White Sox vs Guardians | 0.425 / 0.575 | 353.933 $ |
| Brewers vs Pirates | 0.665 / 0.335 | 345.381 $ |
| Phillies vs Nationals | 0.655 / 0.345 | 248.762 $ |
| Tigers vs Blue Jays | 0.435 / 0.565 | 252.938 $ |

⚠️ **El precio publicado NO es el coste.** En un libro de órdenes el peaje está en el *spread* entre
el mejor bid y el mejor ask, y Gamma no lo muestra. **Que sumen 1.000 no demuestra que el vig sea
cero**: es la razón por la que este diseño captura también el libro del CLOB, y por la que la fase 2
no se desbloquea sin esa medición. Cualquier conclusión sobre "cuánto nos ahorramos" antes de tener
el spread medido es exactamente el tipo de afirmación que este proyecto ya ha tenido que retirar dos
veces por ruido.

## Alcance

**Fase 1 — medir, no publicar.** La captura no toca el motor, ni el edge, ni lo que se publica. Es
telemetría comparable con lo que ya tenemos de bet365.

**Fase 2 — conectar al motor**, solo cuando se cumplan **las dos** condiciones fijadas por
adelantado:

1. **Spread real medido** sobre el libro del CLOB (mejor bid/ask), no sobre el precio publicado.
2. **≥ 200 partidos capturados.**

Es el mismo listón que el proyecto ya fijó para el CLV, y está puesto aquí a propósito para no
repetir el error documentado en `CLAUDE.md` de decidir con n=14.

**Fuera de alcance en las dos fases**: operar en Polymarket (no se firma nada, no se envía ninguna
orden, no se toca la `CLOB_API_KEY`), y cualquier liga que no sea MLB.

## Arquitectura

### Dónde corre

En el contenedor **`autopicks_v2`**, módulo nuevo `app/polymarket.py`.

Alternativas descartadas y por qué:

- **La box `polymarket/flow-alerts`** (que ya tiene cliente propio para las tres APIs): **no expone
  ni puertos ni dominios**, así que habría que abrirle una API y meter un servicio más en el camino
  crítico de los picks. Se reaprovecha su *conocimiento* (endpoints, el detalle de que los deportes
  americanos llevan `game_start_time` en el CLOB), no su proceso.
- **Un workflow de n8n sondeando cada X minutos**: no está atado al lineup, que es justo el disparo
  que pidió el usuario, y duplicaría la lógica de saber cuándo el lineup está completo.

### Disparo

En la rama de **Gate B / `full_lineup` de MLB** (`sport_id=1`), una llamada a
`capturar_al_lineup(ctx, game_pk, away, home, game_date)`.

**Envuelta en try/except sin excepción.** Es telemetría: un fallo de Polymarket no puede tumbar el
pipeline de picks. El proyecto ya pagó esto tres veces (17 días de apagón de NPB, el clima de CPBL,
`predictions_log`), y la regla escrita es: *lo que va DESPUÉS del trabajo útil no puede poder
tumbarlo*.

### Encontrar el mercado

Slug `mlb-<visitante>-<local>-<AAAA-MM-DD>` contra `GET gamma-api.polymarket.com/events?slug=...`.

Dos trampas identificadas antes de escribir código:

1. **La fecha del slug es la americana del partido**, no la UTC. Se toma de `mlb_games.game_date`,
   que ya es la fecha oficial. Calcularla desde el `datetime` UTC es el mismo error que acaba de
   costar el experimento de los abridores (ver `CLAUDE.md`, 2026-09-15): la jornada americana cae a
   caballo de la medianoche UTC.
2. **Las abreviaturas necesitan tabla propia.** En la prueba del 15-sep casaron 5 de 6 partidos; el
   que falló fue **Athletics @ Rays**, porque los Athletics ya no son `oak`. El mapa vive en el
   módulo, con un test por cada caso raro conocido.

**Un slug que no casa NO es un error silencioso**: se escribe igualmente una fila con
`encontrado=false` y el slug intentado, de modo que la cobertura sea una cifra medible y no una
ausencia invisible. Esa es la diferencia entre "no hay datos" y "no sabemos si hay datos", que en
este proyecto ya ha escondido una pérdida parcial más de una vez.

### Qué se guarda

Tabla nueva en Supabase, **`polymarket_snapshots`**:

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | BIGSERIAL | |
| `game_pk` | BIGINT | el partido nuestro |
| `liga` | TEXT | 'MLB' de momento |
| `game_date` | DATE | fecha americana |
| `captured_at` | TIMESTAMPTZ | |
| `fase` | TEXT | `full_lineup` ahora; deja sitio a `cierre` después |
| `slug` | TEXT | el slug intentado, casara o no |
| `encontrado` | BOOLEAN | cobertura medible |
| `evento` | JSONB | **el evento entero, los 17 mercados tal cual** |
| `libro` | JSONB | mejor bid/ask de los dos tokens del moneyline |
| `ml_away`, `ml_home` | NUMERIC | derivadas, para leer sin parsear |
| `spread_pct` | NUMERIC | derivada: el coste real |

El JSON crudo es deliberado: el usuario pidió los 17 mercados y **todavía no sabemos leer 15 de
ellos**. Fijar hoy columnas para eso sería adivinar. Las derivadas cubren la lectura diaria.

`UNIQUE (game_pk, fase)` y `on_conflict` en el upsert: sin `on_conflict` explícito PostgREST
**no hace upsert, hace INSERT**, y devuelve 409 en silencio — ya documentado en este repo dos veces.

### Cómo se vigila

Una línea más en `LYNX_SALUD_DIARIA` (18:00 UTC): **capturas / partidos del día y spread mediano**.
Si la captura se cae, llega en el resumen diario sin que nadie tenga que mirar nada — que es la
regla de que la vigilancia vive en el VPS, no en el PC del usuario.

## Tests (antes del código)

1. **Slug**: construcción normal, la excepción de Athletics, y que la fecha sea la americana aunque
   el partido empiece pasada la medianoche UTC.
2. **Aislamiento**: si la API falla, lanza o devuelve basura, `capturar_al_lineup` no propaga nada y
   el pipeline sigue.
3. **Cobertura**: un slug que no casa escribe fila con `encontrado=false`.
4. **Spread**: cálculo sobre un libro de ejemplo, incluido el caso de libro vacío (spread nulo, no
   cero — que no es lo mismo y confundirlos inventaría un coste de 0 %).

## Despliegue

1. **DDL por la Management API de Supabase** (`deploy_odds_snapshots_fase_cierre.js` es el patrón
   vivo). Ojo: el patrón viejo de DDL por un workflow temporal de n8n con nodo Postgres **ya no
   funciona** — esa credencial no existe.
2. Commit y **rebuild del contenedor**; verificar por `/version` contra `python -m app.version`.
3. Redesplegar el nodo de `LYNX_SALUD_DIARIA` con la línea nueva.

## Riesgos conocidos

- **El `startDate` de Gamma no es de fiar**: en la prueba devolvió `2026-09-09` para partidos del 15.
  Se usa nuestra hora del partido, nunca la suya.
- **Liquidez y spread pueden variar mucho por partido**: un mercado con 250.000 $ de liquidez no
  garantiza un spread estrecho en el momento de la captura. Por eso el criterio de fase 2 es el
  spread medido, no la liquidez anunciada.
- **Cobertura desconocida**: 5 de 6 en una muestra de un día no es una medición. La propia columna
  `encontrado` la convertirá en una cifra a la semana de correr.
