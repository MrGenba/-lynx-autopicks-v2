# Lynx Hunter — Auto-Picks v2

Sistema de picks automáticos de béisbol (MLB, MiLB AAA, LMB), **paralelo** al pipeline de
producción en n8n de Lynx Hunter — no lo reemplaza, no lo toca, no escribe en sus tablas.

## Qué hace

1. Un detector interno (cada 180s) vigila el calendario del día en las 3 ligas via MLB Stats
   API, y detecta dos "gates" por partido:
   - **Gate A**: ambos abridores confirmados.
   - **Gate B**: lineup completo (9 bateadores) en ambos equipos.
2. Tú le mandas las cuotas al bot de Telegram (nuevo, separado de @Lynx_HunterBot) con este
   formato (los mercados que falten se ignoran, no hace falta mandarlos todos):
   ```
   DET Tigers vs TEX Rangers
   DET Tigers ML a cuota 1.76 y TEX Rangers ML a cuota 2.01
   Hándicap:
   DET Tigers Hándicap -1.5 a cuota 2.30 y TEX Rangers Hándicap +1.5 a cuota 1.58
   Carreras totales:
   Over 8.5 a cuota 1.86 y Under 8.5 a cuota 1.86
   ```
3. En cuanto un gate y las cuotas coinciden (en cualquier orden), se calcula con el motor
   cuantitativo REAL de Lynx Hunter (vendorizado sin modificar, ver `vendor/`) y se publica un
   pick al canal nuevo si supera el umbral de edge.
4. Como mucho un pick por partido y por "pipeline" (1=solo abridores, 2=lineup completo) —
   garantizado por una restricción `UNIQUE` en Postgres, sobrevive reinicios.

## Estructura

```
app/            código Python (detector, parser, pipelines, adaptadores por liga...)
vendor/         quant_engine*.js vendorizados sin modificar + el puente run_quant.js
migrations/     SQL de la base de datos propia (autopicks) -- separada de Supabase
tests/          pytest -- parser/overround/aliases/idempotencia (ver tests/README.md)
```

## Arrancar en local (desarrollo)

```
cp .env.example .env   # rellenar con los datos del bot nuevo, ver GUIA_DESPLIEGUE_EASYPANEL.md
docker compose up --build
```

## Desplegar en producción

Ver `GUIA_DESPLIEGUE_EASYPANEL.md` -- requiere 3 pasos manuales tuyos (crear bot nuevo en
BotFather, sacar tu chat_id, crear canal nuevo) que no se pueden automatizar.

## Comandos del bot

- `/status` — partidos de hoy y su estado (gates, cuotas, picks).
- `/pending` — partidos con gate confirmado pero sin cuotas todavía.
- `/picks` — picks publicados hoy.
