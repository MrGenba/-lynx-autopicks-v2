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
tor --RunAsDaemon 1
sleep 5
exec python -m app.main
