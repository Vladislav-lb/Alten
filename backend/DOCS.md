# Alten EMS Backend Add-on

Alten EMS Backend runs a local FastAPI service for BESS planning, dispatch,
Modbus, MQTT, and Home Assistant EMS service endpoints.

## API

After starting the add-on, open the Web UI button or:

```text
http://homeassistant.local:8000/dashboard
```

Useful endpoints:

- `/api/prices`
- `/api/batteries`
- `/api/plan/optimize`
- `/api/plan/current`
- `/api/plan/history`

Frontend card resource served by the add-on:

```text
http://homeassistant.local:8000/frontend/alten-ems-card.js
```

You can use this resource URL in Lovelace if you do not want to copy the card
files into `/config/www`.

## Options

- `cors_origins`: Comma-separated origins. Use `*` for local lab setups.
- `mqtt_host`: Optional MQTT broker host. Empty means dry-run mode.
- `mqtt_port`: MQTT port, usually `1883`.
- `mqtt_username` / `mqtt_password`: Optional MQTT credentials.
- `modbus_host`: Optional Modbus TCP gateway host. Empty means memory test mode.
- `modbus_port`: Modbus TCP port, usually `502`.
- `modbus_unit`: Modbus unit/slave id.

## Persistent Data

The add-on stores plan data in `/data`:

```text
/data/current_plan.json
/data/history/
```

These files survive add-on restarts.
