# Home Assistant Installation

## Frontend Card

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

## Backend via SSH / Terminal Add-on

```bash
cd /config/Alten/alten-ems/backend
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
