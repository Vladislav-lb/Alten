from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import sqrt
from typing import Iterable, Literal


Mode = Literal["idle", "charge", "discharge"]


@dataclass(frozen=True)
class BatteryEnvelope:
    capacity_kwh: float
    soc: float
    min_soc: float
    max_soc: float
    max_charge_kw: float
    max_discharge_kw: float
    roundtrip_efficiency: float = 0.9
    initial_energy_cost: float = 0.0


@dataclass(frozen=True)
class PriceSlot:
    time: datetime
    price: float
    market: str = "RDN"
    currency: str = "UAH"


@dataclass(frozen=True)
class DispatchSlot:
    time: datetime
    price: float
    mode: Mode
    power_kw: float
    energy_kwh: float
    battery_energy_kwh: float
    soc_start: float
    soc_end: float
    profit: float
    stored_energy_kwh: float
    average_energy_cost: float
    reason: str


def optimize_arbitrage(
    prices: Iterable[PriceSlot],
    battery: BatteryEnvelope,
    reserve_soc: float | None = None,
    min_margin_per_mwh: float = 500.0,
    interval_hours: float = 1.0,
    cycle_cost_per_mwh: float = 0.0,
) -> list[DispatchSlot]:
    """Deterministic hourly EMS optimizer used by API and scheduler.

    The optimizer buys during cheap hours only when a future sell opportunity
    clears minimum margin after efficiency losses, sells during expensive hours,
    protects minimum SOC, respects max power, and calculates hourly profit.
    """

    ordered = sorted(prices, key=lambda slot: slot.time)
    if not ordered or battery.capacity_kwh <= 0:
        return []

    min_soc = max(battery.min_soc, reserve_soc if reserve_soc is not None else battery.min_soc)
    max_soc = battery.max_soc
    soc = _clamp(battery.soc, min_soc, max_soc)
    charge_efficiency = sqrt(_clamp(battery.roundtrip_efficiency, 0.5, 1.0))
    discharge_efficiency = charge_efficiency
    usable_capacity_kwh = battery.capacity_kwh * max(0.0, max_soc - min_soc) / 100
    charge_slots = _select_energy_slots(
        ordered,
        energy_target_kwh=usable_capacity_kwh,
        energy_per_slot_kwh=battery.max_charge_kw * interval_hours * charge_efficiency,
        reverse=False,
    )
    discharge_slots = _select_energy_slots(
        ordered,
        energy_target_kwh=usable_capacity_kwh,
        energy_per_slot_kwh=battery.max_discharge_kw * interval_hours / discharge_efficiency,
        reverse=True,
    )
    cheapest_price = min((ordered[index].price for index in charge_slots), default=min(slot.price for slot in ordered))
    most_expensive_price = max((ordered[index].price for index in discharge_slots), default=max(slot.price for slot in ordered))
    stored_energy_kwh = battery.capacity_kwh * max(0.0, soc - min_soc) / 100
    average_energy_cost = max(0.0, battery.initial_energy_cost)
    plan: list[DispatchSlot] = []

    for index, slot in enumerate(ordered):
        soc_start = soc
        profitable_buy = most_expensive_price * battery.roundtrip_efficiency - slot.price >= min_margin_per_mwh
        profitable_sell = slot.price - cheapest_price / max(battery.roundtrip_efficiency, 0.001) >= min_margin_per_mwh

        mode: Mode = "idle"
        power_kw = 0.0
        reason = "Hold for better spread"

        if index in discharge_slots and soc > min_soc + 0.5 and profitable_sell:
            mode = "discharge"
            power_kw = battery.max_discharge_kw
            reason = "Sell in expensive hour"

        elif index in charge_slots and soc < max_soc - 5 and profitable_buy:
            mode = "charge"
            power_kw = battery.max_charge_kw
            reason = "Buy in cheap hour"

        bounded = _bound(mode, power_kw, battery, soc, min_soc, max_soc, interval_hours, charge_efficiency, discharge_efficiency)
        mode, power_kw, grid_energy_kwh, battery_energy_kwh = bounded

        if mode == "charge":
            previous_energy_kwh = stored_energy_kwh
            soc += battery_energy_kwh / battery.capacity_kwh * 100
            stored_energy_kwh += battery_energy_kwh
            energy_cost = grid_energy_kwh / 1000 * slot.price
            total_cost = previous_energy_kwh / 1000 * average_energy_cost + energy_cost
            average_energy_cost = total_cost / max(stored_energy_kwh / 1000, 0.001)
            profit = -energy_cost - battery_energy_kwh / 1000 * cycle_cost_per_mwh
        elif mode == "discharge":
            soc -= battery_energy_kwh / battery.capacity_kwh * 100
            revenue = grid_energy_kwh / 1000 * slot.price
            stored_cost = battery_energy_kwh / 1000 * average_energy_cost
            profit = revenue - stored_cost - battery_energy_kwh / 1000 * cycle_cost_per_mwh
            stored_energy_kwh = max(0.0, stored_energy_kwh - battery_energy_kwh)
        else:
            profit = 0.0

        soc = _clamp(soc, min_soc, max_soc)
        stored_energy_kwh = battery.capacity_kwh * max(0.0, soc - min_soc) / 100
        if stored_energy_kwh <= 0.001:
            average_energy_cost = 0.0
        plan.append(
            DispatchSlot(
                time=slot.time,
                price=slot.price,
                mode=mode,
                power_kw=round(power_kw, 3),
                energy_kwh=round(grid_energy_kwh, 3),
                battery_energy_kwh=round(battery_energy_kwh, 3),
                soc_start=round(soc_start, 2),
                soc_end=round(soc, 2),
                profit=round(profit, 2),
                stored_energy_kwh=round(stored_energy_kwh, 3),
                average_energy_cost=round(average_energy_cost, 2),
                reason=reason,
            )
        )

    return plan


def _bound(
    mode: Mode,
    power_kw: float,
    battery: BatteryEnvelope,
    soc: float,
    min_soc: float,
    max_soc: float,
    interval_hours: float,
    charge_efficiency: float,
    discharge_efficiency: float,
) -> tuple[Mode, float, float, float]:
    if mode == "charge":
        headroom_kwh = battery.capacity_kwh * (max_soc - soc) / 100
        battery_energy_kwh = min(power_kw * interval_hours * charge_efficiency, headroom_kwh)
        if battery_energy_kwh <= 0.001:
            return "idle", 0.0, 0.0, 0.0
        grid_energy_kwh = battery_energy_kwh / charge_efficiency
        return "charge", grid_energy_kwh / interval_hours, grid_energy_kwh, battery_energy_kwh

    if mode == "discharge":
        available_kwh = battery.capacity_kwh * (soc - min_soc) / 100
        battery_energy_kwh = min(power_kw * interval_hours / discharge_efficiency, available_kwh)
        if battery_energy_kwh <= 0.001:
            return "idle", 0.0, 0.0, 0.0
        grid_energy_kwh = battery_energy_kwh * discharge_efficiency
        return "discharge", grid_energy_kwh / interval_hours, grid_energy_kwh, battery_energy_kwh

    return "idle", 0.0, 0.0, 0.0


def _select_energy_slots(
    slots: list[PriceSlot],
    energy_target_kwh: float,
    energy_per_slot_kwh: float,
    reverse: bool,
) -> set[int]:
    if energy_target_kwh <= 0 or energy_per_slot_kwh <= 0:
        return set()
    ranked = sorted(enumerate(slots), key=lambda item: item[1].price, reverse=reverse)
    selected: set[int] = set()
    remaining = energy_target_kwh
    for index, _slot in ranked:
        if remaining <= 0:
            break
        selected.add(index)
        remaining -= energy_per_slot_kwh
    return selected


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))
