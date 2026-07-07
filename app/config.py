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
    tg_bot_token: str
    tg_admin_chat_id: int
    tg_picks_channel_id: int
    node_bin: str
    vendor_dir: str
    log_level: str
    log_dir: str
    detector_interval_seconds: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            database_url=_require("DATABASE_URL"),
            supabase_url=_require("SUPABASE_URL"),
            supabase_key=_require("SUPABASE_KEY"),
            tg_bot_token=_require("TG_BOT_TOKEN"),
            tg_admin_chat_id=int(_require("TG_ADMIN_CHAT_ID")),
            tg_picks_channel_id=int(_require("TG_PICKS_CHANNEL_ID")),
            node_bin=os.environ.get("NODE_BIN", "node"),
            vendor_dir=os.environ.get("VENDOR_DIR", "/app/vendor"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            log_dir=os.environ.get("LOG_DIR", "/app/logs"),
            detector_interval_seconds=int(os.environ.get("DETECTOR_INTERVAL_SECONDS", "180")),
        )
