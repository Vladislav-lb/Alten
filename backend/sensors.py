from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import aiohttp


class HomeAssistantSensorClient:
    def __init__(self, base_url: str | None, token: str | None) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.token = token

    async def read_battery_sensors(self, battery: dict[str, Any]) -> dict[str, Any]:
        sensors = battery.get("sensors") or {}
        if not self.base_url or not self.token or not sensors:
            return {}

        telemetry: dict[str, Any] = {}
        async with aiohttp.ClientSession(headers=self.headers) as session:
            for key, entity_id in sensors.items():
                if not entity_id:
                    continue
                state = await self.read_state(session, entity_id)
                if state is None:
                    continue
                telemetry.update(map_sensor_value(key, state))

        if telemetry:
            telemetry["source"] = "home_assistant"
            telemetry["last_seen"] = datetime.now(timezone.utc).isoformat()
        return telemetry

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }

    async def read_state(self, session: aiohttp.ClientSession, entity_id: str) -> dict[str, Any] | None:
        url = f"{self.base_url}/states/{entity_id}"
        try:
            async with session.get(url, timeout=8) as response:
                if response.status != 200:
                    return None
                return await response.json()
        except Exception:
            return None


def map_sensor_value(key: str, state: dict[str, Any]) -> dict[str, Any]:
    raw = state.get("state")
    attributes = state.get("attributes") or {}
    value = parse_number(raw)

    if key in {"soc", "soc_percent"}:
        return {"soc_percent": value, "soc": value}
    if key in {"power", "power_kw"}:
        return {"power_kw": value}
    if key in {"voltage", "voltage_v"}:
        return {"voltage_v": value}
    if key in {"current", "current_a"}:
        return {"current_a": value}
    if key in {"temperature", "temperature_c"}:
        return {"temperature_c": value}
    if key == "status":
        return {"status": str(raw)}
    if key == "energy_charged":
        return {"energy_charged_kwh": value}
    if key == "energy_discharged":
        return {"energy_discharged_kwh": value}
    return {
        key: value if value is not None else raw,
        f"{key}_unit": attributes.get("unit_of_measurement"),
    }


def parse_number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
