#!/bin/sh
# Arranca Tor en segundo plano (SOCKS5 en 127.0.0.1:9050, puerto por defecto de Debian) antes
# de lanzar la app -- prueba 2026-07-09: el VPS de Francia esta bloqueado por cuotasahora.com
# via IP directa, pero el usuario confirmo que SI le funciona por Tor desde su propia conexion.
# --RunAsDaemon 1 hace fork y vuelve enseguida; unos segundos de margen para que el circuito
# inicial este listo antes de que la app intente usarlo (no es critico si tarda un poco mas,
# el primer intento de scraping normalmente tarda minutos en llegar tras el arranque).
#
# --ExitNodes '{es}': sin esto, Tor sale por CUALQUIER pais del mundo al azar -- bug real
# encontrado en vivo 2026-07-11: cuotasahora.com muestra la hora local segun la IP del
# visitante, y un nodo de salida fuera de España (ej. Reino Unido, UTC+1 en verano frente a
# CEST UTC+2 de España) desincronizaba la hora mostrada en los partidos hasta 1h respecto a lo
# que ve el usuario en su propio navegador.
# SIN --StrictNodes 1 a proposito -- se probo con StrictNodes 1 (forzar SOLO España, sin
# fallback) y goto empezo a fallar por timeout de forma consistente (2/2 intentos, ~30s cada
# uno) -- no hay suficientes nodos de salida españoles disponibles para que Tor monte un
# circuito de forma fiable solo con esos. Sin StrictNodes, ExitNodes es una PREFERENCIA (Tor
# prioriza España pero cae a otros paises si hace falta) -- mejor tener el scraper funcionando
# con la hora ocasionalmente desfasada que tenerlo roto la mayoria de las veces.
tor --RunAsDaemon 1 --ExitNodes '{es}'
sleep 5
exec python -m app.main
