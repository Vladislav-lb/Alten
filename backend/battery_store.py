from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class BatteryStore:
    def __init__(self, base_dir: Path, defaults: list[dict[str, Any]]) -> None:
        self.base_dir = base_dir
        self.path = self.base_dir / "batteries.json"
        self.defaults = deepcopy(defaults)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.save_all(self.defaults)

    def list(self) -> list[dict[str, Any]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                return payload
            if isinstance(payload, dict) and isinstance(payload.get("batteries"), list):
                return payload["batteries"]
        except Exception:
            return deepcopy(self.defaults)
        return deepcopy(self.defaults)

    def save_all(self, batteries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payload = [self.normalize(battery) for battery in batteries]
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def upsert(self, battery: dict[str, Any]) -> dict[str, Any]:
        batteries = self.list()
        normalized = self.normalize(battery)
        next_batteries = [item for item in batteries if item.get("id") != normalized["id"]]
        next_batteries.append(normalized)
        self.save_all(next_batteries)
        return normalized

    def get(self, battery_id: str) -> dict[str, Any] | None:
        return next((battery for battery in self.list() if battery.get("id") == battery_id), None)

    def remove(self, battery_id: str) -> bool:
        batteries = self.list()
        next_batteries = [battery for battery in batteries if battery.get("id") != battery_id]
        if len(next_batteries) == len(batteries):
            return False
        self.save_all(next_batteries)
        return True

    def update_telemetry(self, battery_id: str, telemetry: dict[str, Any]) -> dict[str, Any]:
        battery = self.get(battery_id)
        if battery is None:
            raise KeyError(battery_id)
        current = battery.get("telemetry") or {}
        battery["telemetry"] = {
            **current,
            **telemetry,
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }
        return self.upsert(battery)

    @staticmethod
    def normalize(battery: dict[str, Any]) -> dict[str, Any]:
        normalized = {
            "id": battery.get("id") or "batt_1",
            "name": battery.get("name") or battery.get("id") or "Battery",
            "group": battery.get("group") or "ALTEN",
            "site": battery.get("site") or "default",
            "region": battery.get("region") or "default",
            "enabled": battery.get("enabled", True),
            "capacity_kwh": float(battery.get("capacity_kwh", battery.get("capacityKwh", 0)) or 0),
            "max_charge_kw": float(battery.get("max_charge_kw", battery.get("maxChargeKw", 0)) or 0),
            "max_discharge_kw": float(battery.get("max_discharge_kw", battery.get("maxDischargeKw", 0)) or 0),
            "min_soc_percent": float(battery.get("min_soc_percent", battery.get("minSoc", 10)) or 10),
            "max_soc_percent": float(battery.get("max_soc_percent", battery.get("maxSoc", 95)) or 95),
            "efficiency_percent": float(battery.get("efficiency_percent", battery.get("efficiency", 92)) or 92),
            "protocol": battery.get("protocol") or "home_assistant",
            "connection": battery.get("connection") or {"type": battery.get("protocol") or "home_assistant"},
            "sensors": battery.get("sensors") or {},
            "telemetry": battery.get("telemetry") or {},
        }
        normalized["soc_percent"] = float(
            battery.get("soc_percent", normalized["telemetry"].get("soc", battery.get("soc", 50))) or 50
        )
        normalized["power_kw"] = float(
            battery.get("power_kw", normalized["telemetry"].get("power_kw", battery.get("powerKw", 0))) or 0
        )
        return normalized
