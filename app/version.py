"""Huella del codigo REALMENTE desplegado, para no volver a inferirlo por sintomas.

2026-08-16: tres despliegues seguidos sin forma fiable de saber que codigo corria. Se iba
deduciendo por señales indirectas (¿aparece tal contador?, ¿bajo el volumen de scrapes?, ¿murio
el job en memoria?) y dos veces se dio por desplegado algo que no lo estaba, perdiendo los
diagnosticos que dependian de ello.

Por que una huella del CONTENIDO y no el SHA de git: la imagen no incluye el repositorio (el
Dockerfile solo copia app/, vendor/ y migrations/), asi que dentro del contenedor no hay ningun
commit que consultar, y meterlo por build-arg obligaria a tocar la configuracion de EasyPanel en
cada despliegue -- justo el tipo de paso manual que se olvida. Un hash del propio codigo fuente no
necesita plumbing: se calcula igual aqui dentro que en local, y comparar ambos responde
"¿esta desplegado lo que acabo de escribir?" sin ambiguedad.

Se normalizan los finales de linea antes de hashear: el repo se edita en Windows (CRLF) y se
ejecuta en Linux (LF), asi que sin esto la huella local y la del contenedor NUNCA coincidirian
aunque el codigo fuera identico.
"""
import datetime as dt
import hashlib
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_INCLUIR = (("app", "*.py"), ("migrations", "*.sql"), ("vendor", "*.js"))
_EXCLUIR = ("__pycache__", ".pytest_cache")


def _ficheros() -> list[Path]:
    out: list[Path] = []
    for carpeta, patron in _INCLUIR:
        base = _ROOT / carpeta
        if not base.is_dir():
            continue
        for p in base.rglob(patron):
            if any(parte in _EXCLUIR for parte in p.parts):
                continue
            out.append(p)
    return sorted(out, key=lambda p: p.relative_to(_ROOT).as_posix())


def calcular_huella() -> str:
    h = hashlib.sha256()
    for p in _ficheros():
        h.update(p.relative_to(_ROOT).as_posix().encode("utf-8"))
        h.update(b"\0")
        try:
            # normalizacion CRLF -> LF (ver docstring)
            h.update(p.read_bytes().replace(b"\r\n", b"\n"))
        except OSError:
            h.update(b"<ilegible>")
        h.update(b"\0")
    return h.hexdigest()[:16]


HUELLA = calcular_huella()
ARRANCADO_EN = dt.datetime.now(dt.timezone.utc)


if __name__ == "__main__":  # uso local: python -m app.version
    print(HUELLA)
