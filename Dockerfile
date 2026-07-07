# Python + Node en la misma imagen -- Node solo se usa como subproceso interno para llamar a
# los motores vendorizados (vendor/run_quant.js), no es un segundo servicio desplegado.
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

ENV VENDOR_DIR=/app/vendor
ENV LOG_DIR=/app/logs
RUN mkdir -p /app/logs

EXPOSE 8080
CMD ["python", "-m", "app.main"]
