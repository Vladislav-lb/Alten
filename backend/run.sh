#!/usr/bin/env sh
set -eu

OPTIONS_FILE="/data/options.json"

read_option() {
  key="$1"
  default="$2"
  python3 - "$OPTIONS_FILE" "$key" "$default" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
default = sys.argv[3]

if not path.exists():
    print(default)
    raise SystemExit

value = json.loads(path.read_text(encoding="utf-8")).get(key, default)
print(value if value is not None else "")
PY
}

export ALTEN_EMS_HOST="0.0.0.0"
export ALTEN_EMS_PORT="8000"
export ALTEN_EMS_DATA_DIR="/data"

if [ -f "$OPTIONS_FILE" ]; then
  export ALTEN_EMS_CORS_ORIGINS="$(read_option cors_origins "*")"
  export ALTEN_EMS_MQTT_HOST="$(read_option mqtt_host "")"
  export ALTEN_EMS_MQTT_PORT="$(read_option mqtt_port "1883")"
  export ALTEN_EMS_MQTT_USERNAME="$(read_option mqtt_username "")"
  export ALTEN_EMS_MQTT_PASSWORD="$(read_option mqtt_password "")"
  export ALTEN_EMS_MODBUS_HOST="$(read_option modbus_host "")"
  export ALTEN_EMS_MODBUS_PORT="$(read_option modbus_port "502")"
  export ALTEN_EMS_MODBUS_UNIT="$(read_option modbus_unit "1")"
  export ALTEN_EMS_HA_URL="$(read_option ha_url "http://supervisor/core/api")"
fi

mkdir -p /data/history

exec uvicorn app:app --host "$ALTEN_EMS_HOST" --port "$ALTEN_EMS_PORT"
