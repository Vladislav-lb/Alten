# Alten EMS Platform

Industrial Energy Management System for BESS fleets, built for Home Assistant
and designed to grow into a standalone EMS repository.

The project includes:

- Home Assistant custom card frontend.
- FastAPI backend for prices, batteries, planning, Modbus, MQTT, and plan history.
- Home Assistant add-on packaging that serves both backend API and frontend UI.
- Frontend API client and chart panel for price, SOC, and hourly profit.
- Deterministic arbitrage optimizer with SOC protection and hourly profit.
- Home Assistant services for operator commands.
- Docker, CI, tests, and documentation scaffolding.

## Repository Layout

```text
frontend/
  alten-ems-card.js
  backend-service.js
  battery-manager.js
  plan-calculator.js
  price-service.js
  ha-service.js
  ui-renderer.js
  styles.css
backend/
  app.py
  config.py
  requirements.txt
  plan_store.py
  api/
  scheduler/
  optimizer/
  mqtt/
  modbus/
  data/
homeassistant/
  custom_components/alten_ems/
  addon/
docs/
tests/
```

## Quick Start Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Verify:

```text
http://localhost:8000
http://localhost:8000/dashboard
http://localhost:8000/api/prices
http://localhost:8000/api/batteries
```

Create an optimized plan:

```bash
curl -X POST http://localhost:8000/api/plan/optimize \
  -H "Content-Type: application/json" \
  -d '{"min_margin":500,"reserve_soc_percent":10,"status":"draft"}'
```

## Home Assistant

Frontend card:

```yaml
resources:
  - url: http://192.168.110.94:8000/frontend/alten-ems-card.js
    type: module
```

Card example:

```yaml
type: custom:alten-ems-card
title: Alten EMS
reserve_soc: 10
price_api_url: http://192.168.110.94:8000/api/prices
batteries:
  - id: batt_1
    name: ALTEN Battery 1
    group: ALTEN
    capacityKwh: 215
    maxChargeKw: 125
    maxDischargeKw: 125
    minSoc: 10
    maxSoc: 95
    roundtripEfficiency: 0.92
```

Custom services are available through:

```text
homeassistant/custom_components/alten_ems
```

Services:

- `alten_ems.apply_plan`
- `alten_ems.emergency_stop`
- `alten_ems.manual_charge`
- `alten_ems.manual_discharge`

See [Home Assistant guide](docs/HOME_ASSISTANT.md).

## Optimizer

The optimizer supports:

- Buy during cheap hours.
- Sell during expensive hours.
- Minimum margin threshold.
- Minimum SOC protection.
- Roundtrip efficiency, default `92%`.
- Max charge/discharge power.
- Hourly profit calculation.
- Plan statuses: `draft`, `confirmed`, `applied`, `failed`.

Plans are stored in:

```text
backend/data/current_plan.json
backend/data/history/
```

## Modbus and MQTT

Modbus:

- Read SOC.
- Read power.
- Write `idle`, `charge`, `discharge`.
- Supports TCP, RS485 transport classes, and memory transport for local testing.

MQTT:

- Telemetry publishing.
- Home Assistant MQTT discovery payloads.
- Command topics.
- Dry-run mode when no broker is configured.

See [API reference](docs/API.md) and [architecture](docs/ARCHITECTURE.md).

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Backend runs on:

```text
http://localhost:8000
```

## Tests

```bash
python3 -m unittest discover -s tests
npm run check:frontend
```

Or:

```bash
make test
```

## Environment

Copy `.env.example` to `.env` and configure:

- `ALTEN_EMS_DATA_DIR`
- `ALTEN_EMS_MQTT_HOST`
- `ALTEN_EMS_MODBUS_HOST`
- `ALTEN_EMS_CORS_ORIGINS`

## Roadmap

- Persist battery definitions in JSON or SQLite.
- Add scheduler jobs for automatic daily planning.
- Add WebSocket realtime updates.
- Add Grafana/Node-RED integration examples.
- Package Home Assistant add-on as a publishable add-on repository.
