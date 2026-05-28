# API Reference

Base URL during local development:

```text
http://localhost:8000
```

## Core

- `GET /` returns backend status.
- `GET /api/prices` returns 24 hourly prices.
- `GET /api/batteries` returns configured BESS assets.
- `GET /api/batteries/{battery_id}` returns one BESS asset with live telemetry.
- `POST /api/batteries` creates or updates a battery definition.
- `DELETE /api/batteries/{battery_id}` removes a battery definition.
- `POST /api/batteries/{battery_id}/telemetry` ingests external telemetry.

Example real battery configuration:

```json
{
  "id": "batt_1",
  "name": "ALTEN Battery 1",
  "group": "ALTEN",
  "capacity_kwh": 215,
  "max_charge_kw": 125,
  "max_discharge_kw": 125,
  "min_soc_percent": 10,
  "max_soc_percent": 95,
  "efficiency_percent": 92,
  "protocol": "home_assistant",
  "connection": {"type": "home_assistant"},
  "sensors": {
    "soc": "sensor.battery_soc",
    "power": "sensor.battery_power",
    "voltage": "sensor.battery_voltage",
    "current": "sensor.battery_current",
    "temperature": "sensor.battery_temperature",
    "status": "sensor.battery_status"
  }
}
```

Modbus TCP battery configuration:

```json
{
  "id": "batt_modbus_1",
  "name": "Modbus Battery 1",
  "capacity_kwh": 215,
  "max_charge_kw": 125,
  "max_discharge_kw": 125,
  "protocol": "modbus_tcp",
  "connection": {
    "type": "modbus_tcp",
    "host": "192.168.110.50",
    "port": 502,
    "unit": 1
  }
}
```

## Plan Lifecycle

- `POST /api/plan/optimize` creates an optimized plan and saves it as `draft`.
- `POST /api/plan/apply` stores an externally supplied plan.
- `GET /api/plan/current` returns `backend/data/current_plan.json`.
- `GET /api/plan/history` returns recent historical plan snapshots.

Example optimize request:

```json
{
  "min_margin": 500,
  "reserve_soc_percent": 10,
  "cycle_cost_per_mwh": 0,
  "status": "draft"
}
```

## Home Assistant Service Endpoints

- `POST /api/services/alten_ems/apply_plan`
- `POST /api/services/alten_ems/emergency_stop`
- `POST /api/services/alten_ems/manual_charge`
- `POST /api/services/alten_ems/manual_discharge`

## Modbus

- `GET /api/modbus/{battery_id}/telemetry`
- `POST /api/modbus/{battery_id}/command?mode=charge&power_kw=50`

If `ALTEN_EMS_MODBUS_HOST` is empty, the backend uses an in-memory Modbus
transport for local testing.

## MQTT

- `POST /api/mqtt/discovery/{battery_id}`
- `POST /api/mqtt/telemetry`
- `POST /api/mqtt/command/{battery_id}?mode=discharge&power_kw=50`

If `ALTEN_EMS_MQTT_HOST` is empty, MQTT runs in dry-run mode and records
published messages in memory.
