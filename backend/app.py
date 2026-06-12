import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from battery_store import BatteryStore
from command_store import CommandStore
from config import load_settings
from dispatch import find_current_slot, should_enable_grid_charging, slot_key, slot_power_kw
from modbus.client import ModbusBatteryClient, PymodbusTcpTransport
from mqtt.client import EmsMqttClient
from optimizer.arbitrage import BatteryEnvelope, PriceSlot, optimize_arbitrage
from plan_store import PlanStore
from price_service import MarketPriceService, PriceDataUnavailable
from sensors import HomeAssistantSensorClient

settings = load_settings()
app = FastAPI(title="Alten EMS Backend")
plan_store = PlanStore(settings.data_dir)
command_store = CommandStore(settings.data_dir)
runtime_settings_path = settings.data_dir / "ems_settings.json"
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
dispatch_task: asyncio.Task | None = None
price_history_task: asyncio.Task | None = None
last_plan_dispatch_key: str | None = None
last_grid_charging_state: bool | None = None
runtime_settings: dict[str, Any] = {}


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
        "control_channel": active_control_channel(),
        "safety_checks_enabled": active_safety_checks_enabled(),
        "mqtt": "configured" if settings.mqtt_host else "dry-run",
        "modbus": "configured" if settings.modbus_host else "memory",
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "status": "healthy",
        "service": "alten-ems",
        "control_channel": active_control_channel(),
        "safety_checks_enabled": active_safety_checks_enabled(),
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.on_event("startup")
async def start_plan_dispatcher():
    global dispatch_task, price_history_task
    if dispatch_task is None:
        dispatch_task = asyncio.create_task(plan_dispatch_loop())
    if price_history_task is None:
        price_history_task = asyncio.create_task(price_history_loop())


@app.on_event("shutdown")
async def stop_plan_dispatcher():
    if dispatch_task:
        dispatch_task.cancel()
        try:
            await dispatch_task
        except asyncio.CancelledError:
            pass
    if price_history_task:
        price_history_task.cancel()
        try:
            await price_history_task
        except asyncio.CancelledError:
            pass


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
async def apply_plan(request: PlanApplyRequest | dict[str, Any]):
    if isinstance(request, dict):
        plan = request
        status = "confirmed"
    else:
        plan = request.plan
        status = request.status

    saved = plan_store.save(plan, status)
    dispatch = await dispatch_plan_now(saved, force=True)
    return {
        "ok": True,
        "message": "Plan received",
        "status": status,
        "current_plan": saved,
        "plan": plan,
        "dispatch": dispatch,
    }


@app.get("/api/plan/current")
def get_current_plan():
    return plan_store.load_current()


@app.get("/api/plan/history")
def get_plan_history(limit: int = 20):
    return plan_store.list_history(limit=limit)


@app.post("/api/plan/dispatch-current")
async def dispatch_current_plan():
    return await dispatch_current_saved_plan(force=True)


@app.get("/api/dispatch/status")
def get_dispatch_status():
    return command_store.load_status()


@app.get("/api/commands/history")
def get_command_history(limit: int = 50):
    return command_store.list(limit=limit)


@app.get("/api/settings")
def get_settings():
    return current_settings_payload()


@app.post("/api/settings")
def update_settings(payload: dict[str, Any]):
    allowed_channels = {"home_assistant", "modbus", "mqtt"}
    next_settings = dict(runtime_settings)
    if "control_channel" in payload:
        channel = str(payload["control_channel"]).strip().lower()
        if channel not in allowed_channels:
            raise HTTPException(status_code=400, detail="control_channel must be home_assistant, modbus, or mqtt")
        next_settings["control_channel"] = channel
    if "grid_charging_switch" in payload:
        next_settings["grid_charging_switch"] = str(payload["grid_charging_switch"]).strip()
    if "safety_checks_enabled" in payload:
        next_settings["safety_checks_enabled"] = parse_runtime_bool(payload["safety_checks_enabled"])
    save_runtime_settings(next_settings)
    return current_settings_payload()


@app.post("/api/services/alten_ems/apply_plan")
async def ha_apply_plan(request: PlanApplyRequest):
    saved = plan_store.save(request.plan, "applied")
    dispatch = await dispatch_plan_now(saved, force=True)
    return {"ok": True, "service": "alten_ems.apply_plan", "current_plan": saved, "dispatch": dispatch}


@app.post("/api/services/alten_ems/emergency_stop")
async def ha_emergency_stop(command: ManualCommand | None = None):
    battery_id = command.battery_id if command else "virtual"
    result = await send_battery_command(battery_id, "idle", 0, source="emergency_stop")
    saved = plan_store.set_status("failed")
    return {"ok": True, "service": "alten_ems.emergency_stop", "current_plan": saved, **result}


@app.post("/api/services/alten_ems/manual_charge")
async def ha_manual_charge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "charge", command.power_kw, source="manual_charge")
    return {"ok": True, "service": "alten_ems.manual_charge", "schedule": manual_schedule(command), **result}


@app.post("/api/services/alten_ems/manual_discharge")
async def ha_manual_discharge(command: ManualCommand):
    result = await send_battery_command(command.battery_id, "discharge", command.power_kw, source="manual_discharge")
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


async def send_battery_command(
    battery_id: str,
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
    control_grid_switch: bool = True,
    source: str = "manual",
):
    result = await dispatch_command(battery_id, mode, power_kw, force=True, source=source) if control_grid_switch else None
    return {
        "battery_id": battery_id,
        "mode": mode,
        "power_kw": power_kw,
        "control": result,
    }


async def plan_dispatch_loop() -> None:
    while True:
        try:
            await dispatch_current_saved_plan()
        except Exception:
            pass
        await asyncio.sleep(60)


async def price_history_loop() -> None:
    while True:
        try:
            await price_service.get_prices()
        except Exception:
            pass
        await asyncio.sleep(6 * 60 * 60)


async def dispatch_current_saved_plan(force: bool = False) -> dict[str, Any]:
    current = plan_store.load_current()
    return await dispatch_plan_now(current, force=force)


async def dispatch_plan_now(current_plan: dict[str, Any], force: bool = False) -> dict[str, Any]:
    global last_plan_dispatch_key
    plan = current_plan.get("plan") if isinstance(current_plan, dict) else current_plan
    slot = find_current_slot(plan)
    if not slot:
        return {
            "ok": True,
            "skipped": True,
            "reason": "No plan slot matches the current hour",
        }

    enabled = should_enable_grid_charging(slot)
    key = slot_key(slot, enabled)
    if not force and key == last_plan_dispatch_key:
        return {
            "ok": True,
            "skipped": True,
            "reason": "Grid charging switch already dispatched for this slot",
            "grid_charging": enabled,
            "slot": summarize_dispatch_slot(slot),
        }

    switch_result = await dispatch_command(
        "virtual",
        "charge" if enabled else "idle",
        slot_power_kw(slot),
        force=force,
        source="plan_dispatch",
    )
    if switch_result.get("ok") or switch_result.get("skipped"):
        last_plan_dispatch_key = key
    return {
        "ok": bool(switch_result.get("ok") or switch_result.get("skipped")),
        "grid_charging": enabled,
        "slot": summarize_dispatch_slot(slot),
        "control": switch_result,
    }


async def set_grid_charging_for_mode(
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
    force: bool = False,
) -> dict[str, Any]:
    enabled = mode == "charge" and power_kw > 0
    return await set_grid_charging_switch(enabled, force=force)


async def dispatch_command(
    battery_id: str,
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
    force: bool = False,
    source: str = "manual",
) -> dict[str, Any]:
    safety = await evaluate_command_safety(battery_id, mode, power_kw)
    effective_power_kw = min(power_kw, safety["max_power_kw"]) if mode != "idle" else 0
    if not safety["allowed"]:
        result = {
            "ok": False,
            "blocked": True,
            "channel": active_control_channel(),
            "source": source,
            "battery_id": battery_id,
            "mode": mode,
            "power_kw": power_kw,
            "effective_power_kw": effective_power_kw,
            "safety": safety,
        }
        return record_command_result(result)

    channel = active_control_channel()
    if channel == "home_assistant":
        result = await set_grid_charging_for_mode(mode, effective_power_kw, force=force)
    elif channel == "modbus":
        result = await write_modbus_control(battery_id, mode, effective_power_kw)
    elif channel == "mqtt":
        result = await publish_mqtt_control(battery_id, mode, effective_power_kw)
    else:
        result = {
            "ok": False,
            "channel": channel,
            "error": f"Unsupported control channel: {channel}",
        }

    result = {
        **result,
        "channel": result.get("channel") or channel,
        "source": source,
        "battery_id": battery_id,
        "mode": mode,
        "power_kw": power_kw,
        "effective_power_kw": effective_power_kw,
        "safety": safety,
    }
    return record_command_result(result)


async def evaluate_command_safety(
    battery_id: str,
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
) -> dict[str, Any]:
    targets = await read_safety_targets(battery_id)
    max_power_kw = aggregate_power_limit(targets, mode)
    checks = []

    if not active_safety_checks_enabled() or mode == "idle":
        return {
            "enabled": active_safety_checks_enabled(),
            "allowed": True,
            "max_power_kw": max_power_kw if max_power_kw > 0 else power_kw,
            "checks": checks,
            "targets": summarize_safety_targets(targets),
        }

    if not targets:
        checks.append({"ok": False, "reason": "No enabled battery telemetry is available"})

    for battery in targets:
        name = battery.get("name") or battery.get("id")
        soc = number_or_none(battery.get("soc_percent"))
        status = str(battery.get("status") or "").strip()
        min_soc = number_or_none(battery.get("min_soc_percent")) or 0
        max_soc = number_or_none(battery.get("max_soc_percent")) or 100

        if mode == "charge" and soc is not None and soc >= max_soc - 0.2:
            checks.append({"ok": False, "battery_id": battery.get("id"), "reason": f"{name} SOC is already at max limit"})
        if mode == "discharge" and soc is not None and soc <= min_soc + 0.2:
            checks.append({"ok": False, "battery_id": battery.get("id"), "reason": f"{name} SOC is at minimum reserve"})
        if has_blocking_status(status):
            checks.append({"ok": False, "battery_id": battery.get("id"), "reason": f"{name} status blocks EMS control: {status}"})

    if power_kw > max_power_kw > 0:
        checks.append({
            "ok": True,
            "reason": f"Power limited from {power_kw} kW to {max_power_kw} kW",
        })

    blockers = [check for check in checks if check.get("ok") is False]
    return {
        "enabled": True,
        "allowed": not blockers,
        "max_power_kw": max_power_kw if max_power_kw > 0 else power_kw,
        "checks": checks,
        "targets": summarize_safety_targets(targets),
    }


async def read_safety_targets(battery_id: str) -> list[dict[str, Any]]:
    source = battery_store.list() if battery_id == "virtual" else [battery_store.get(battery_id)]
    targets = []
    for battery in source:
        if not battery or not battery.get("enabled", True):
            continue
        targets.append(await enrich_battery_telemetry(battery))
    return targets


def aggregate_power_limit(targets: list[dict[str, Any]], mode: str) -> float:
    key = "max_charge_kw" if mode == "charge" else "max_discharge_kw"
    return sum(max(0.0, number_or_none(target.get(key)) or 0.0) for target in targets)


def summarize_safety_targets(targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": battery.get("id"),
            "name": battery.get("name"),
            "soc_percent": battery.get("soc_percent"),
            "power_kw": battery.get("power_kw"),
            "status": battery.get("status"),
            "online": battery.get("online"),
        }
        for battery in targets
    ]


def has_blocking_status(status: str) -> bool:
    normalized = status.strip().lower()
    if not normalized or normalized in {"ok", "idle", "normal", "online", "connected"}:
        return False
    return any(token in normalized for token in ("fault", "alarm", "error", "fail", "trip", "protect"))


def record_command_result(result: dict[str, Any]) -> dict[str, Any]:
    ok = bool(result.get("ok") or result.get("skipped"))
    entry = command_store.append({
        **result,
        "ok": ok,
    })
    command_store.save_status({
        "ok": ok,
        "source": result.get("source"),
        "channel": result.get("channel") or active_control_channel(),
        "battery_id": result.get("battery_id"),
        "mode": result.get("mode"),
        "power_kw": result.get("power_kw"),
        "effective_power_kw": result.get("effective_power_kw"),
        "blocked": bool(result.get("blocked")),
        "safety": result.get("safety"),
        "result": result,
        "command_id": entry["id"],
    })
    return entry


def number_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_runtime_settings() -> dict[str, Any]:
    try:
        payload = json.loads(runtime_settings_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def save_runtime_settings(payload: dict[str, Any]) -> None:
    global runtime_settings
    runtime_settings = dict(payload)
    runtime_settings_path.parent.mkdir(parents=True, exist_ok=True)
    runtime_settings_path.write_text(json.dumps(runtime_settings, ensure_ascii=False, indent=2), encoding="utf-8")


def active_control_channel() -> str:
    return str(runtime_settings.get("control_channel") or settings.control_channel).strip().lower()


def active_grid_charging_switch() -> str | None:
    value = runtime_settings.get("grid_charging_switch")
    if value is None:
        return settings.grid_charging_switch
    return str(value).strip() or None


def active_safety_checks_enabled() -> bool:
    if "safety_checks_enabled" in runtime_settings:
        return parse_runtime_bool(runtime_settings["safety_checks_enabled"])
    return settings.safety_checks_enabled


def current_settings_payload() -> dict[str, Any]:
    return {
        "control_channel": active_control_channel(),
        "grid_charging_switch": active_grid_charging_switch(),
        "safety_checks_enabled": active_safety_checks_enabled(),
        "defaults": {
            "control_channel": settings.control_channel,
            "grid_charging_switch": settings.grid_charging_switch,
            "safety_checks_enabled": settings.safety_checks_enabled,
        },
        "runtime": runtime_settings,
    }


def parse_runtime_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def unsupported_channel_result(channel: str) -> dict[str, Any]:
    return {
        "ok": False,
        "channel": channel,
        "error": f"Unsupported control channel: {channel}",
    }


async def write_modbus_control(
    battery_id: str,
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
) -> dict[str, Any]:
    targets = resolve_control_targets(battery_id)
    if not targets:
        return {
            "ok": False,
            "channel": "modbus",
            "reason": "No active Modbus target is configured",
        }

    results = []
    for target in targets:
        client = modbus_clients.get(target)
        if not client:
            results.append({"battery_id": target, "ok": False, "reason": "No Modbus client"})
            continue
        await client.write_command(mode, power_kw)
        results.append({"battery_id": target, "ok": True, "mode": mode, "power_kw": power_kw})

    return {
        "ok": any(result.get("ok") for result in results),
        "channel": "modbus",
        "targets": results,
    }


async def publish_mqtt_control(
    battery_id: str,
    mode: Literal["idle", "charge", "discharge"],
    power_kw: float,
) -> dict[str, Any]:
    await mqtt_client.connect()
    targets = resolve_control_targets(battery_id) or [battery_id]
    results = []
    for target in targets:
        topic, payload = await mqtt_client.publish_command(target, mode, power_kw)
        results.append({"battery_id": target, "ok": True, "topic": topic, "payload": payload})
    return {
        "ok": True,
        "channel": "mqtt",
        "targets": results,
    }


def resolve_control_targets(battery_id: str) -> list[str]:
    if battery_id != "virtual":
        return [battery_id]
    return [
        str(battery["id"])
        for battery in battery_store.list()
        if battery.get("id") and battery.get("enabled", True)
    ]


async def set_grid_charging_switch(enabled: bool, force: bool = False) -> dict[str, Any]:
    global last_grid_charging_state
    entity_id = active_grid_charging_switch()
    if not force and last_grid_charging_state is enabled:
        return {
            "ok": True,
            "skipped": True,
            "reason": "Grid charging switch is already in requested state",
            "entity_id": entity_id,
            "state": "on" if enabled else "off",
        }
    result = await ha_sensor_client.set_switch(entity_id, enabled)
    if result.get("ok"):
        last_grid_charging_state = enabled
    return result


def summarize_dispatch_slot(slot: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": slot.get("time"),
        "hour": slot.get("hour"),
        "mode": slot.get("mode"),
        "power_kw": slot_power_kw(slot),
        "price": slot.get("price"),
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


runtime_settings.update(load_runtime_settings())
