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
- `grid_charging_switch`: Home Assistant switch that enables inverter grid
  charging. The default is `switch.inverter_battery_grid_charging`.
- `control_channel`: Single active control path for EMS commands. Use
  `home_assistant` for the HA switch, `modbus` for direct inverter registers, or
  `mqtt` when a real MQTT command subscriber controls the inverter.

## Grid Charging Dispatch

When `control_channel` is `home_assistant`, a confirmed plan checks the current
hourly slot. If that slot is `charge`, it calls `switch.turn_on` for
`grid_charging_switch`; if the slot is `idle` or `discharge`, it calls
`switch.turn_off`.

The add-on also checks the saved current plan every minute, so the switch
changes automatically when the next hourly slot starts. Manual controls use the
same switch: `manual_charge` turns it on, while `manual_discharge` and
`emergency_stop` turn it off.

Use only one real control channel at a time. For the current Home Assistant
inverter setup, `home_assistant` is the safest default because the switch entity
already exists. Use Modbus only after the inverter register map is verified. Use
MQTT only when a bridge or automation is subscribed to the EMS command topics.

## Real Battery Sensor Mapping

Configure batteries from the add-on dashboard:

1. Open the add-on Web UI.
2. Go to `Моніторинг`.
3. Press `+ Нова батарея`.
4. Fill the Home Assistant sensor entity ids and press `Зберегти батарею`.

The same configuration is also available through:

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
these sensors exist in Home Assistant. Use the `Видалити` button on a battery
card to remove test or obsolete batteries from the persistent add-on storage.

## Persistent Data

The add-on stores plan data in `/data`:

```text
/data/current_plan.json
/data/history/
```

These files survive add-on restarts.
