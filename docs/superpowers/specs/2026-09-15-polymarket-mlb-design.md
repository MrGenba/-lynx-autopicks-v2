# Edge Hunter: línea nueva de Polymarket para MLB

**Fecha**: 2026-09-15
**Estado**: diseño aprobado; condiciones y cantidades de apuesta **pendientes de que las dé el usuario**
**Encargo del usuario**: *"quiero que en MLB saques las cuotas de polymarket cuando tengas los
lineup completos"*, y después: *"no modifiques nada de lo antiguo, esto quiero que sea una línea
nueva, quiero que me avises en el mismo canal de edge hunter, quiero que haga las apuestas
automáticas cuando se cumplan las condiciones que te diga"*.

> **Reescrito el mismo día.** La primera versión de este spec enganchaba la captura en el Gate B de
> `app/detector.py`. **Queda descartada**: el usuario pidió explícitamente no tocar nada de lo
> existente. Lo que sigue es una línea independiente que solo **lee**.

---

## Por qué esto importa

La palanca más grande medida en el proyecto no es el modelo, es el precio: con el mismo acierto, las
mismas apuestas pasan de **+5,5 % a +12,5 % de yield** cambiando de un libro al 9,3 % de vig a uno
al 2,5 %. Nuestro vig en MLB con bet365 es **5,26 %**.

Medido en vivo el 2026-09-15: los 6 partidos de esa noche tenían mercado en Polymarket, con precios
que **suman 1.000 exacto** y un libro real de **bid 0.68 / ask 0.69** en el Dodgers-Reds, o sea
**~1,45 % de spread**. Si eso aguanta con muestra, es tres veces más barato que donde apostamos hoy.

⚠️ **Y el aviso que tiene que viajar con este documento**: las auditorías del 2026-09-14 dan **MLB a
−5,2 % de yield (n=4.122)** y **ningún corte de edge —8 %, 12 % ni 18 %— distinguible de cero**. La
única señal que apuntaba a algo se apagó (t = −1,67 → −0,81 en cuatro lecturas). **Automatizar
apuestas sobre el edge que produce el motor hoy es automatizar pérdidas.** Si esta línea llega a
apostar, tiene que ser porque sus condiciones explotan algo distinto —el precio, no el modelo— y eso
hay que demostrarlo con sus propios datos antes de enviar una orden.

## Principio rector: no se toca nada de lo viejo

- **Cero modificaciones** en `autopicks_v2`, en sus 27 workflows de n8n, en sus tablas o en sus
  picks. Esta línea **solo lee**.
- No comparte proceso, ni despliegue, ni cadena de fallos con el sistema de picks. Si Edge Hunter se
  cae, Lynx Hunter no se entera.
- Tabla propia (`edge_hunter_*`), canal propio de Telegram, ciclo propio.
- Tampoco depende de la tabla `lineup_watch` del Lineup Watcher, aunque exista y tenga los datos:
  eso acoplaría la línea nueva a la cadencia de la vieja. Edge Hunter detecta el lineup por su
  cuenta contra StatsAPI.

## Fases

| Fase | Qué hace | Qué la desbloquea |
|---|---|---|
| **A** | Detecta lineup completo, captura Polymarket, avisa al canal, y evalúa las condiciones **en modo papel** (registra "habría apostado X" sin enviar nada) | Ya: no necesita nada del usuario salvo el chat id |
| **B** | Envía órdenes reales al CLOB | Condiciones y cantidades del usuario **+** una semana de modo papel cuadrada **+** los topes de seguridad activos |

**Este spec cubre la fase A completa y el diseño de la B.** Los números de la B (umbrales, stakes,
límites) los dará el usuario y entran como **configuración**, no como código.

## Arquitectura de la fase A

### Dónde corre

**Un workflow nuevo de n8n**, `EDGE_HUNTER_POLYMARKET`, cada 10 minutos. Es la infraestructura que
ya está en el VPS, no hay que montar nada, y añadir un workflow no modifica ninguno de los 27
existentes.

Alternativas descartadas:
- **Meterlo en `autopicks_v2`**: viola el principio de arriba.
- **Un servicio nuevo en EasyPanel**: es lo que hará falta para la fase B (firmar órdenes necesita
  `py-clob-client` o `@polymarket/clob-client`, que no se pueden cargar en un nodo Code de n8n),
  pero montar repo + imagen + servicio para la fase A es infraestructura antes de tener la
  medición que la justifique.
- **La box `polymarket/flow-alerts`**: es código de junio que ya corre; tocarlo es exactamente lo
  que el usuario ha pedido no hacer.

### Ciclo, cada 10 minutos

1. **Partidos de hoy**: `GET statsapi.mlb.com/api/v1/schedule?sportId=1&date=<hoy ET>`. Se queda con
   los que empiezan en las próximas 6 h y aún no han empezado.
2. **¿Lineup completo?**: `GET /game/<pk>/boxscore` y comprobar `battingOrder >= 9` en los dos
   equipos — el mismo criterio que usa el sistema viejo, reimplementado, no importado.
3. **Si está completo y este partido no se ha capturado aún**: se pide a Gamma el evento por slug
   `mlb-<visitante>-<local>-<fecha ET>` y al CLOB el libro de los dos tokens del moneyline.
4. **Se guarda** en `edge_hunter_snapshots` (tabla propia).
5. **Se avisa** al canal de edge hunter con el precio, el spread y la comparación con nuestra
   probabilidad si la hay.
6. **Se evalúan las condiciones en modo papel** y se registra la apuesta hipotética.

**La fecha del slug es la americana (ET)**, nunca la UTC: la jornada de MLB cae a caballo de la
medianoche UTC y ese error ya invalidó el experimento de los abridores el mismo día que se escribe
esto.

### Qué se guarda

Tabla **`edge_hunter_snapshots`**: `game_pk`, `game_date`, `captured_at`, `slug`, `encontrado`,
`evento` (JSONB, **los 17 mercados tal cual**), `libro` (JSONB, bid/ask del moneyline), `ml_away`,
`ml_home`, `spread_pct`, `prob_modelo_away` (si la tenemos), `edge_pct`, `decision` (texto),
`papel` (boolean). `UNIQUE (game_pk)`.

La probabilidad del modelo se **lee** de `predictions_log` (que ya escribe el sistema viejo para
todos los partidos del día, tenga cuotas o no). Si no hay fila, se guarda igual con `edge_pct` nulo:
la captura del precio vale por sí sola.

### El aviso

Al canal de edge hunter, un mensaje por partido cuando se captura:

```
⚾ Edge Hunter · Dodgers @ Reds
Polymarket  LAD 0.685 / CIN 0.315  ·  libro 0.68/0.69  ·  spread 1,45%
Modelo      LAD 0.71                ·  edge +3,7%
Decisión    PAPEL: habría apostado — (sin condiciones configuradas)
```

## Diseño de la fase B (apuestas reales)

**No se implementa hasta tener las condiciones**, pero el diseño se fija ahora para que la fase A no
haya que rehacerla.

### Dónde

Servicio nuevo en EasyPanel (proyecto `polymarket`, servicio `edge-hunter`), con su propio
repositorio. Motivo: firmar una orden del CLOB requiere una librería que un nodo Code de n8n no
puede cargar, y la clave privada del monedero no debe vivir en n8n junto a 27 workflows ajenos.

### Las condiciones, como configuración

Las dará el usuario y entran como una tabla `edge_hunter_config` de un solo registro, **no como
código**, para poder cambiarlas sin desplegar:

| Campo | Qué es |
|---|---|
| `activo` | interruptor maestro; si es `false`, todo sigue en papel |
| `edge_minimo` | edge mínimo contra el precio de Polymarket |
| `spread_maximo` | si el libro está más ancho que esto, no se apuesta |
| `liquidez_minima` | tamaño mínimo en el mejor precio |
| `stake` | cantidad por apuesta |
| `max_diario` | exposición máxima en 24 h |
| `max_abiertas` | posiciones abiertas simultáneas |
| `mercados` | lista blanca de mercados permitidos |

### Las cuatro salvaguardas, no negociables

1. **Modo papel primero.** Mismo código, misma decisión, misma alerta; sin enviar orden. Se levanta
   solo cuando una semana de papel cuadra.
2. **Topes duros.** Stake por apuesta, exposición diaria y posiciones abiertas. Al superarse: no
   apuesta y avisa.
3. **Interruptor de parada** accionable desde Telegram, respetado en el ciclo siguiente.
4. **Se escribe antes de enviar.** La fila de la apuesta se guarda *antes* de firmar la orden, para
   que no pueda existir una orden sin registro. Una orden enviada no se puede deshacer; una fila
   huérfana sí se limpia.

### Lo que esta línea NO hará nunca

- Retirar fondos, mover el monedero o firmar nada que no sea una orden dentro de los topes.
- Apostar en una liga que no sea MLB.
- Tocar los picks, el motor ni las tablas del sistema viejo.

## Riesgos conocidos

- **El `startDate` de Gamma no es de fiar** (devolvió `2026-09-09` para partidos del 15): se usa
  siempre nuestra hora.
- **Cobertura no medida**: 6 de 6 en una noche no es una medición. La columna `encontrado` la
  convierte en cifra en una semana.
- **Liquidez ≠ spread estrecho**: 250.000 $ anunciados no garantizan un buen precio en el momento de
  apostar. Por eso `spread_maximo` y `liquidez_minima` son condiciones de entrada, no adornos.
- **El modelo no tiene ventaja demostrada hoy.** Ver el aviso de arriba. La fase B solo tiene sentido
  si sus propios datos muestran otra cosa.
