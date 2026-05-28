# Alten EMS Platform

Industrial EMS interface for BESS fleets, designed as a modular Home Assistant
custom card with backend-ready contracts for price optimization, MQTT, Modbus,
REST APIs, and future cloud scaling.

## Frontend

Copy `frontend/` to a Home Assistant `www/alten-ems/` directory and register:

```yaml
resources:
  - url: /local/alten-ems/alten-ems-card.js
    type: module
```

Lovelace card example:

```yaml
type: custom:alten-ems-card
title: Alten EMS
reserve_soc: 15
target_soc: 55
price_entity: sensor.rdn_hourly_prices
price_api_url: https://example.com/rdn/prices
batteries:
  - id: bess-1
    name: BESS Block 1
    group: main
    site: kyiv-site
    region: ua
    capacityKwh: 500
    maxChargeKw: 250
    maxDischargeKw: 250
    minSoc: 15
    maxSoc: 95
    roundtripEfficiency: 0.91
    protocol: modbus-tcp
    soc_entity: sensor.bess_1_soc
    power_entity: sensor.bess_1_power
    status_entity: sensor.bess_1_status
services:
  manual_control:
    domain: script
    service: alten_ems_manual_control
  confirm_plan:
    domain: script
    service: alten_ems_confirm_plan
  emergency_stop:
    domain: script
    service: alten_ems_emergency_stop
```

## Capabilities

- Virtual battery aggregation with weighted SOC and max-power limits.
- Dynamic battery enable/disable, grouping, and selection.
- Hourly RDN price optimization with SOC reserve, max SOC, efficiency, and profit.
- Editable hourly plan table with manual locks and CSV export.
- Home Assistant entities, services, scripts, persistent notifications, and MQTT discovery support.
- Backend boundaries for FastAPI, scheduler jobs, MQTT, and Modbus TCP/RS485.

## Files

```text
frontend/
  alten-ems-card.js
  battery-manager.js
  plan-calculator.js
  price-service.js
  ha-service.js
  ui-renderer.js
  styles.css
backend/
  api/
  scheduler/
  optimizer/
  mqtt/
  modbus/
```
