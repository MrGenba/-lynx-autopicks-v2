# Cuotas de Polymarket para MLB — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar el precio de Polymarket de cada partido de MLB en el momento en que se completa el lineup, como telemetría que no toca el motor.

**Architecture:** Un módulo nuevo `app/polymarket.py` en el contenedor `autopicks_v2` construye el slug del mercado (`mlb-<visitante>-<local>-<fecha americana>`), lee el evento entero de la API de Gamma y el libro de órdenes del CLOB para el moneyline, y lo guarda en una tabla nueva de Supabase. Lo llama el detector en la rama de Gate B, envuelto de forma que un fallo de Polymarket nunca pueda tumbar el pipeline de picks.

**Tech Stack:** Python 3 + httpx (ya en el contenedor), Supabase/PostgREST, pytest. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-09-15-polymarket-mlb-design.md`

## Global Constraints

- **Fase 1 no toca el motor.** Nada de lo que se escriba aquí puede alimentar `game_odds`, `*_candidates_history`, el edge, ni lo que se publica. Es telemetría.
- **No se opera en Polymarket.** Solo lecturas de endpoints públicos. No se firma ninguna orden ni se usa `CLOB_API_KEY`.
- **Solo MLB** (`sport_id=1`).
- **La captura no puede tumbar el pipeline**: todo el camino va envuelto en `try/except Exception` y nunca propaga.
- **La fecha del slug es la americana del partido** (`mlb_games.game_date`), nunca la derivada del UTC.
- **DDL antes que código.** La tabla existe antes de desplegar nada que escriba en ella: un `CHECK`/tabla ausente hace que PostgREST rechace en silencio y `guardar()` no lanza. Ya pasó con `fase='cierre'`.
- Endpoints: Gamma `https://gamma-api.polymarket.com`, CLOB `https://clob.polymarket.com`.
- Todo el código y los comentarios, en el estilo del repo: castellano, explicando **por qué**, no qué.

---

### Task 1: La tabla en Supabase (DDL primero)

**Files:**
- Create: `D:/Milb/deploy_polymarket_snapshots.js` (herramienta de despliegue, fuera del repo)

**Interfaces:**
- Consumes: nada.
- Produces: tabla `polymarket_snapshots` en Supabase con `UNIQUE (game_pk, fase)`.

- [ ] **Step 1: Escribir el script de DDL**

Copiar el patrón vivo de `D:/Milb/deploy_odds_snapshots_fase_cierre.js` (Management API de Supabase; el patrón viejo de workflow temporal de n8n con nodo Postgres **ya no funciona**, esa credencial no existe). El SQL:

```sql
CREATE TABLE IF NOT EXISTS polymarket_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  game_pk     BIGINT      NOT NULL,
  liga        TEXT        NOT NULL DEFAULT 'MLB',
  game_date   DATE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fase        TEXT        NOT NULL DEFAULT 'full_lineup',
  slug        TEXT        NOT NULL,
  encontrado  BOOLEAN     NOT NULL DEFAULT false,
  evento      JSONB,
  libro       JSONB,
  ml_away     NUMERIC,
  ml_home     NUMERIC,
  spread_pct  NUMERIC,
  UNIQUE (game_pk, fase)
);
CREATE INDEX IF NOT EXISTS polymarket_snapshots_captured_idx
  ON polymarket_snapshots (captured_at DESC);

COMMENT ON TABLE polymarket_snapshots IS
  'Foto del mercado de Polymarket al completarse el lineup (2026-09-15). Telemetria: NO alimenta el motor. `evento` guarda los 17 mercados tal cual porque todavia no sabemos leer 15 de ellos; `libro` guarda el mejor bid/ask del moneyline, que es donde esta el coste real.';

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Ejecutarlo y verificar que la tabla responde**

```bash
node D:/Milb/deploy_polymarket_snapshots.js
```

Verificar con una lectura por PostgREST: `GET /rest/v1/polymarket_snapshots?select=id&limit=1` debe devolver `200` y `[]`, no `PGRST205`.

- [ ] **Step 3: Sin commit**

`D:/Milb` no es un repositorio git, así que este script no se commitea: queda anotado en `CLAUDE.md` en la tarea 7, junto a los demás `deploy_*.js`.

---

### Task 2: Slug del mercado

**Files:**
- Create: `app/polymarket.py`
- Test: `tests/test_polymarket.py`

**Interfaces:**
- Consumes: nada.
- Produces: `CODIGO_EQUIPO: dict[str, str]`, `fecha_americana(game_datetime_utc: datetime) -> str`, `construir_slug(away_team_name: str, home_team_name: str, game_date: str | datetime.date) -> str | None`.

- [ ] **Step 1: Escribir los tests que fallan**

```python
"""El mercado de Polymarket se localiza por un slug predecible. Verificado el 2026-09-15 contra
la API de Gamma: de los 6 partidos de esa noche, los 6 casaron."""
import datetime as dt

import pytest

from app.polymarket import CODIGO_EQUIPO, construir_slug, fecha_americana


def test_slug_normal():
    assert construir_slug("Los Angeles Dodgers", "Cincinnati Reds", "2026-09-15") == \
        "mlb-lad-cin-2026-09-15"


def test_los_athletics_siguen_siendo_oak():
    """Se mudaron de Oakland y el nombre oficial ya no dice la ciudad, pero Polymarket mantiene
    `oak`. Verificado en vivo: mlb-oak-tb-2026-09-15 -> 'Athletics vs. Tampa Bay Rays'."""
    assert construir_slug("Athletics", "Tampa Bay Rays", "2026-09-15") == "mlb-oak-tb-2026-09-15"


def test_acepta_date_ademas_de_texto():
    assert construir_slug("Detroit Tigers", "Toronto Blue Jays", dt.date(2026, 9, 15)) == \
        "mlb-det-tor-2026-09-15"


def test_equipo_desconocido_devuelve_none_en_vez_de_inventar():
    """Un slug inventado devolveria 404 y lo registrariamos como 'no encontrado', escondiendo que
    lo que falta es una entrada en el mapa. Son dos fallos distintos y no deben confundirse."""
    assert construir_slug("Yakult Swallows", "Cincinnati Reds", "2026-09-15") is None


def test_el_mapa_cubre_las_30_franquicias():
    assert len(CODIGO_EQUIPO) == 30


def test_la_fecha_es_la_americana_no_la_utc():
    """Un partido a las 01:45 UTC del 16-sep es la jornada americana del 15. Usar la fecha UTC
    es el error que acaba de costar el experimento de los abridores (CLAUDE.md, 2026-09-15)."""
    tarde = dt.datetime(2026, 9, 16, 1, 45, tzinfo=dt.timezone.utc)
    assert fecha_americana(tarde) == "2026-09-15"


def test_la_fecha_americana_de_un_partido_de_tarde_no_cambia():
    pronto = dt.datetime(2026, 9, 15, 22, 5, tzinfo=dt.timezone.utc)
    assert fecha_americana(pronto) == "2026-09-15"
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `cd D:/Milb/autopicks_v2 && python -m pytest tests/test_polymarket.py -q`
Expected: FAIL con `ModuleNotFoundError: No module named 'app.polymarket'`

- [ ] **Step 3: Implementar el mínimo**

```python
"""Foto del mercado de Polymarket al completarse el lineup de un partido de MLB.

POR QUE (2026-09-15, encargo del usuario): la palanca mas grande medida en este proyecto no es el
modelo, es el precio -- con el mismo acierto, pasar de un libro al 9,3% de vig a uno al 2,5% mueve
el yield de +5,5% a +12,5%. En MLB nuestro vig con bet365 es 5,26%. Los mercados de MLB de
Polymarket publican precios que suman 1.000 exacto, pero **eso no es el coste**: el peaje esta en el
spread del libro, y por eso aqui se captura tambien el mejor bid/ask, no solo el precio publicado.

FASE 1: esto es telemetria. NO alimenta el motor, NO cambia el edge, NO publica.
"""
import datetime as dt
import logging
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

# Nombre oficial de StatsAPI (el que guarda `mlb_games`) -> codigo que usa Polymarket en el slug.
# Verificados en vivo el 2026-09-15: lad, cin, cws, cle, mil, pit, phi, wsh, det, tor, oak, tb.
# El resto son la abreviatura estandar; si alguno falla, la columna `encontrado` de la tabla lo
# delatara en dias -- por eso se registra el slug intentado en vez de descartar en silencio.
CODIGO_EQUIPO = {
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
}


# La fecha oficial de un partido de MLB es la LOCAL del estadio, y en la practica coincide con
# la del este de EEUU en el primer lanzamiento: ninguno empieza tan tarde como para cambiar de
# dia en ET. Derivarla asi evita una consulta a `mlb_games` dentro del detector.
ET = ZoneInfo("America/New_York")


def fecha_americana(game_datetime_utc: dt.datetime) -> str:
    """AAAA-MM-DD de la jornada americana. NO vale la fecha UTC: la jornada cae a caballo de la
    medianoche UTC y ese error ya se pago una vez (ver CLAUDE.md, 2026-09-15)."""
    return game_datetime_utc.astimezone(ET).date().isoformat()


def construir_slug(away_team_name: str, home_team_name: str, game_date) -> Optional[str]:
    """`mlb-<visitante>-<local>-<AAAA-MM-DD>`, con la fecha AMERICANA del partido.

    La fecha NO se deriva del datetime UTC: la jornada americana cae a caballo de la medianoche
    UTC y hacerlo asi es el error que acaba de costar el experimento de los abridores
    (ver CLAUDE.md, 2026-09-15). `mlb_games.game_date` ya es la fecha oficial.

    Devuelve None si algun equipo no esta en el mapa -- inventar un slug lo convertiria en un 404
    indistinguible de "el mercado no existe", y son dos fallos distintos.
    """
    a = CODIGO_EQUIPO.get((away_team_name or "").strip())
    h = CODIGO_EQUIPO.get((home_team_name or "").strip())
    if not a or not h:
        logger.warning("polymarket: equipo sin codigo (%r @ %r)", away_team_name, home_team_name)
        return None
    fecha = game_date.isoformat()[:10] if hasattr(game_date, "isoformat") else str(game_date)[:10]
    return f"mlb-{a}-{h}-{fecha}"
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `python -m pytest tests/test_polymarket.py -q`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add app/polymarket.py tests/test_polymarket.py
git commit -m "Polymarket: slug del mercado de un partido de MLB"
```

---

### Task 3: El spread del libro

**Files:**
- Modify: `app/polymarket.py`
- Test: `tests/test_polymarket.py`

**Interfaces:**
- Consumes: nada.
- Produces: `mejor_bid_ask(libro: dict) -> tuple[float | None, float | None]`, `spread_pct(bid: float | None, ask: float | None) -> float | None`.

- [ ] **Step 1: Escribir los tests que fallan**

```python
from app.polymarket import mejor_bid_ask, spread_pct

# Libro real del CLOB, 2026-09-15, Dodgers vs Reds (recortado): bids y asks vienen como listas de
# {"price","size"} y el mejor de cada lado NO esta en una posicion fija -- por eso se calcula por
# valor (max de bids, min de asks) y no por indice.
LIBRO = {
    "bids": [{"price": "0.61", "size": "100"}, {"price": "0.68", "size": "54366.69"}],
    "asks": [{"price": "0.75", "size": "200"}, {"price": "0.69", "size": "38907.44"}],
}


def test_mejor_bid_y_ask_se_eligen_por_valor_no_por_posicion():
    assert mejor_bid_ask(LIBRO) == (0.68, 0.69)


def test_spread_en_porcentaje_sobre_el_punto_medio():
    # (0.69 - 0.68) / 0.685 = 1,46%
    assert spread_pct(0.68, 0.69) == pytest.approx(1.4599, abs=0.001)


def test_libro_vacio_da_none_y_no_cero():
    """Cero significaria 'mercado sin coste', que es justo la conclusion que este trabajo tiene que
    demostrar. Un libro vacio es ausencia de dato, no un coste de 0%."""
    assert mejor_bid_ask({"bids": [], "asks": []}) == (None, None)
    assert spread_pct(None, None) is None
    assert spread_pct(0.5, None) is None
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `python -m pytest tests/test_polymarket.py -q`
Expected: FAIL con `ImportError: cannot import name 'mejor_bid_ask'`

- [ ] **Step 3: Implementar**

```python
def mejor_bid_ask(libro: dict):
    """El mejor bid es el precio mas ALTO que alguien paga; el mejor ask, el mas BAJO que alguien
    pide. Se calcula por valor a proposito: el orden de las listas que devuelve el CLOB no esta
    documentado y apoyarse en el indice es una bomba de relojeria."""
    def _precios(lado):
        out = []
        for nivel in (libro or {}).get(lado) or []:
            try:
                out.append(float(nivel["price"]))
            except (KeyError, TypeError, ValueError):
                continue
        return out
    bids, asks = _precios("bids"), _precios("asks")
    return (max(bids) if bids else None, min(asks) if asks else None)


def spread_pct(bid, ask):
    """Coste real en porcentaje sobre el punto medio. None si falta un lado -- ver el test."""
    if bid is None or ask is None:
        return None
    medio = (bid + ask) / 2
    if medio <= 0:
        return None
    return (ask - bid) / medio * 100
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `python -m pytest tests/test_polymarket.py -q`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add app/polymarket.py tests/test_polymarket.py
git commit -m "Polymarket: mejor bid/ask y spread del libro"
```

---

### Task 4: Captura y guardado, aislados del pipeline

**Files:**
- Modify: `app/polymarket.py`
- Test: `tests/test_polymarket.py`

**Interfaces:**
- Consumes: `construir_slug`, `mejor_bid_ask`, `spread_pct`.
- Produces: `async capturar_al_lineup(ctx, game_pk: int, away: str, home: str, game_date) -> None`.

El `ctx` es el `PipelineContext` del proyecto: se usan `ctx.http_client` (httpx), `ctx.supabase.base_url` y `ctx.supabase.headers`, exactamente como en `app/odds_snapshots.py::guardar`.

- [ ] **Step 1: Escribir los tests que fallan**

```python
import asyncio
import types

class _FakeResp:
    def __init__(self, data, status=200):
        self._data, self.status_code, self.text = data, status, "ok"
    def json(self):
        return self._data

class _FakeClient:
    """Devuelve por URL. Guarda lo que se le pide para poder comprobarlo."""
    def __init__(self, rutas):
        self.rutas, self.posts = rutas, []
    async def get(self, url, **kw):
        for clave, valor in self.rutas.items():
            if clave in url:
                if isinstance(valor, Exception):
                    raise valor
                return _FakeResp(valor)
        return _FakeResp([], status=404)
    async def post(self, url, **kw):
        self.posts.append({"url": url, "json": kw.get("json")})
        return _FakeResp({}, status=201)

EVENTO = [{
    "title": "Los Angeles Dodgers vs. Cincinnati Reds",
    "markets": [{
        "question": "Los Angeles Dodgers vs. Cincinnati Reds",
        "outcomes": '["Los Angeles Dodgers", "Cincinnati Reds"]',
        "outcomePrices": '["0.685", "0.315"]',
        "clobTokenIds": '["111", "222"]',
    }, {"question": "Spread: Los Angeles Dodgers (-1.5)"}],
}]
LIBRO_OK = {"bids": [{"price": "0.68", "size": "10"}], "asks": [{"price": "0.69", "size": "10"}]}


def _ctx(cliente):
    return types.SimpleNamespace(
        http_client=cliente,
        supabase=types.SimpleNamespace(base_url="https://supa.test", headers={"apikey": "x"}),
    )


# El repo corre con `asyncio_mode = strict` y sus tests async se escriben con `asyncio.run`
# dentro de un test sincrono (ver tests/test_clv_cierre.py). Se sigue ese patron, no el marcador.
def test_guarda_el_evento_entero_y_el_spread():
    cli = _FakeClient({"/events": EVENTO, "/book": LIBRO_OK})
    asyncio.run(capturar_al_lineup(_ctx(cli), 824466, "Los Angeles Dodgers", "Cincinnati Reds", "2026-09-15"))
    fila = cli.posts[0]["json"][0]
    assert fila["slug"] == "mlb-lad-cin-2026-09-15"
    assert fila["encontrado"] is True
    assert fila["ml_away"] == 0.685 and fila["ml_home"] == 0.315
    assert fila["spread_pct"] == pytest.approx(1.4599, abs=0.001)
    assert len(fila["evento"]["markets"]) == 2, "se guardan TODOS los mercados, no solo el moneyline"
    assert "on_conflict=game_pk,fase" in cli.posts[0]["url"], \
        "sin on_conflict PostgREST no hace upsert, hace INSERT, y devuelve 409 en silencio"


def test_mercado_inexistente_deja_fila_con_encontrado_false():
    """La cobertura tiene que ser una cifra medible, no una ausencia invisible."""
    cli = _FakeClient({"/events": []})
    asyncio.run(capturar_al_lineup(_ctx(cli), 1, "Los Angeles Dodgers", "Cincinnati Reds", "2026-09-15"))
    fila = cli.posts[0]["json"][0]
    assert fila["encontrado"] is False and fila["evento"] is None


def test_un_fallo_de_polymarket_no_propaga_nunca():
    """Es telemetria: no puede tumbar el pipeline de picks. El proyecto ya pago esto tres veces."""
    cli = _FakeClient({"/events": RuntimeError("boom")})
    asyncio.run(capturar_al_lineup(_ctx(cli), 1, "Los Angeles Dodgers", "Cincinnati Reds", "2026-09-15"))


def test_equipo_sin_codigo_no_escribe_ni_revienta():
    cli = _FakeClient({})
    asyncio.run(capturar_al_lineup(_ctx(cli), 1, "Yakult Swallows", "Cincinnati Reds", "2026-09-15"))
    assert cli.posts == []
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `python -m pytest tests/test_polymarket.py -q`
Expected: FAIL con `ImportError: cannot import name 'capturar_al_lineup'`

- [ ] **Step 3: Implementar**

```python
import json

TABLA = "polymarket_snapshots"


def _moneyline(evento: dict) -> Optional[dict]:
    """De los 17 mercados del evento, el moneyline es el que se llama igual que el propio evento.
    Los demas llevan sufijo (`Spread: ...`, `...: Over 8.5`, `1st 5 Innings...`)."""
    titulo = (evento.get("title") or "").strip()
    for m in evento.get("markets") or []:
        if (m.get("question") or "").strip() == titulo:
            return m
    return None


async def capturar_al_lineup(ctx, game_pk: int, away: str, home: str, game_date) -> None:
    """Una foto por partido al confirmarse el lineup. Nunca lanza: es telemetria."""
    try:
        slug = construir_slug(away, home, game_date)
        if not slug:
            return
        fila = {"game_pk": game_pk, "liga": "MLB", "game_date": str(game_date)[:10],
                "fase": "full_lineup", "slug": slug, "encontrado": False}
        try:
            r = await ctx.http_client.get(f"{GAMMA}/events", params={"slug": slug}, timeout=15.0)
            eventos = r.json() if r.status_code < 300 else []
        except Exception:
            logger.exception("polymarket: fallo pidiendo el evento %s", slug)
            eventos = []

        evento = (eventos or [None])[0]
        if evento:
            fila["encontrado"] = True
            fila["evento"] = evento
            ml = _moneyline(evento)
            if ml:
                try:
                    precios = json.loads(ml.get("outcomePrices") or "[]")
                    fila["ml_away"] = float(precios[0])
                    fila["ml_home"] = float(precios[1])
                except (ValueError, IndexError, TypeError):
                    logger.warning("polymarket: precios ilegibles en %s", slug)
                try:
                    tokens = json.loads(ml.get("clobTokenIds") or "[]")
                    if tokens:
                        b = await ctx.http_client.get(f"{CLOB}/book",
                                                      params={"token_id": tokens[0]}, timeout=15.0)
                        libro = b.json() if b.status_code < 300 else {}
                        fila["libro"] = libro
                        bid, ask = mejor_bid_ask(libro)
                        fila["spread_pct"] = spread_pct(bid, ask)
                except Exception:
                    logger.exception("polymarket: fallo leyendo el libro de %s", slug)

        # on_conflict explicito: sin el, PostgREST NO hace upsert -- hace INSERT y devuelve 409 en
        # silencio. Documentado dos veces en este repo.
        resp = await ctx.http_client.post(
            f"{ctx.supabase.base_url}/rest/v1/{TABLA}?on_conflict=game_pk,fase",
            headers={**ctx.supabase.headers, "Content-Type": "application/json",
                     "Prefer": "return=minimal,resolution=merge-duplicates"},
            json=[fila], timeout=15.0,
        )
        if resp.status_code >= 300:
            logger.warning("polymarket: %s al guardar game_pk=%s -- %s",
                           resp.status_code, game_pk, resp.text[:200])
    except Exception:
        logger.exception("polymarket: captura fallida game_pk=%s (no afecta al pipeline)", game_pk)
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `python -m pytest tests/test_polymarket.py -q`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add app/polymarket.py tests/test_polymarket.py
git commit -m "Polymarket: captura del evento y del libro, aislada del pipeline"
```

---

### Task 5: Engancharlo al Gate B

**Files:**
- Modify: `app/detector.py` (import arriba; llamada en el bloque de Gate B, `app/detector.py:396-399`)

**Interfaces:**
- Consumes: `capturar_al_lineup`.
- Produces: nada nuevo.

- [ ] **Step 1: Añadir el import**

Junto a los demás imports de `app`:

```python
from app.polymarket import capturar_al_lineup, fecha_americana
```

- [ ] **Step 2: Llamar en el momento en que se confirma el lineup**

En el bloque `if away_lineup.published and home_lineup.published:`, justo después de
`first_time = await mark_lineup_confirmed(ctx.pool, sport_id, g.game_pk)`:

```python
                    # Foto del mercado de Polymarket, SOLO MLB y solo la primera vez que se
                    # confirma el lineup (si no, se repetiria en cada tick de 180 s). Telemetria de
                    # fase 1: no toca el motor ni lo que se publica. `create_task` para no meter la
                    # latencia de dos APIs externas en el camino del pick, y la propia funcion no
                    # lanza nunca.
                    if sport_id == 1 and first_time:
                        asyncio.create_task(capturar_al_lineup(
                            ctx, g.game_pk, g.away_team_name, g.home_team_name,
                            fecha_americana(game_dt),
                        ))
```

**La fecha sale de `fecha_americana(game_dt)`, NO de la variable `today`** de `detector_tick`: esa es la fecha **UTC**, y para los partidos que empiezan después de las 00:00 UTC son días distintos. `game_dt` es el `datetime` con zona que el propio bloque ya tiene calculado unas líneas más arriba.

- [ ] **Step 3: Ejecutar la suite entera**

Run: `python -m pytest tests/ -q`
Expected: PASS, sin regresiones (la cuenta debe subir en 14 respecto a la anterior)

- [ ] **Step 4: Commit**

```bash
git add app/detector.py
git commit -m "Gate B de MLB: dispara la foto de Polymarket al confirmarse el lineup"
```

---

### Task 6: Desplegar y verificar en vivo

**Files:**
- Modify: ninguno (despliegue)

- [ ] **Step 1: Calcular la huella esperada**

```bash
cd D:/Milb/autopicks_v2 && python -m app.version
```

- [ ] **Step 2: Push y rebuild**

```bash
git push origin master
node D:/Milb/_deploy_autopicks_app.js
```

El `deployService` devuelve timeout de cliente aunque el build vaya bien: **no es un fallo**.

- [ ] **Step 3: Verificar por `/version`**

```bash
curl -s https://autopicks-scrape.0zhp4h.easypanel.host/version
```

Expected: la `huella` del paso 1.

- [ ] **Step 4: Verificar que escribe de verdad**

Esa misma tarde, cuando se confirmen lineups de MLB:

```
GET /rest/v1/polymarket_snapshots?select=slug,encontrado,ml_away,ml_home,spread_pct&order=captured_at.desc&limit=10
```

Expected: filas con `encontrado=true` y `spread_pct` entre ~0,5 % y ~3 %. **Si sale `spread_pct` nulo en todas, el libro no se está leyendo** y hay que mirar `clobTokenIds`.

---

### Task 7: Que la vigilancia lo cuente sola

**Files:**
- Modify: `D:/Milb/nodo_salud_diaria.js`
- Modify: `D:/Milb/CLAUDE.md` (sección fechada + bloque vivo)

- [ ] **Step 1: Añadir la línea al chequeo diario**

En `nodo_salud_diaria.js`, otro bloque `seguro(...)` que lea:

```js
// ── 6. Polymarket: cobertura y coste real ────────────────────────────────────
// Fase 1 del spec 2026-09-15: esto mide, no publica. La cobertura importa tanto como el precio,
// porque un slug que no casa es una ausencia invisible si nadie la cuenta.
const poly = await seguro(async () => {
  const filas = await supa("polymarket_snapshots",
    "select=encontrado,spread_pct&captured_at=gte." + hace24h + "&limit=500");
  const ok = filas.filter(f => f.encontrado);
  const spreads = ok.map(f => Number(f.spread_pct)).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  return { capturas: filas.length, encontrados: ok.length,
           spread_mediano: spreads.length ? spreads[Math.floor(spreads.length / 2)] : null };
}, "polymarket");
```

Y su línea en el mensaje, con ⚠️ solo si hubo capturas y ninguna casó (que es el fallo real: el mapa de equipos está mal).

- [ ] **Step 2: Desplegar el nodo**

```bash
node D:/Milb/deploy_lynx_salud_diaria.js
```

Expected: la respuesta del webhook incluye `poly` con sus tres cifras.

- [ ] **Step 3: Documentar en `CLAUDE.md`**

Sección fechada con: qué se capturó, la cobertura de los primeros días, el spread mediano medido, y **el recordatorio de que la fase 2 exige spread medido + 200 partidos**. Actualizar también el bloque vivo, porque esto toca el bloqueo nº2 ("en qué casa se apuesta"), que es una de las dos cosas que ese bloque lista como bloqueadas.

- [ ] **Step 4: Anotar los scripts nuevos**

`D:/Milb/deploy_polymarket_snapshots.js` es herramienta de despliegue y vive fuera del repo: añadirlo a la tabla de archivos de referencia de `CLAUDE.md`.

---

## Qué NO hace este plan

- No conecta nada al motor. La fase 2 es un plan aparte, y no se escribe hasta tener **spread real medido y 200 partidos**.
- No captura el cierre (`fase='cierre'`). La columna `fase` deja sitio, pero añadirlo ahora sería trabajo sin lectura que lo justifique.
- No toca ninguna liga que no sea MLB.
