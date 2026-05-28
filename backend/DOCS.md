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
- `ha_url`: Home Assistant Core API URL. In add-on mode this defaults to
  `http://supervisor/core/api` and uses the Supervisor token automatically.

## Real Battery Sensor Mapping

Configure batteries through:

```http
POST /api/batteries
```

Example payload:

```json
{
  "id": "batt_1",
  "name": "ALTEN Battery 1",
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

The Monitoring tab reads `/api/batteries`, so it will show real telemetry when
these sensors exist in Home Assistant.

## Persistent Data

The add-on stores plan data in `/data`:

```text
/data/current_plan.json
/data/history/
```

These files survive add-on restarts.
