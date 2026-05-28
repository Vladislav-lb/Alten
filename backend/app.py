from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import load_settings
from modbus.client import MemoryRegisterTransport, ModbusBatteryClient, PymodbusTcpTransport
from mqtt.client import EmsMqttClient
from optimizer.arbitrage import BatteryEnvelope, PriceSlot, optimize_arbitrage
from plan_store import PlanStore

settings = load_settings()
app = FastAPI(title="Alten EMS Backend")
plan_store = PlanStore(settings.data_dir)
mqtt_client = EmsMqttClient(
    host=settings.mqtt_host,
    port=settings.mqtt_port,
    username=settings.mqtt_username,
    password=settings.mqtt_password,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")


DEFAULT_PRICES = [
    9000, 7600, 6877, 6800, 7000, 7222,
    7766.99, 8000, 6700, 5550, 1650, 30,
    10, 10, 10, 44, 643, 1700,
    5957, 9939, 13700, 15000, 15000, 11000
]

DEFAULT_BATTERIES = [
    {
        "id": "batt_1",
        "name": "ALTEN Battery 1",
        "capacity_kwh": 215,
        "max_charge_kw": 125,
        "max_discharge_kw": 125,
        "min_soc_percent": 10,
        "max_soc_percent": 95,
        "soc_percent": 50,
        "power_kw": 0,
        "efficiency_percent": 92
    }
]

modbus_clients = {}


class BatteryModel(BaseModel):
    id: str = "batt_1"
    name: str = "ALTEN Battery 1"
    capacity_kwh: float = Field(default=215, gt=0)
    max_charge_kw: float = Field(default=125, ge=0)
    max_discharge_kw: float = Field(default=125, ge=0)
    min_soc_percent: float = Field(default=10, ge=0, le=100)
    max_soc_percent: float = Field(default=95, ge=0, le=100)
    soc_percent: float = Field(default=50, ge=0, le=100)
    efficiency_percent: float = Field(default=92, ge=50, le=100)
    initial_energy_cost: float = Field(default=0, ge=0)


class OptimizeRequest(BaseModel):
    prices: list[float] | None = None
    battery: BatteryModel | None = None
    min_margin: float = Field(default=500, ge=0)
    reserve_soc_percent: float | None = Field(default=None, ge=0, le=100)
    cycle_cost_per_mwh: float = Field(default=0, ge=0)
    status: Literal["draft", "confirmed", "applied", "failed"] = "draft"


class PlanApplyRequest(BaseModel):
    plan: dict[str, Any]
    status: Literal["draft", "confirmed", "applied", "failed"] = "confirmed"


class ManualCommand(BaseModel):
    battery_id: str = "batt_1"
    power_kw: float = Field(default=0, ge=0)


class MqttPublishRequest(BaseModel):
    battery_id: str = "batt_1"
    payload: dict[str, Any]


@app.get("/")
def root():
    return {
        "status": "Alten EMS Backend running",
        "dashboard": "/dashboard",
        "frontend_resource": "/frontend/alten-ems-card.js",
        "mqtt": "configured" if settings.mqtt_host else "dry-run",
        "modbus": "configured" if settings.modbus_host else "memory",
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "status": "healthy",
        "service": "alten-ems",
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard():
    return """
    <!doctype html>
    <html lang="uk">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Alten EMS Dashboard</title>
        <script type="module" src="/frontend/alten-ems-card.js"></script>
        <style>
          body {
            margin: 0;
            background: #f3f3f3;
          }
        </style>
      </head>
      <body>
        <alten-ems-card></alten-ems-card>
      </body>
    </html>
    """


@app.get("/api/prices")
def get_prices():
    return DEFAULT_PRICES


@app.get("/api/batteries")
def get_batteries():
    return DEFAULT_BATTERIES


@app.post("/api/plan/optimize")
def optimize_plan(request: OptimizeRequest):
    battery = request.battery or BatteryModel(**DEFAULT_BATTERIES[0])
    prices = request.prices or DEFAULT_PRICES
    plan = build_plan(
        prices=prices,
        battery=battery,
        min_margin=request.min_margin,
        reserve_soc_percent=request.reserve_soc_percent,
        cycle_cost_per_mwh=request.cycle_cost_per_mwh,
    )
    saved = plan_store.save(plan, request.status)
    return {
        "ok": True,
        "status": saved["status"],
        "current_plan": saved,
        **plan,
    }


@app.post("/api/plan/apply")
def apply_plan(request: PlanApplyRequest | dict[str, Any]):
    if isinstance(request, dict):
        plan = request
        status = "confirmed"
    else:
        plan = request.plan
        status = request.status

    saved = plan_store.save(plan, status)
    return {
        "ok": True,
        "message": "Plan received",
        "status": status,
        "current_plan": saved,
        "plan": plan,
    }


@app.get("/api/plan/current")
def get_current_plan():
    return plan_store.load_current()


@app.get("/api/plan/history")
def get_plan_history(limit: int = 20):
    return plan_store.list_history(limit=limit)


@app.post("/api/services/alten_ems/apply_plan")
def ha_apply_plan(request: PlanApplyRequest):
    saved = plan_store.save(request.plan, "applied")
    return {"ok": True, "service": "alten_ems.apply_plan", "current_plan": saved}


@app.post("/api/services/alten_ems/emergency_stop")
async def ha_emergency_stop(command: ManualCommand | None = None):
    battery_id = command.battery_id if command else "batt_1"
    await send_battery_command(battery_id, "idle", 0)
    saved = plan_store.set_status("failed")
    return {"ok": True, "service": "alten_ems.emergency_stop", "current_plan": saved}


@app.post("/api/services/alten_ems/manual_charge")
async def ha_manual_charge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "charge", command.power_kw)
    return {"ok": True, "service": "alten_ems.manual_charge", **result}


@app.post("/api/services/alten_ems/manual_discharge")
async def ha_manual_discharge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "discharge", command.power_kw)
    return {"ok": True, "service": "alten_ems.manual_discharge", **result}


@app.get("/api/modbus/{battery_id}/telemetry")
async def read_modbus_telemetry(battery_id: str):
    client = modbus_clients.get(battery_id)
    if not client:
        raise HTTPException(status_code=404, detail=f"Unknown battery: {battery_id}")
    return {"battery_id": battery_id, "telemetry": await client.read_telemetry()}


@app.post("/api/modbus/{battery_id}/command")
async def write_modbus_command(battery_id: str, mode: Literal["idle", "charge", "discharge"], power_kw: float = 0):
    client = modbus_clients.get(battery_id)
    if not client:
        raise HTTPException(status_code=404, detail=f"Unknown battery: {battery_id}")
    await client.write_command(mode, power_kw)
    return {"ok": True, "battery_id": battery_id, "mode": mode, "power_kw": power_kw}


@app.post("/api/mqtt/discovery/{battery_id}")
async def publish_mqtt_discovery(battery_id: str, name: str = "ALTEN Battery"):
    await mqtt_client.connect()
    topic, payload = await mqtt_client.publish_discovery(battery_id, name)
    return {"ok": True, "topic": topic, "payload": payload}


@app.post("/api/mqtt/telemetry")
async def publish_mqtt_telemetry(request: MqttPublishRequest):
    await mqtt_client.connect()
    topic, payload = await mqtt_client.publish_telemetry(request.battery_id, request.payload)
    return {"ok": True, "topic": topic, "payload": payload}


@app.post("/api/mqtt/command/{battery_id}")
async def publish_mqtt_command(battery_id: str, mode: Literal["idle", "charge", "discharge"], power_kw: float = 0):
    await mqtt_client.connect()
    topic, payload = await mqtt_client.publish_command(battery_id, mode, power_kw)
    return {"ok": True, "topic": topic, "payload": payload}


def build_plan(
    prices: list[float],
    battery: BatteryModel,
    min_margin: float,
    reserve_soc_percent: float | None,
    cycle_cost_per_mwh: float,
) -> dict[str, Any]:
    slots = [
        PriceSlot(
            time=datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=index),
            price=price,
        )
        for index, price in enumerate(prices[:24])
    ]
    optimized = optimize_arbitrage(
        prices=slots,
        battery=BatteryEnvelope(
            capacity_kwh=battery.capacity_kwh,
            soc=battery.soc_percent,
            min_soc=battery.min_soc_percent,
            max_soc=battery.max_soc_percent,
            max_charge_kw=battery.max_charge_kw,
            max_discharge_kw=battery.max_discharge_kw,
            roundtrip_efficiency=battery.efficiency_percent / 100,
            initial_energy_cost=battery.initial_energy_cost,
        ),
        reserve_soc=reserve_soc_percent,
        min_margin_per_mwh=min_margin,
        cycle_cost_per_mwh=cycle_cost_per_mwh,
    )
    slot_payload = [
        {
            "hour": index,
            "time": slot.time.isoformat(),
            "price": slot.price,
            "mode": slot.mode,
            "power_kw": slot.power_kw,
            "energy_kwh": slot.energy_kwh,
            "battery_energy_kwh": slot.battery_energy_kwh,
            "soc_start": slot.soc_start,
            "soc_end": slot.soc_end,
            "profit": slot.profit,
            "stored_energy_kwh": slot.stored_energy_kwh,
            "average_energy_cost": slot.average_energy_cost,
            "reason": slot.reason,
        }
        for index, slot in enumerate(optimized)
    ]
    return {
        "id": f"plan_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "battery_id": battery.id,
        "min_margin": min_margin,
        "reserve_soc_percent": reserve_soc_percent or battery.min_soc_percent,
        "efficiency_percent": battery.efficiency_percent,
        "slots": slot_payload,
        "summary": {
            "charge_kwh": round(sum(slot["energy_kwh"] for slot in slot_payload if slot["mode"] == "charge"), 3),
            "discharge_kwh": round(sum(slot["energy_kwh"] for slot in slot_payload if slot["mode"] == "discharge"), 3),
            "profit": round(sum(slot["profit"] for slot in slot_payload), 2),
            "final_soc": slot_payload[-1]["soc_end"] if slot_payload else battery.soc_percent,
        },
    }


async def send_battery_command(battery_id: str, mode: Literal["idle", "charge", "discharge"], power_kw: float):
    modbus_result = None
    if battery_id in modbus_clients:
        await modbus_clients[battery_id].write_command(mode, power_kw)
        modbus_result = {"mode": mode, "power_kw": power_kw}

    await mqtt_client.connect()
    topic, payload = await mqtt_client.publish_command(battery_id, mode, power_kw)
    return {
        "battery_id": battery_id,
        "mode": mode,
        "power_kw": power_kw,
        "modbus": modbus_result,
        "mqtt": {"topic": topic, "payload": payload},
    }


def build_modbus_clients():
    if settings.modbus_host:
        return {
            "batt_1": ModbusBatteryClient(
                PymodbusTcpTransport(settings.modbus_host, settings.modbus_port),
                unit=settings.modbus_unit,
            )
        }
    return {
        "batt_1": ModbusBatteryClient(
            MemoryRegisterTransport({
                100: 500,
                101: 0,
                102: 0,
                103: 0,
                104: 0,
            }),
        )
    }


modbus_clients.update(build_modbus_clients())
