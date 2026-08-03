#!/bin/sh
# Arranca Tor en segundo plano (SOCKS5 en 127.0.0.1:9050, puerto por defecto de Debian) antes
# de lanzar la app -- prueba 2026-07-09: el VPS de Francia esta bloqueado por cuotasahora.com
# via IP directa, pero el usuario confirmo que SI le funciona por Tor desde su propia conexion.
# --RunAsDaemon 1 hace fork y vuelve enseguida; unos segundos de margen para que el circuito
# inicial este listo antes de que la app intente usarlo (no es critico si tarda un poco mas,
# el primer intento de scraping normalmente tarda minutos en llegar tras el arranque).
#
# NO se restringe el pais de salida de Tor -- se probo 2026-07-11 (ExitNodes '{es}', con y sin
# StrictNodes) para corregir un desfase de 1h en la hora que muestra cuotasahora.com (calcula
# la hora local segun la geolocalizacion de la IP del visitante, y un nodo de salida fuera de
# España desincroniza esa hora). PERO limitar el pool de nodos de salida a España, aunque solo
# como preferencia (sin StrictNodes), hizo fallar el scraping de forma consistente (3/3
# intentos con timeout en el propio page.goto) -- revertido. Mejor un scraper que funcione de
# forma fiable con la hora ocasionalmente desfasada 1h que uno roto la mayoria de las veces. Si
# se retoma esto en el futuro, probar con un timeout de goto mas alto en vez de restringir el
# pool de nodos.
# 2026-08-02: ControlPort + CookieAuthentication para poder rotar el circuito bajo demanda
# (SIGNAL NEWNYM desde app/tor_control.py) tras un scrape fallido. NO se toca MaxCircuitDirtiness
# (se queda en el default 600s): el circuito debe ser ESTABLE durante cada scrape -- rotarlo a
# mitad rompe la sesion del navegador (error de la iteracion anterior). Solo se rota entre
# reintentos, cuando cuotasahora sirvio el "decoy" (indice sin partidos) por un circuito malo.
tor --RunAsDaemon 1 \
    --ControlPort 9051 \
    --CookieAuthentication 1 \
    --CookieAuthFile /tmp/tor.cookie

# 2026-08-02: 2a instancia de Tor SOLO para LMB (sport 23), con salida en MEXICO. cuotasahora
# sirve un muro de login/decoy ("INICIO DE SESION"/"REGISTRO") a la mayoria de circuitos Tor
# NO mexicanos en la seccion de LMB -> con un exit mexicano carga la pagina real de cuotas.
# AISLADA del Tor principal (otro SocksPort 9052 + su propio DataDirectory) para NO afectar a
# MLB/MiLB, que siguen por el 9050. La app enruta LMB aqui solo si PROXY_SERVER_LMB=
# socks5://127.0.0.1:9052 esta en el entorno (si no, LMB cae al Tor normal). Aviso: la red Tor
# solo tiene ~1 exit MX (TrujillosExit) -> StrictNodes lo fuerza; si ese nodo cae, LMB se queda
# sin cuotas (aceptable, ya estaba a 0) y MLB/MiLB quedan intactos. Si falla al arrancar, el
# script sigue igual (LMB simplemente no tendra el 9052 disponible).
tor --RunAsDaemon 1 \
    --SocksPort 9052 \
    --DataDirectory /tmp/tor-mx \
    --ExitNodes '{mx}' \
    --StrictNodes 1 || echo "AVISO: Tor MX (LMB) no arranco; LMB caera al Tor normal"

sleep 8
exec python -m app.main
