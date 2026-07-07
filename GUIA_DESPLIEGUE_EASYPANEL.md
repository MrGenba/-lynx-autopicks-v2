# Despliegue en EasyPanel — Lynx Hunter Auto-Picks v2

Este sistema es **paralelo** al pipeline de producción en n8n. No sustituye nada, no toca
Supabase salvo lectura, y usa un bot de Telegram nuevo.

## Antes de empezar — 3 cosas que solo puedes hacer tú

1. **Bot de Telegram nuevo**: habla con [@BotFather](https://t.me/BotFather) en Telegram,
   `/newbot`, elige nombre y usuario. Te dará un token (`TG_BOT_TOKEN`). **No reutilices el
   token de @Lynx_HunterBot** — ese usa webhook en n8n y no puede compartirse con un bot que
   usa polling (conflicto de la propia API de Telegram).
2. **Tu chat_id de admin**: escríbele algo al bot nuevo, luego visita
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` en el navegador — verás tu `chat.id`
   en la respuesta JSON. Ese es `TG_ADMIN_CHAT_ID`.
3. **Canal de picks nuevo**: crea un canal de Telegram nuevo (o grupo), añade el bot nuevo como
   administrador, manda un mensaje cualquiera al canal, y repite el paso de `getUpdates` para
   sacar el `chat.id` del canal (será un número negativo, tipo `-100...`). Ese es
   `TG_PICKS_CHANNEL_ID`.

## Paso 1 — Crear el servicio de Postgres en EasyPanel

1. Entra a EasyPanel → proyecto `lynx_hunter` (ya existe, vacío).
2. "Add Service" → "Postgres" (plantilla gestionada de EasyPanel).
3. Nombre del servicio: `autopicks-db`. Anota el usuario/contraseña que genera EasyPanel.
4. Espera a que arranque — EasyPanel le da un nombre DNS interno (`autopicks-db`) accesible
   solo desde otros servicios del mismo proyecto.

## Paso 2 — Crear el servicio de la app

1. En el mismo proyecto `lynx_hunter`: "Add Service" → "App".
2. Nombre: `autopicks-app`.
3. Origen del código: sube este directorio (`D:\Milb\autopicks_v2\`) al método que prefieras
   que EasyPanel soporte para build-from-source (Git repo que EasyPanel pueda clonar, o build
   manual con el Dockerfile ya incluido) — mismo mecanismo que ya usa el servicio `n8n` de este
   VPS (ver `n8n.Dockerfile` en el proyecto Lynx Hunter original).
4. Variables de entorno (pestaña "Environment"):
   ```
   DATABASE_URL=postgresql://<usuario>:<password>@autopicks-db:5432/autopicks
   SUPABASE_URL=https://htpllgcsjwasptaxheph.supabase.co
   SUPABASE_KEY=<la misma SUPABASE_KEY que usa el resto del proyecto Lynx Hunter, solo lectura>
   TG_BOT_TOKEN=<token del bot nuevo del paso 0>
   TG_ADMIN_CHAT_ID=<tu chat_id>
   TG_PICKS_CHANNEL_ID=<chat_id del canal nuevo>
   NODE_BIN=node
   VENDOR_DIR=/app/vendor
   LOG_LEVEL=INFO
   LOG_DIR=/app/logs
   DETECTOR_INTERVAL_SECONDS=180
   ```
5. Puerto expuesto: 8080 (solo para el health check `/healthz` — no hace falta dominio
   público, EasyPanel puede dejarlo sin exponer a internet si lo prefieres).
6. Deploy.

## Paso 3 — Verificar

1. Revisa los logs del servicio en EasyPanel — deberías ver `arrancando autopicks_v2`, luego
   `migracion aplicada: 0001_init.sql`, luego (la primera vez) `alias sembrados: N`.
2. En tu chat de admin de Telegram deberías recibir: "🟢 Auto-Picks v2 arrancado y en marcha."
3. Manda `/status` al bot — debería listar los partidos de MLB/MiLB/LMB descubiertos hoy (puede
   tardar hasta 3 minutos, el primer tick del detector).
4. Prueba con un partido real de hoy: mándale al bot un mensaje con el formato de cuotas (ver
   `README.md` del proyecto) para un partido que ya tenga abridores confirmados — deberías
   recibir la confirmación "✅ Cuotas guardadas" y, si hay valor, un pick en el canal nuevo.

## Automatización de re-despliegues

Una vez creado el servicio, EasyPanel normalmente permite configurar un webhook de Git para
re-desplegar automáticamente en cada push — configúralo desde la propia UI del servicio
(`Deploy` → `Auto Deploy`) si tu origen de código es un repo Git. No fue necesario para la
creación inicial de los 2 servicios (eso sí fue manual, ver arriba) — no hay automatización de
API confirmada en este proyecto para ese primer paso.

## Si algo falla

- **"Falta la variable de entorno obligatoria"**: revisa el paso 2.4, falta alguna env var.
- **Sin mensajes de Telegram**: confirma que el bot nuevo NO tiene un webhook configurado
  accidentalmente (`https://api.telegram.org/bot<TOKEN>/getWebhookInfo` debe devolver
  `"url": ""`) — si lo tiene, bórralo con `/deleteWebhook` antes de que el polling funcione.
- **`node: command not found` en los logs**: el Dockerfile no se reconstruyó bien, revisa que
  EasyPanel esté usando el `Dockerfile` de este directorio y no un buildpack genérico de Python.
