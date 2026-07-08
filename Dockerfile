# Python + Node en la misma imagen -- Node se usa como subproceso interno para llamar a los
# motores vendorizados (vendor/run_quant.js) y, desde 2026-07-09, tambien para el scraper de
# cuotas vendorizado (vendor/run_odds_scraper.js), que necesita un Chrome real via patchright
# (mismo patron que odds_bet365/scraper_cuotasahora.js en produccion).
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY vendor/ vendor/
COPY migrations/ migrations/
COPY package.json .

# --with-deps instala las librerias de sistema que Chrome necesita en Debian (fonts, libnss3,
# etc.) -- sin esto el navegador headless falla al arrancar dentro del contenedor.
RUN npm install --omit=dev \
    && npx patchright install --with-deps chrome

ENV VENDOR_DIR=/app/vendor
ENV LOG_DIR=/app/logs
RUN mkdir -p /app/logs

EXPOSE 8080
CMD ["python", "-m", "app.main"]
