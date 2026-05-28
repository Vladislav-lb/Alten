from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from backend.optimizer.arbitrage import BatteryEnvelope, PriceSlot, optimize_arbitrage


app = FastAPI(
    title="Alten EMS API",
    version="0.1.0",
    description="REST API for BESS EMS planning, dispatch, and telemetry ingestion.",
)


class BatteryEnvelopeModel(BaseModel):
    capacity_kwh: float = Field(gt=0)
    soc: float = Field(ge=0, le=100)
    min_soc: float = Field(ge=0, le=100)
    max_soc: float = Field(ge=0, le=100)
    max_charge_kw: float = Field(ge=0)
    max_discharge_kw: float = Field(ge=0)
    roundtrip_efficiency: float = Field(default=0.9, ge=0.5, le=1)


class PriceSlotModel(BaseModel):
    time: datetime
    price: float
    market: str = "RDN"
    currency: str = "UAH"


class OptimizeRequest(BaseModel):
    battery: BatteryEnvelopeModel
    prices: list[PriceSlotModel]
    reserve_soc: float | None = Field(default=None, ge=0, le=100)
    cycle_cost_per_mwh: float = Field(default=0, ge=0)


class DispatchSlotModel(BaseModel):
    time: datetime
    price: float
    mode: Literal["idle", "charge", "discharge"]
    power_kw: float
    energy_kwh: float
    soc_start: float
    soc_end: float
    profit: float
    reason: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/optimize", response_model=list[DispatchSlotModel])
def optimize(request: OptimizeRequest) -> list[DispatchSlotModel]:
    if request.battery.min_soc >= request.battery.max_soc:
        raise HTTPException(status_code=400, detail="min_soc must be lower than max_soc")

    plan = optimize_arbitrage(
        prices=[PriceSlot(**model_dump(slot)) for slot in request.prices],
        battery=BatteryEnvelope(**model_dump(request.battery)),
        reserve_soc=request.reserve_soc,
        cycle_cost_per_mwh=request.cycle_cost_per_mwh,
    )
    return [DispatchSlotModel(**slot.__dict__) for slot in plan]


@app.post("/api/v1/dispatch/confirm")
def confirm_dispatch(plan: list[DispatchSlotModel]) -> dict[str, int | str]:
    # Persist to durable storage or publish to MQTT/Modbus scheduler in production.
    return {"status": "accepted", "slots": len(plan)}


def model_dump(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()
