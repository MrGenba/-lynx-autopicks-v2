"""Configuracion desde variables de entorno. Falla rapido si falta algo obligatorio."""
import os
from dataclasses import dataclass


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Falta la variable de entorno obligatoria: {name}")
    return value


@dataclass(frozen=True)
class Config:
    database_url: str
    supabase_url: str
    supabase_key: str
    tg_bot_token: str  # bot NUEVO -- polling (recibe cuotas) + avisos al admin
    tg_picks_bot_token: str  # @Lynx_HunterBot (produccion) -- SOLO para publicar picks, nunca polling
    tg_admin_chat_id: int
    tg_picks_channel_id: int
    node_bin: str
    vendor_dir: str
    log_level: str
    log_dir: str
    detector_interval_seconds: int
    odds_autofetch_interval_seconds: int
    odds_autofetch_enabled: bool
    # Captura de linea de cierre para medir CLV (2026-07-25). Cerca del inicio de cada partido
    # con pick publicado, scrapea la linea Bet365 de cierre (misma fuente que la cuota de
    # apuesta) y la guarda en Supabase pick_closing_lines. Desactivada por defecto: anade
    # scrapes de Tor extra cerca del cierre -- activar tras revisar el gasto de proxy.
    clv_capture_enabled: bool
    clv_capture_interval_seconds: int
    # Proxy del scraper de cuotas (vendor/run_odds_scraper.js) -- el VPS de Francia esta bloqueado
    # por cuotasahora.com por IP directa, asi que se sale por el Tor local (SOCKS 127.0.0.1:9050,
    # arrancado en docker-entrypoint.sh). None = sin proxy (salida directa, falla en el VPS).
    proxy_server: str | None
    # Proxy SEPARADO solo para LMB (sport 23): 2a instancia Tor con ExitNodes {mx} (127.0.0.1:9052).
    # cuotasahora sirve un muro de login/decoy a la mayoria de circuitos Tor NO mexicanos en la
    # seccion de LMB -> con salida en Mexico carga la pagina real. Aislado del Tor principal para no
    # afectar a MLB/MiLB. None = LMB usa proxy_server (el Tor normal). 2026-08-02.
    proxy_server_lmb: str | None
    # Token compartido para /scrape-odds -- endpoint HTTP que produccion (n8n, proyecto
    # EasyPanel distinto, sin red interna compartida con este) llama para reusar el scraper
    # con Tor de este contenedor en vez de duplicar Tor+Chrome en producción. None = endpoint
    # desactivado (siempre 401), no expuesto por accidente sin querer protegerlo.
    scrape_endpoint_token: str | None
    # odds-api.io (2026-07-11) -- fuente de cuotas primaria nueva, API real en vez de scraping.
    # None = desactivada, cae directo al scraper de Tor (comportamiento identico a antes).
    odds_api_key: str | None
    # oddspapi.io (2026-08-29) -- respaldo de Tor SOLO para MiLB/LMB (ver app/oddspapi_client.py):
    # se intenta Tor primero, y solo si agota todos los reintentos se prueba esto antes de
    # rendirse. MLB no lo usa (Tor funciona bien ahi). None = desactivado, sin respaldo.
    oddspapi_key: str | None
    # Token del dashboard de estado (2026-08-14): se sirve en GET /d/<token> como HTML. Va en la
    # RUTA y no en una cabecera porque se abre desde un navegador/movil, donde no se pueden poner
    # cabeceras. Por eso es un token DISTINTO de scrape_endpoint_token: la URL acaba en el
    # historial del navegador y en logs de proxy, y filtrarla no debe dar control del scraper --
    # el dashboard es solo-lectura. None = dashboard desactivado (404), nunca expuesto sin querer.
    dashboard_token: str | None
    # 2a instancia de Tor con ExitNodes en paises de CATALOGO COMPLETO de Bet365 (SOCKS 9053, ver
    # docker-entrypoint.sh). cuotasahora geolocaliza por IP: desde Alemania (el pais con mas exits
    # de Tor, donde caiamos casi siempre) sirve "Bet365.de", que ni casa con el nombre buscado ni
    # ofrece los mismos mercados. None = no configurada, todo sale por el Tor general.
    proxy_server_full: str | None

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            database_url=_require("DATABASE_URL"),
            supabase_url=_require("SUPABASE_URL"),
            supabase_key=_require("SUPABASE_KEY"),
            tg_bot_token=_require("TG_BOT_TOKEN"),
            tg_picks_bot_token=_require("TG_PICKS_BOT_TOKEN"),
            tg_admin_chat_id=int(_require("TG_ADMIN_CHAT_ID")),
            tg_picks_channel_id=int(_require("TG_PICKS_CHANNEL_ID")),
            node_bin=os.environ.get("NODE_BIN", "node"),
            vendor_dir=os.environ.get("VENDOR_DIR", "/app/vendor"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            log_dir=os.environ.get("LOG_DIR", "/app/logs"),
            detector_interval_seconds=int(os.environ.get("DETECTOR_INTERVAL_SECONDS", "180")),
            odds_autofetch_interval_seconds=int(os.environ.get("ODDS_AUTOFETCH_INTERVAL_SECONDS", "900")),
            odds_autofetch_enabled=os.environ.get("ODDS_AUTOFETCH_ENABLED", "false").lower() == "true",
            clv_capture_enabled=os.environ.get("CLV_CAPTURE_ENABLED", "false").lower() == "true",
            clv_capture_interval_seconds=int(os.environ.get("CLV_CAPTURE_INTERVAL_SECONDS", "300")),
            proxy_server=os.environ.get("PROXY_SERVER") or None,
            proxy_server_lmb=os.environ.get("PROXY_SERVER_LMB") or None,
            scrape_endpoint_token=os.environ.get("SCRAPE_ENDPOINT_TOKEN") or None,
            odds_api_key=os.environ.get("ODDS_API_KEY") or None,
            oddspapi_key=os.environ.get("ODDSPAPI_KEY") or None,
            dashboard_token=os.environ.get("DASHBOARD_TOKEN") or None,
            # 2026-08-16: sin valor por defecto. La 2a instancia quedo desactivada (ver
            # docker-entrypoint.sh) y apuntar a un SOCKS muerto costaba 15s en CADA carga del
            # dashboard esperando el tope duro. Vacio = no se comprueba ni se ofrece.
            proxy_server_full=os.environ.get("PROXY_SERVER_FULL") or None,
        )
