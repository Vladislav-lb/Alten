from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from battery_store import BatteryStore
from config import load_settings
from modbus.client import ModbusBatteryClient, PymodbusTcpTransport
from mqtt.client import EmsMqttClient
from optimizer.arbitrage import BatteryEnvelope, PriceSlot, optimize_arbitrage
from plan_store import PlanStore
from price_service import MarketPriceService, PriceDataUnavailable
from sensors import HomeAssistantSensorClient

settings = load_settings()
app = FastAPI(title="Alten EMS Backend")
plan_store = PlanStore(settings.data_dir)
mqtt_client = EmsMqttClient(
    host=settings.mqtt_host,
    port=settings.mqtt_port,
    username=settings.mqtt_username,
    password=settings.mqtt_password,
)
ha_sensor_client = HomeAssistantSensorClient(settings.ha_url, settings.ha_token)

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

DEFAULT_BATTERIES = []

price_service = MarketPriceService(
    data_dir=settings.data_dir,
    api_key=settings.oree_api_key,
    prices_url=settings.oree_prices_url,
    zone_eic=settings.oree_zone_eic,
    date_param=settings.oree_date_param,
    allow_fallback=settings.allow_price_fallback,
    fallback_prices=DEFAULT_PRICES,
)

modbus_clients = {}
battery_store = BatteryStore(settings.data_dir, DEFAULT_BATTERIES)


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
    prices: list[Any] | None = None
    battery: BatteryModel | None = None
    min_margin: float = Field(default=500, ge=0)
    reserve_soc_percent: float | None = Field(default=None, ge=0, le=100)
    cycle_cost_per_mwh: float = Field(default=0, ge=0)
    status: Literal["draft", "confirmed", "applied", "failed"] = "draft"


class PlanApplyRequest(BaseModel):
    plan: dict[str, Any]
    status: Literal["draft", "confirmed", "applied", "failed"] = "confirmed"


class ManualCommand(BaseModel):
    battery_id: str = "virtual"
    power_kw: float = Field(default=0, ge=0)
    start_time: str | None = None
    end_time: str | None = None
    use_range: bool = False


class MqttPublishRequest(BaseModel):
    battery_id: str = "virtual"
    payload: dict[str, Any]


class TelemetryIngestRequest(BaseModel):
    battery_id: str = "virtual"
    telemetry: dict[str, Any]


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
            background: #15181d;
          }
        </style>
      </head>
      <body>
        <alten-ems-card></alten-ems-card>
      </body>
    </html>
    """


@app.get("/api/prices")
async def get_prices(date: str | None = None, zone_eic: str | None = None):
    try:
        return await price_service.get_prices(date, zone_eic)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except PriceDataUnavailable as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/batteries")
async def get_batteries():
    return await get_batteries_with_telemetry()


@app.get("/api/batteries/{battery_id}")
async def get_battery(battery_id: str):
    battery = battery_store.get(battery_id)
    if battery is None:
        raise HTTPException(status_code=404, detail=f"Unknown battery: {battery_id}")
    return await enrich_battery_telemetry(battery)


@app.post("/api/batteries")
def upsert_battery(battery: dict[str, Any]):
    saved = battery_store.upsert(battery)
    refresh_modbus_clients()
    return {"ok": True, "battery": saved}


@app.delete("/api/batteries/{battery_id}")
def delete_battery(battery_id: str):
    removed = battery_store.remove(battery_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Unknown battery: {battery_id}")
    refresh_modbus_clients()
    return {"ok": True, "deleted": battery_id}


@app.post("/api/batteries/{battery_id}/telemetry")
def ingest_battery_telemetry(battery_id: str, request: TelemetryIngestRequest | dict[str, Any]):
    telemetry = request.get("telemetry", request) if isinstance(request, dict) else request.telemetry
    try:
        battery = battery_store.update_telemetry(battery_id, normalize_telemetry(telemetry))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown battery: {battery_id}") from None
    return {"ok": True, "battery": battery}


@app.post("/api/plan/optimize")
def optimize_plan(request: OptimizeRequest):
    if request.battery is None:
        raise HTTPException(status_code=400, detail="Battery envelope is required for optimization")
    battery = request.battery
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
    battery_id = command.battery_id if command else "virtual"
    await send_battery_command(battery_id, "idle", 0)
    saved = plan_store.set_status("failed")
    return {"ok": True, "service": "alten_ems.emergency_stop", "current_plan": saved}


@app.post("/api/services/alten_ems/manual_charge")
async def ha_manual_charge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "charge", command.power_kw)
    return {"ok": True, "service": "alten_ems.manual_charge", "schedule": manual_schedule(command), **result}


@app.post("/api/services/alten_ems/manual_discharge")
async def ha_manual_discharge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "discharge", command.power_kw)
    return {"ok": True, "service": "alten_ems.manual_discharge", "schedule": manual_schedule(command), **result}


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
    prices: list[Any],
    battery: BatteryModel,
    min_margin: float,
    reserve_soc_percent: float | None,
    cycle_cost_per_mwh: float,
) -> dict[str, Any]:
    slots = [price_slot_from_input(item, index) for index, item in enumerate(prices[:24])]
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


def price_slot_from_input(item: Any, index: int) -> PriceSlot:
    if isinstance(item, dict):
        price = float(item.get("price") or item.get("value") or item.get("rdn") or 0)
        raw_time = item.get("time") or item.get("datetime") or item.get("start")
        return PriceSlot(time=parse_slot_time(raw_time, index), price=price)
    return PriceSlot(time=parse_slot_time(None, index), price=float(item or 0))


def parse_slot_time(value: Any, index: int) -> datetime:
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=index)


async def get_batteries_with_telemetry() -> list[dict[str, Any]]:
    return [await enrich_battery_telemetry(battery) for battery in battery_store.list()]


async def enrich_battery_telemetry(battery: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(battery)
    telemetry = dict(enriched.get("telemetry") or {})

    ha_telemetry = await ha_sensor_client.read_battery_sensors(enriched)
    telemetry.update({key: value for key, value in ha_telemetry.items() if value is not None})

    connection = enriched.get("connection") or {}
    if connection.get("type") in {"modbus_tcp", "modbus_rs485"} and enriched["id"] in modbus_clients:
        telemetry.update(await modbus_clients[enriched["id"]].read_telemetry())
        telemetry["source"] = connection.get("type")
        telemetry["last_seen"] = datetime.now(timezone.utc).isoformat()

    normalized = normalize_telemetry(telemetry)
    enriched["telemetry"] = normalized
    enriched["soc_percent"] = normalized.get("soc_percent", enriched.get("soc_percent", 0))
    enriched["power_kw"] = normalized.get("power_kw", enriched.get("power_kw", 0))
    enriched["status"] = normalized.get("status", "unknown")
    enriched["online"] = bool(normalized.get("last_seen"))
    return enriched


def normalize_telemetry(telemetry: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(telemetry)
    if "soc" in normalized and "soc_percent" not in normalized:
        normalized["soc_percent"] = normalized["soc"]
    if "powerKw" in normalized and "power_kw" not in normalized:
        normalized["power_kw"] = normalized["powerKw"]
    return normalized


def manual_schedule(command: ManualCommand) -> dict[str, Any] | None:
    if not command.use_range:
        return None
    return {
        "start_time": command.start_time,
        "end_time": command.end_time,
        "use_range": command.use_range,
    }


async def send_battery_command(battery_id: str, mode: Literal["idle", "charge", "discharge"], power_kw: float):
    if battery_id == "virtual":
        targets = [battery for battery in battery_store.list() if battery.get("enabled", True)]
        results = [
            await send_battery_command(str(battery["id"]), mode, power_kw)
            for battery in targets
            if battery.get("id")
        ]
        return {
            "battery_id": battery_id,
            "mode": mode,
            "power_kw": power_kw,
            "targets": results,
        }

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
    clients = {}
    for battery in battery_store.list():
        connection = battery.get("connection") or {}
        if connection.get("type") == "modbus_tcp" and connection.get("host"):
            clients[battery["id"]] = ModbusBatteryClient(
                PymodbusTcpTransport(connection["host"], int(connection.get("port", 502))),
                unit=int(connection.get("unit", 1)),
            )
    if clients:
        return clients
    if settings.modbus_host:
        return {
            "modbus_default": ModbusBatteryClient(
                PymodbusTcpTransport(settings.modbus_host, settings.modbus_port),
                unit=settings.modbus_unit,
            )
        }
    return {}


modbus_clients.update(build_modbus_clients())


def refresh_modbus_clients() -> None:
    modbus_clients.clear()
    modbus_clients.update(build_modbus_clients())
