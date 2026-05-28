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
    soc_start: float
    soc_end: float
    profit: float
    reason: str


def optimize_arbitrage(
    prices: Iterable[PriceSlot],
    battery: BatteryEnvelope,
    reserve_soc: float | None = None,
    interval_hours: float = 1.0,
    cycle_cost_per_mwh: float = 0.0,
) -> list[DispatchSlot]:
    """Deterministic hourly arbitrage optimizer used by API and scheduler.

    The implementation is intentionally dependency-light so it can run in edge
    gateways. It uses price percentiles plus forward spread checks, then applies
    SOC, efficiency, and max-power constraints.
    """

    ordered = sorted(prices, key=lambda slot: slot.time)
    if not ordered or battery.capacity_kwh <= 0:
        return []

    min_soc = max(battery.min_soc, reserve_soc if reserve_soc is not None else battery.min_soc)
    max_soc = battery.max_soc
    soc = _clamp(battery.soc, min_soc, max_soc)
    charge_efficiency = sqrt(_clamp(battery.roundtrip_efficiency, 0.5, 1.0))
    discharge_efficiency = charge_efficiency
    cheap_cutoff = _percentile([slot.price for slot in ordered], 0.35)
    expensive_cutoff = _percentile([slot.price for slot in ordered], 0.65)
    plan: list[DispatchSlot] = []

    for index, slot in enumerate(ordered):
        soc_start = soc
        future_prices = [item.price for item in ordered[index + 1 :]]
        future_max = max(future_prices, default=slot.price)

        mode: Mode = "idle"
        power_kw = 0.0
        reason = "Hold for better spread"

        if slot.price <= cheap_cutoff and soc < max_soc - 0.5 and future_max > slot.price / battery.roundtrip_efficiency:
            mode = "charge"
            power_kw = battery.max_charge_kw
            reason = "Low price window"
        elif slot.price >= expensive_cutoff and soc > min_soc + 0.5:
            mode = "discharge"
            power_kw = battery.max_discharge_kw
            reason = "High price window"

        bounded = _bound(mode, power_kw, battery, soc, min_soc, max_soc, interval_hours, charge_efficiency, discharge_efficiency)
        mode, power_kw, grid_energy_kwh, battery_energy_kwh = bounded

        if mode == "charge":
            soc += battery_energy_kwh / battery.capacity_kwh * 100
            profit = -grid_energy_kwh / 1000 * slot.price - battery_energy_kwh / 1000 * cycle_cost_per_mwh
        elif mode == "discharge":
            soc -= battery_energy_kwh / battery.capacity_kwh * 100
            profit = grid_energy_kwh / 1000 * slot.price - battery_energy_kwh / 1000 * cycle_cost_per_mwh
        else:
            profit = 0.0

        soc = _clamp(soc, min_soc, max_soc)
        plan.append(
            DispatchSlot(
                time=slot.time,
                price=slot.price,
                mode=mode,
                power_kw=round(power_kw, 3),
                energy_kwh=round(grid_energy_kwh, 3),
                soc_start=round(soc_start, 2),
                soc_end=round(soc, 2),
                profit=round(profit, 2),
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


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int((len(ordered) - 1) * ratio)
    return ordered[index]


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))
