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

# 2026-08-16: 2a instancia con salidas en paises de CATALOGO COMPLETO de Bet365 (SOCKS 9053).
#
# Causa raiz encontrada hoy: cuotasahora geolocaliza por IP de salida y sirve el catalogo de casas
# de ESE pais. Alemania es, con diferencia, el pais con mas exits de Tor, asi que caiamos ahi
# constantemente -- y el catalogo aleman lista "Bet365.de", que (a) no casa con el nombre exacto
# "bet365" que busca pickBookmaker, asi que el partido entero se descartaba pese a tener las
# cuotas delante (`mlRowsFound=6 casas=[...,"Bet365.de",...]`), y (b) por la regulacion alemano
# ofrece muchos menos mercados, lo que explica que el TOTAL no llegara nunca aunque el ML si.
#
# Por que ahora si puede funcionar restringir el pais, si fallo dos veces: los intentos anteriores
# fijaron UN pais con poquisimos exits -- {es} (2026-07-11) y {mx} (2026-08-03, la red Tor tiene
# ~1 exit mexicano). Con StrictNodes sobre un pool diminuto Tor se queda sin rutas y da
# ERR_TIMED_OUT. Aqui NO hace falta un pais concreto: sirve cualquiera cuyo Bet365 sea el catalogo
# internacional, asi que el pool es mucho mayor. Ademas se suben los timeouts de navegacion
# (GOTO_MATCH_MS/GOTO_INDEX_MS), que es lo que el comentario de arriba ya recomendaba probar
# antes de renunciar a fijar el pais.
#
# Instancia SEPARADA y no sustitucion: si este pool restringido falla, el Tor general de 9050
# sigue intacto como respaldo y el sistema no se queda sin cuotas.
tor --RunAsDaemon 1 \
    --SocksPort 9053 \
    --DataDirectory /tmp/tor-full \
    --ExitNodes '{gb},{ie},{nl},{at},{dk},{no}' \
    --StrictNodes 1 \
    --PidFile /tmp/tor-full.pid

# 2026-08-03: se PROBO una 2a instancia Tor con ExitNodes {mx} (StrictNodes) para LMB, porque
# cuotasahora sirve un muro de login/decoy a los circuitos no-MX en la seccion de LMB. NO FUNCIONO:
# la red Tor solo tiene ~1 exit MX (TrujillosExit) y forzarlo daba net::ERR_TIMED_OUT en page.goto
# (mismo fallo que restringir a {es}, ver arriba). Retirada. La app conserva el hook
# PROXY_SERVER_LMB (Config.proxy_server_lmb): si algun dia hay un proxy MEXICANO fiable (residencial
# de pago, u otra via), basta con apuntar ese env a el y LMB saldra por ahi sin tocar codigo.

sleep 8
exec python -m app.main
