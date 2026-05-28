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
cd /config/Alten/alten-ems/backend
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
- `GET /api/plan/current`
- `GET /api/plan/history`
- `POST /api/services/alten_ems/apply_plan`
- `POST /api/services/alten_ems/emergency_stop`
- `POST /api/services/alten_ems/manual_charge`
- `POST /api/services/alten_ems/manual_discharge`
- `GET /api/modbus/{battery_id}/telemetry`
- `POST /api/modbus/{battery_id}/command`
- `POST /api/mqtt/discovery/{battery_id}`
- `POST /api/mqtt/telemetry`
- `POST /api/mqtt/command/{battery_id}`
