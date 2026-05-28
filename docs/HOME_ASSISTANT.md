# Home Assistant Installation

## Frontend Card

For a Lovelace dashboard such as:

```text
http://192.168.110.94:8123/dashboard-energy-2/energy
```

the card runs inside Home Assistant on port `8123`, while the EMS add-on backend
runs on port `8000`. Configure the card with:

```yaml
type: custom:alten-ems-card
backend_url: http://192.168.110.94:8000
price_api_url: http://192.168.110.94:8000/api/prices
```

Option A: use the add-on hosted resource:

```yaml
lovelace:
  resources:
    - url: http://192.168.110.94:8000/frontend/alten-ems-card.js
      type: module
```

Option B: copy `frontend/` to:

```text
/config/www/alten-ems/
```

Register the card:

```yaml
lovelace:
  resources:
    - url: /local/alten-ems/alten-ems-card.js
      type: module
```

The add-on Web UI also serves a standalone dashboard:

```text
http://192.168.110.94:8000/dashboard
```

## Connecting a Real Battery

After the add-on is running, configure a battery with existing Home Assistant
sensors:

```bash
curl -X POST http://192.168.110.94:8000/api/batteries \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

Replace the `sensor.battery_*` entity ids with the real entities from your Home
Assistant instance. The Monitoring tab reads `/api/batteries` every 10 seconds
and displays SOC, power, voltage, current, temperature, status, source, and last
seen time.

## Backend via SSH / Terminal Add-on

```bash
cd /config/Alten/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Verify:

```text
http://192.168.110.94:8000
http://192.168.110.94:8000/api/prices
```

## Custom Integration Services

Copy:

```text
homeassistant/custom_components/alten_ems
```

to:

```text
/config/custom_components/alten_ems
```

Add to `configuration.yaml`:

```yaml
alten_ems:
  url: http://127.0.0.1:8000
```

Restart Home Assistant. Services become available as:

- `alten_ems.apply_plan`
- `alten_ems.emergency_stop`
- `alten_ems.manual_charge`
- `alten_ems.manual_discharge`
