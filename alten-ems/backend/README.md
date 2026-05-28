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
