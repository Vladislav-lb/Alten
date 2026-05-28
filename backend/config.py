from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    cors_origins: list[str]
    data_dir: Path
    mqtt_host: str | None
    mqtt_port: int
    mqtt_username: str | None
    mqtt_password: str | None
    modbus_host: str | None
    modbus_port: int
    modbus_unit: int
    ha_url: str | None
    ha_token: str | None


def load_settings() -> Settings:
    return Settings(
        host=os.getenv("ALTEN_EMS_HOST", "0.0.0.0"),
        port=int(os.getenv("ALTEN_EMS_PORT", "8000")),
        cors_origins=parse_csv(os.getenv("ALTEN_EMS_CORS_ORIGINS", "*")),
        data_dir=Path(os.getenv("ALTEN_EMS_DATA_DIR", Path(__file__).resolve().parent / "data")),
        mqtt_host=empty_to_none(os.getenv("ALTEN_EMS_MQTT_HOST")),
        mqtt_port=int(os.getenv("ALTEN_EMS_MQTT_PORT", "1883")),
        mqtt_username=empty_to_none(os.getenv("ALTEN_EMS_MQTT_USERNAME")),
        mqtt_password=empty_to_none(os.getenv("ALTEN_EMS_MQTT_PASSWORD")),
        modbus_host=empty_to_none(os.getenv("ALTEN_EMS_MODBUS_HOST")),
        modbus_port=int(os.getenv("ALTEN_EMS_MODBUS_PORT", "502")),
        modbus_unit=int(os.getenv("ALTEN_EMS_MODBUS_UNIT", "1")),
        ha_url=empty_to_none(os.getenv("ALTEN_EMS_HA_URL", "http://supervisor/core/api")),
        ha_token=empty_to_none(os.getenv("ALTEN_EMS_HA_TOKEN") or os.getenv("SUPERVISOR_TOKEN")),
    )


def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def empty_to_none(value: str | None) -> str | None:
    return value if value else None
