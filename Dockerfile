# Python + Node en la misma imagen -- Node se usa como subproceso interno para llamar a los
# motores vendorizados (vendor/run_quant.js) y, desde 2026-07-09, tambien para el scraper de
# cuotas vendorizado (vendor/run_odds_scraper.js), que necesita un Chrome real via patchright
# (mismo patron que odds_bet365/scraper_cuotasahora.js en produccion).
FROM python:3.12-slim

# `tini` (2026-09-13): init de verdad como PID 1 -- ver ENTRYPOINT al final y la razon completa
# en CLAUDE.md, seccion "APAGON DE CUOTAS: 9.458 zombis de Chrome". Verificado que el paquete
# existe en esta base (Debian 13 trixie, tini 0.19.0) e instala /usr/bin/tini.
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates tor tini \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && test -x /usr/bin/tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY vendor/ vendor/
COPY migrations/ migrations/
COPY package.json .
# 2026-08-16: el Dockerfile se copia a la imagen para que entre en la huella de /version. Sin
# esto, app/version.py lo hasheaba en local (donde existe) y no en el contenedor (donde no
# llegaba), asi que las dos huellas no coincidian NUNCA y el verificador daba falso negativo en
# cada despliegue. Un cambio del Dockerfile si altera la imagen, asi que debe contar.
COPY Dockerfile .

# --with-deps instala las librerias de sistema que Chrome necesita en Debian (fonts, libnss3,
# etc.) -- sin esto el navegador headless falla al arrancar dentro del contenedor.
RUN npm install --omit=dev \
    && npx patchright install --with-deps chrome

COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

ENV VENDOR_DIR=/app/vendor
ENV LOG_DIR=/app/logs
RUN mkdir -p /app/logs

EXPOSE 8080

# ---------------------------------------------------------------------------
# PID 1 = tini, y NO la app (2026-09-13).
#
# Antes, `docker-entrypoint.sh` acababa en `exec python -m app.main`, asi que Python quedaba como
# PID 1. Python no recoge hijos que no ha lanzado el mismo, y cada scrape de cuotas arranca un
# Chrome cuyos NIETOS (renderers y `chrome_crashpad_handler`) se reparentan a PID 1 al morir su
# padre. Nadie les hacia `wait()`, asi que se acumulaban como zombis: el 2026-09-13 habia **9.458**
# y `pids.current` estaba en **9.477 de 9.483** -- seis PIDs del tope del cgroup. A partir de ahi
# `posix_spawn` devolvia EAGAIN, Chrome moria con SIGTRAP antes de tocar la red y el sistema paso
# ~19 h sin conseguir una sola cuota. No se veia venir: el fallo aparecia como
# "browserType.launch: Target page, context or browser has been closed", que parece un problema de
# red o de Tor, y el reintento respondia rotando circuito (302 rotaciones en 24 h, inutiles).
#
# tini como PID 1 recoge cualquier huerfano, que es justo lo que faltaba. Se deja el CMD como
# estaba: tini ejecuta el entrypoint, el entrypoint hace `exec python`, y los nietos de Chrome
# acaban en tini en vez de en Python.
#
# Ojo al desplegar: esto cambia el Dockerfile, que entra en la huella de /version (ver COPY de
# arriba), asi que la huella NUEVA es la senal de que el arreglo esta realmente en produccion.
# Comprobar despues con `cat /sys/fs/cgroup/pids.current` y `ps -e -o stat= | grep -c Z`: ese
# contador ya no debe crecer con los dias.
# ---------------------------------------------------------------------------
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./docker-entrypoint.sh"]
