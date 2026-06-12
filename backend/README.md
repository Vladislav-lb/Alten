# Alten EMS Backend

This backend is a production-oriented scaffold for the EMS control plane.

## Modules

- `api/` exposes FastAPI endpoints for planning, confirmation, telemetry, and future auth.
- `optimizer/` contains deterministic arbitrage logic shared by API and scheduler.
- `scheduler/` runs recurring jobs for price refresh, planning, and dispatch execution.
- `mqtt/` defines MQTT telemetry, command, and Home Assistant discovery boundaries.
- `modbus/` defines Modbus TCP/RS485 register adapters for battery gateways.

## Suggested runtime

```bash
pip install fastapi uvicorn pydantic
uvicorn backend.api.main:app --reload
```

The current implementation keeps external IO behind adapter classes so the same
core logic can run locally, in Home Assistant add-ons, or in a cloud backend.

## Home Assistant SSH runtime

```bash
cd /config/Alten/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Core endpoints:

- `GET /api/prices`
- `GET /api/batteries`
- `POST /api/plan/optimize`
- `POST /api/plan/apply`
- `POST /api/plan/dispatch-current`
- `GET /api/plan/current`
- `GET /api/plan/history`
- `GET /api/dispatch/status`
- `GET /api/commands/history`
- `GET /api/settings`
- `POST /api/settings`
- `POST /api/services/alten_ems/apply_plan`
- `POST /api/services/alten_ems/emergency_stop`
- `POST /api/services/alten_ems/manual_charge`
- `POST /api/services/alten_ems/manual_discharge`
- `POST /api/services/alten_ems/grid_charging`
- `GET /api/modbus/{battery_id}/telemetry`
- `POST /api/modbus/{battery_id}/command`
- `POST /api/mqtt/discovery/{battery_id}`
- `POST /api/mqtt/telemetry`
- `POST /api/mqtt/command/{battery_id}`

## Home Assistant grid charging switch

Set `ALTEN_EMS_GRID_CHARGING_SWITCH` to the inverter switch that allows grid
charging. The add-on default is:

```text
switch.inverter_battery_grid_charging
```

Set `ALTEN_EMS_CONTROL_CHANNEL=home_assistant` to use this switch as the single
real command path. Confirmed plans are dispatched against the current hour. A
`charge` slot turns the switch on; `idle` and `discharge` slots turn it off. The
backend repeats this check every minute, and the manual charge/discharge/stop
services use the same switch.

Other supported control channels are `modbus` and `mqtt`, but they should not be
used at the same time as Home Assistant switch control. Use Modbus only with a
verified inverter register map. Use MQTT only when a real subscriber consumes
the `alten/ems/command/...` topics and applies them to the inverter.

The backend records every EMS command in `/data/command_log.jsonl` and stores
the latest dispatch state in `/data/dispatch_status.json`. The frontend status
panel reads these files through `/api/dispatch/status` and
`/api/commands/history`.

Safety checks are enabled by default. Charge commands are blocked near maximum
SOC, discharge commands are blocked at minimum reserve SOC, and alarm/fault
statuses block automatic control. The active control channel, switch entity, and
safety toggle can be changed from the frontend settings drawer or through
`POST /api/settings`.
