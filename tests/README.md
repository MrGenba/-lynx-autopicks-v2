# Tests

## Correr los que no necesitan base de datos (parser, overround, matching puro)

```
pip install -r requirements.txt
pytest -q
```

Estos ya se ejecutaron y pasan (23 tests) sin necesitar nada mas.

## Correr los que SI necesitan Postgres real (aliases con DB, idempotencia)

Estos tests se saltan automaticamente si no hay `DATABASE_URL_TEST` definida -- son los que
prueban la garantia real de la restriccion `UNIQUE` de Postgres (no se mockea a proposito,
ver comentario en `test_idempotency.py`). En este entorno de desarrollo no hay Docker/Postgres
instalado localmente, asi que quedaron sin ejecutar -- correrlos antes del primer despliegue:

```
# con Docker disponible:
docker run -d --name autopicks-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=autopicks_test -p 5433:5432 postgres:16

DATABASE_URL_TEST=postgresql://postgres:test@localhost:5433/autopicks_test pytest -q
```

O contra el Postgres real de EasyPanel una vez desplegado (con una base de datos de prueba
separada, nunca contra la de produccion).
