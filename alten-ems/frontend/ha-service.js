export class HomeAssistantService extends EventTarget {
  constructor({ hass = null, config = {} } = {}) {
    super();
    this.hass = hass;
    this.config = config;
  }

  setHass(hass) {
    this.hass = hass;
  }

  setConfig(config = {}) {
    this.config = config;
  }

  getEntity(entityId) {
    return entityId && this.hass?.states ? this.hass.states[entityId] || null : null;
  }

  readBatteriesFromEntities(configBatteries = []) {
    return configBatteries.map((battery) => {
      const socEntity = this.getEntity(battery.soc_entity);
      const powerEntity = this.getEntity(battery.power_entity);
      const statusEntity = this.getEntity(battery.status_entity);
      const temperatureEntity = this.getEntity(battery.temperature_entity);

      return {
        ...battery,
        telemetry: {
          soc: numericState(socEntity, battery.telemetry?.soc ?? 50),
          powerKw: numericState(powerEntity, battery.telemetry?.powerKw ?? 0),
          status: statusEntity?.state || battery.telemetry?.status || "idle",
          temperature: numericState(temperatureEntity, battery.telemetry?.temperature ?? null),
          lastSeen: new Date().toISOString(),
        },
      };
    });
  }

  async callService(domain, service, data = {}, target = {}) {
    if (!this.hass?.callService) {
      throw new Error("Home Assistant service API is not available.");
    }
    return this.hass.callService(domain, service, data, target);
  }

  async manualControl({ batteryId, mode, powerKw }) {
    const service = this.config.services?.manual_control || {};
    if (service.domain && service.service) {
      return this.callService(service.domain, service.service, {
        battery_id: batteryId,
        mode,
        power_kw: Number(powerKw) || 0,
      });
    }
    return this.createNotification(
      "EMS manual control",
      `Manual command queued: ${batteryId || "virtual"} ${mode} ${powerKw || 0} kW`,
    );
  }

  async confirmPlan(plan = []) {
    const service = this.config.services?.confirm_plan || {};
    if (service.domain && service.service) {
      return this.callService(service.domain, service.service, { plan });
    }
    return this.createNotification("EMS plan confirmed", `${plan.length} hourly slots confirmed.`);
  }

  async emergencyStop() {
    const service = this.config.services?.emergency_stop || {};
    if (service.domain && service.service) {
      return this.callService(service.domain, service.service);
    }
    return this.createNotification("EMS emergency stop", "Emergency stop requested.");
  }

  async publishMqttDiscovery(device) {
    const service = this.config.services?.mqtt_publish || { domain: "mqtt", service: "publish" };
    if (!service.domain || !service.service) return null;
    const topic = `homeassistant/sensor/alten_ems_${device.id}/config`;
    const payload = {
      name: `Alten EMS ${device.name}`,
      state_topic: `alten/ems/${device.id}/state`,
      unique_id: `alten_ems_${device.id}`,
      device: {
        identifiers: [`alten_ems_${device.id}`],
        name: device.name,
        manufacturer: "Alten",
        model: "BESS EMS",
      },
    };
    return this.callService(service.domain, service.service, {
      topic,
      payload: JSON.stringify(payload),
      retain: true,
    });
  }

  async createNotification(title, message) {
    if (!this.hass?.callService) return null;
    return this.callService("persistent_notification", "create", { title, message });
  }
}

function numericState(entity, fallback = 0) {
  if (!entity) return fallback;
  const value = Number(entity.state);
  return Number.isFinite(value) ? value : fallback;
}
