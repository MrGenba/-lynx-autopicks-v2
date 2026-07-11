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
    # Proxy opcional para el scraper de cuotas (vendor/run_odds_scraper.js) -- el VPS de
    # Francia esta bloqueado por cuotasahora.com, asi que sin esto el scraper falla igual que
    # el de produccion. None = sin proxy (mismo comportamiento que antes de 2026-07-09).
    proxy_server: str | None
    proxy_username: str | None
    proxy_password: str | None
    # Token compartido para /scrape-odds -- endpoint HTTP que produccion (n8n, proyecto
    # EasyPanel distinto, sin red interna compartida con este) llama para reusar el scraper
    # con Tor de este contenedor en vez de duplicar Tor+Chrome en producción. None = endpoint
    # desactivado (siempre 401), no expuesto por accidente sin querer protegerlo.
    scrape_endpoint_token: str | None
    # odds-api.io (2026-07-11) -- fuente de cuotas primaria nueva, API real en vez de scraping.
    # None = desactivada, cae directo al scraper de Tor (comportamiento identico a antes).
    odds_api_key: str | None

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
            # Pausado por defecto 2026-07-09: el proxy IPRoyal (pago por GB) se comio >4GB
            # durante la depuracion de esta funcionalidad, casi todo ANTES de que el filtro por
            # URL y el bloqueo de imagenes estuvieran desplegados. /fetchodds sigue disponible
            # para disparar un ciclo manual a proposito -- reactivar aqui cuando se confirme
            # cuanto gasta realmente el ciclo ya optimizado.
            odds_autofetch_enabled=os.environ.get("ODDS_AUTOFETCH_ENABLED", "false").lower() == "true",
            proxy_server=os.environ.get("PROXY_SERVER") or None,
            proxy_username=os.environ.get("PROXY_USERNAME") or None,
            proxy_password=os.environ.get("PROXY_PASSWORD") or None,
            scrape_endpoint_token=os.environ.get("SCRAPE_ENDPOINT_TOKEN") or None,
            odds_api_key=os.environ.get("ODDS_API_KEY") or None,
        )
