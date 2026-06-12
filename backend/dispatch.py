from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def plan_slots(plan: dict[str, Any] | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if isinstance(plan, list):
        return [slot for slot in plan if isinstance(slot, dict)]
    if not isinstance(plan, dict):
        return []
    if isinstance(plan.get("slots"), list):
        return [slot for slot in plan["slots"] if isinstance(slot, dict)]
    nested = plan.get("plan")
    if isinstance(nested, dict) and isinstance(nested.get("slots"), list):
        return [slot for slot in nested["slots"] if isinstance(slot, dict)]
    return []


def find_current_slot(plan: dict[str, Any] | list[dict[str, Any]] | None, now: datetime | None = None) -> dict[str, Any] | None:
    current = normalize_datetime(now or datetime.now(timezone.utc))
    slots = plan_slots(plan)

    for slot in slots:
        slot_time = parse_slot_time(slot.get("time") or slot.get("datetime") or slot.get("start"))
        if slot_time and same_hour(slot_time, current):
            return slot

    for slot in slots:
        if slot_hour(slot) == current.hour:
            return slot

    return None


def should_enable_grid_charging(slot: dict[str, Any] | None) -> bool:
    if not slot:
        return False
    mode = str(slot.get("mode") or slot.get("action") or "").strip().lower()
    return mode == "charge" and slot_power_kw(slot) > 0


def slot_power_kw(slot: dict[str, Any]) -> float:
    for key in ("power_kw", "powerKw", "power", "charge_kw", "chargeKw"):
        if key in slot:
            try:
                return max(0.0, float(slot.get(key) or 0))
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def slot_key(slot: dict[str, Any] | None, enabled: bool) -> str:
    if not slot:
        return f"none:{int(enabled)}"
    return f"{slot.get('time') or slot.get('hour') or 'unknown'}:{int(enabled)}"


def parse_slot_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return normalize_datetime(parsed)


def normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def same_hour(left: datetime, right: datetime) -> bool:
    return left.strftime("%Y-%m-%dT%H") == right.strftime("%Y-%m-%dT%H")


def slot_hour(slot: dict[str, Any]) -> int | None:
    value = slot.get("hour")
    if isinstance(value, int):
        return value if 0 <= value <= 23 else None
    if isinstance(value, str):
        digits = value.split("-", 1)[0].split(":", 1)[0].strip()
        if digits.isdigit():
            hour = int(digits)
            return hour if 0 <= hour <= 23 else None
    return None
