# Architecture

Alten EMS is split into three deployable surfaces.

## Frontend

`frontend/` contains a vanilla JavaScript Home Assistant custom card:

- `alten-ems-card.js` custom element lifecycle and Home Assistant bridge.
- `battery-manager.js` virtual battery aggregation and weighted SOC.
- `plan-calculator.js` browser-side optimizer and CSV export support.
- `price-service.js` price API, Home Assistant entity, cache, and fallback source.
- `ha-service.js` Home Assistant service wrapper.
- `ui-renderer.js` operator UI renderer.

## Backend

`backend/` contains the FastAPI control plane and is also the Home Assistant
add-on folder:

- `app.py` REST API and Home Assistant service endpoints.
- `config.yaml`, `Dockerfile`, `run.sh`, and `DOCS.md` define the add-on.
- `frontend/` is the packaged frontend served by the add-on.
- `optimizer/arbitrage.py` deterministic dispatch optimizer.
- `plan_store.py` current plan and history persistence.
- `modbus/client.py` Modbus TCP, RS485, and memory test transports.
- `mqtt/client.py` MQTT telemetry, command, and discovery publisher.
- `scheduler/` async scheduler boundary for recurring jobs.

## Home Assistant

`homeassistant/custom_components/alten_ems` registers real Home Assistant
services that forward commands to the backend.

`homeassistant/addon` is the starting point for packaging the backend as a
Home Assistant add-on.
