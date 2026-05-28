# API Reference

Base URL during local development:

```text
http://localhost:8000
```

## Core

- `GET /` returns backend status.
- `GET /api/prices` returns 24 hourly prices.
- `GET /api/batteries` returns configured BESS assets.

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
