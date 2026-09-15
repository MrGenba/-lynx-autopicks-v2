"""Dos defectos encontrados el 2026-09-15 tirando del aviso "❌ Detector: fallo el schedule de
sport_id=23", y lo que garantiza que no vuelvan.

CONTEXTO MEDIDO ESE DIA, desde dentro del contenedor: statsapi.mlb.com responde **200 a
sportId=1 (MLB) pero 406 a sportId=11 (MiLB) y sportId=23 (LMB)**. O sea que esas dos ligas no
usan el fallback de r.jina.ai como red de seguridad ocasional: **dependen de el al 100%, en cada
tick de 180 s**. En las ~16 h posteriores al despliegue se uso 470 veces y fallo UNA, por
timeout. De ahi salen los dos agujeros:

1. `_fetch_jina` solo reintentaba si recibia un 429. Un timeout -- justo el que ocurrio -- se
   propagaba tal cual y se llevaba por delante el tick de esa liga. El reintento del camino
   directo si contempla cualquier excepcion; el del fallback no, y el fallback es el unico
   camino que tienen dos de las tres ligas.
2. El aviso del detector se mandaba en CADA fallo. A un tick cada 180 s, un tropiezo transitorio
   que se arregla solo llega al Telegram del usuario igual de fuerte que un apagon real -- que es
   exactamente lo que hace que se dejen de mirar los avisos.
"""
import datetime as dt

import httpx
import pytest

from app import detector
from app import mlb_stats_client as msc


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=httpx.Request("GET", "http://x"),
                response=httpx.Response(self.status_code),
            )


class _Cliente:
    """Cliente falso: devuelve (o lanza) lo que diga la secuencia, y cuenta las llamadas."""

    def __init__(self, secuencia):
        self.secuencia = list(secuencia)
        self.llamadas = 0

    async def get(self, url, **_kw):
        i = min(self.llamadas, len(self.secuencia) - 1)
        self.llamadas += 1
        item = self.secuencia[i]
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def _sin_esperas(monkeypatch):
    async def _noop(*_a, **_k):
        return None
    monkeypatch.setattr(msc.asyncio, "sleep", _noop)


@pytest.fixture(autouse=True)
def _estado_limpio():
    detector.reiniciar_estado_schedule()
    yield
    detector.reiniciar_estado_schedule()


# ── 1. El fallback tiene que sobrevivir a un timeout ──────────────────────────

@pytest.mark.asyncio
async def test_jina_reintenta_tras_un_timeout():
    """Es el fallo real del 2026-09-15: un timeout suelto dejaba a LMB sin schedule ese tick."""
    cliente = _Cliente([httpx.ReadTimeout("demasiado lento"), _Resp(200, '{"dates": []}')])
    data = await msc._fetch_jina(cliente, "https://statsapi.mlb.com/api/v1/schedule?sportId=23")
    assert data == {"dates": []}
    assert cliente.llamadas == 2


@pytest.mark.asyncio
async def test_jina_sigue_reintentando_el_429():
    """Regresion: el 429 bajo carga ya se reintentaba y tiene que seguir haciendolo."""
    cliente = _Cliente([_Resp(429, "slow down"), _Resp(200, '{"dates": [1]}')])
    data = await msc._fetch_jina(cliente, "https://statsapi.mlb.com/api/v1/schedule?sportId=11")
    assert data == {"dates": [1]}
    assert cliente.llamadas == 2


@pytest.mark.asyncio
async def test_jina_se_rinde_y_lanza_si_no_hay_manera():
    """Rendirse es correcto; lo que no vale es rendirse al primer tropiezo."""
    cliente = _Cliente([httpx.ReadTimeout("lento")])
    with pytest.raises(httpx.ReadTimeout):
        await msc._fetch_jina(cliente, "https://statsapi.mlb.com/api/v1/schedule?sportId=23")
    assert cliente.llamadas >= 2


# ── 2. El aviso solo cuando de verdad hay algo que mirar ──────────────────────

AHORA = dt.datetime(2026, 9, 15, 7, 42, tzinfo=dt.timezone.utc)


def test_un_fallo_suelto_no_avisa():
    assert detector.registrar_fallo_schedule(23, AHORA) is False


def test_avisa_al_tercer_fallo_seguido():
    assert detector.registrar_fallo_schedule(23, AHORA) is False
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=3)) is False
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=6)) is True


def test_no_repite_el_aviso_dentro_de_la_hora():
    for i in range(3):
        detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=3 * i))
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=9)) is False
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=59)) is False


def test_vuelve_a_avisar_pasada_la_hora_si_sigue_roto():
    """La hora se cuenta desde el AVISO anterior, no desde el primer fallo: si no, una racha larga
    iria adelantando el recordatorio hasta convertirlo otra vez en ruido."""
    for i in range(3):
        detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=3 * i))
    aviso = AHORA + dt.timedelta(minutes=6)  # el tercer fallo es el que avisa
    assert detector.registrar_fallo_schedule(23, aviso + dt.timedelta(minutes=59)) is False
    assert detector.registrar_fallo_schedule(23, aviso + dt.timedelta(minutes=61)) is True


def test_un_exito_reinicia_la_cuenta():
    """Lo que se vigila son fallos SEGUIDOS: si la liga vuelve, el contador empieza de cero."""
    detector.registrar_fallo_schedule(23, AHORA)
    detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=3))
    detector.registrar_exito_schedule(23)
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=6)) is False


def test_cada_liga_lleva_su_propia_cuenta():
    """MiLB y LMB fallan por la misma causa pero no tienen por que fallar a la vez, y mezclarlas
    haria que dos ligas a un fallo cada una dispararan un aviso que no toca."""
    detector.registrar_fallo_schedule(11, AHORA)
    detector.registrar_fallo_schedule(11, AHORA + dt.timedelta(minutes=3))
    assert detector.registrar_fallo_schedule(23, AHORA + dt.timedelta(minutes=3)) is False
