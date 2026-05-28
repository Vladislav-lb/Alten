export class BackendService extends EventTarget {
  constructor({ config = {}, baseUrl = null } = {}) {
    super();
    this.config = config;
    this.baseUrl = baseUrl;
  }

  setConfig(config = {}) {
    this.config = config;
  }

  async fetchBatteries() {
    const payload = await this.getJson("/api/batteries");
    return normalizeBackendBatteries(payload);
  }

  async optimizePlan({ prices = [], virtualBattery, options = {} }) {
    const payload = await this.postJson("/api/plan/optimize", {
      prices: prices.map((entry) => Number(entry.price ?? entry.value ?? entry)),
      battery: backendBatteryFromVirtual(virtualBattery, options),
      min_margin: Number(options.minMargin ?? this.config.min_margin ?? 500),
      reserve_soc_percent: Number(options.reserveSoc ?? this.config.reserve_soc ?? 10),
      cycle_cost_per_mwh: Number(options.cycleCostPerMwh ?? this.config.cycle_cost_per_mwh ?? 0),
      status: "draft",
    });
    return normalizeBackendPlan(payload);
  }

  async applyPlan(plan) {
    return this.postJson("/api/plan/apply", {
      plan: {
        id: `frontend_${new Date().toISOString()}`,
        slots: plan,
        summary: summarizePlan(plan),
      },
      status: "confirmed",
    });
  }

  async manualControl({ batteryId, mode, powerKw }) {
    const service = mode === "charge"
      ? "/api/services/alten_ems/manual_charge"
      : mode === "discharge"
        ? "/api/services/alten_ems/manual_discharge"
        : "/api/services/alten_ems/emergency_stop";
    return this.postJson(service, {
      battery_id: batteryId || "batt_1",
      power_kw: Number(powerKw) || 0,
    });
  }

  async getJson(path) {
    const response = await fetch(this.resolveUrl(path), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Backend request failed: ${response.status}`);
    return response.json();
  }

  async postJson(path, payload) {
    const response = await fetch(this.resolveUrl(path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Backend request failed: ${response.status}`);
    return response.json();
  }

  resolveUrl(path) {
    const configured = this.config.backend_url || this.config.backendUrl;
    if (configured) return new URL(path, ensureTrailingSlash(configured)).toString();
    if (this.baseUrl) return new URL(path, this.baseUrl).toString();
    return path;
  }
}

export function getDefaultBackendBase(importMetaUrl) {
  try {
    return new URL("../", importMetaUrl).toString();
  } catch {
    return null;
  }
}

export function normalizeBackendBatteries(payload = []) {
  const items = Array.isArray(payload) ? payload : payload.batteries || payload.items || [];
  return items.map((battery) => ({
    id: battery.id,
    name: battery.name || battery.id,
    site: battery.site || "default",
    region: battery.region || "default",
    group: battery.group || "ALTEN",
    enabled: battery.enabled !== false,
    capacityKwh: Number(battery.capacityKwh ?? battery.capacity_kwh ?? 0),
    minSoc: Number(battery.minSoc ?? battery.min_soc_percent ?? 10),
    maxSoc: Number(battery.maxSoc ?? battery.max_soc_percent ?? 95),
    maxChargeKw: Number(battery.maxChargeKw ?? battery.max_charge_kw ?? 0),
    maxDischargeKw: Number(battery.maxDischargeKw ?? battery.max_discharge_kw ?? 0),
    roundtripEfficiency: Number(battery.roundtripEfficiency ?? battery.efficiency_percent / 100 ?? 0.92),
    protocol: battery.protocol || "backend",
    telemetry: {
      soc: Number(battery.soc ?? battery.soc_percent ?? 50),
      powerKw: Number(battery.powerKw ?? battery.power_kw ?? 0),
      status: battery.status || "idle",
      lastSeen: new Date().toISOString(),
    },
  })).filter((battery) => battery.id && battery.capacityKwh > 0);
}

export function normalizeBackendPlan(payload = {}) {
  const slots = payload.slots || payload.plan?.slots || [];
  const plan = slots.map((slot, index) => ({
    id: `slot-${slot.hour ?? index}`,
    time: slot.time || new Date(Date.now() + index * 3600000).toISOString(),
    hour: String(slot.hour ?? index).padStart(2, "0"),
    price: Number(slot.price) || 0,
    mode: slot.mode || "idle",
    powerKw: Number(slot.power_kw ?? slot.powerKw ?? 0),
    energyKwh: Number(slot.energy_kwh ?? slot.energyKwh ?? 0),
    batteryEnergyKwh: Number(slot.battery_energy_kwh ?? slot.batteryEnergyKwh ?? 0),
    socStart: Number(slot.soc_start ?? slot.socStart ?? 0),
    socEnd: Number(slot.soc_end ?? slot.socEnd ?? 0),
    profit: Number(slot.profit) || 0,
    reason: slot.reason || "Backend optimized",
    locked: false,
  }));
  return {
    plan,
    summary: {
      chargeKwh: Number(payload.summary?.charge_kwh ?? payload.summary?.chargeKwh ?? 0),
      dischargeKwh: Number(payload.summary?.discharge_kwh ?? payload.summary?.dischargeKwh ?? 0),
      profit: Number(payload.summary?.profit ?? plan.reduce((sum, entry) => sum + entry.profit, 0)),
      finalSoc: Number(payload.summary?.final_soc ?? payload.summary?.finalSoc ?? plan.at(-1)?.socEnd ?? 0),
      activeHours: plan.filter((entry) => entry.mode !== "idle").length,
    },
    generatedAt: new Date().toISOString(),
    source: "backend",
  };
}

function backendBatteryFromVirtual(virtualBattery = {}, options = {}) {
  return {
    id: "virtual",
    name: "Virtual BESS",
    capacity_kwh: Number(virtualBattery.capacityKwh) || 0,
    max_charge_kw: Number(virtualBattery.maxChargeKw) || 0,
    max_discharge_kw: Number(virtualBattery.maxDischargeKw) || 0,
    min_soc_percent: Number(options.reserveSoc ?? virtualBattery.minSoc ?? 10),
    max_soc_percent: Number(virtualBattery.maxSoc) || 95,
    soc_percent: Number(virtualBattery.soc) || 0,
    efficiency_percent: Number(options.efficiency ?? 92),
  };
}

function summarizePlan(plan = []) {
  return {
    charge_kwh: plan.filter((entry) => entry.mode === "charge").reduce((sum, entry) => sum + entry.energyKwh, 0),
    discharge_kwh: plan.filter((entry) => entry.mode === "discharge").reduce((sum, entry) => sum + entry.energyKwh, 0),
    profit: plan.reduce((sum, entry) => sum + entry.profit, 0),
    final_soc: plan.at(-1)?.socEnd ?? 0,
  };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}
