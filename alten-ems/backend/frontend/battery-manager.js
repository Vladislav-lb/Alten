export const DEFAULT_BATTERY = Object.freeze({
  id: "",
  name: "Battery",
  site: "default",
  region: "default",
  group: "main",
  enabled: true,
  capacityKwh: 100,
  minSoc: 15,
  maxSoc: 95,
  maxChargeKw: 50,
  maxDischargeKw: 50,
  roundtripEfficiency: 0.9,
  protocol: "ha",
  telemetry: {
    soc: 50,
    powerKw: 0,
    voltage: null,
    current: null,
    temperature: null,
    status: "idle",
    lastSeen: null,
  },
});

export class BatteryManager extends EventTarget {
  constructor({ batteries = [] } = {}) {
    super();
    this.batteries = new Map();
    this.setBatteries(batteries);
  }

  setBatteries(batteries = []) {
    this.batteries.clear();
    batteries.forEach((battery) => this.batteries.set(battery.id, normalizeBattery(battery)));
    this.emitChange();
  }

  upsertBattery(battery) {
    const current = this.batteries.get(battery.id) || {};
    const next = normalizeBattery({ ...current, ...battery });
    this.batteries.set(next.id, next);
    this.emitChange();
    return next;
  }

  removeBattery(id) {
    const removed = this.batteries.delete(id);
    if (removed) this.emitChange();
    return removed;
  }

  updateTelemetry(id, telemetry = {}) {
    const battery = this.batteries.get(id);
    if (!battery) return null;
    const next = normalizeBattery({
      ...battery,
      telemetry: {
        ...battery.telemetry,
        ...telemetry,
        lastSeen: telemetry.lastSeen || new Date().toISOString(),
      },
    });
    this.batteries.set(id, next);
    this.emitChange("telemetry");
    return next;
  }

  setEnabled(id, enabled) {
    return this.upsertBattery({ ...this.requireBattery(id), enabled: Boolean(enabled) });
  }

  setGroup(id, group) {
    return this.upsertBattery({ ...this.requireBattery(id), group: group || "main" });
  }

  requireBattery(id) {
    const battery = this.batteries.get(id);
    if (!battery) throw new Error(`Battery not found: ${id}`);
    return battery;
  }

  getBattery(id) {
    return this.batteries.get(id) || null;
  }

  getBatteries({ includeDisabled = true, group = null, site = null, region = null } = {}) {
    return [...this.batteries.values()].filter((battery) => {
      if (!includeDisabled && !battery.enabled) return false;
      if (group && battery.group !== group) return false;
      if (site && battery.site !== site) return false;
      if (region && battery.region !== region) return false;
      return true;
    });
  }

  getVirtualBattery(filters = {}) {
    return aggregateBatteries(this.getBatteries({ ...filters, includeDisabled: false }));
  }

  getGroupSummaries() {
    const groups = new Map();
    for (const battery of this.getBatteries()) {
      if (!groups.has(battery.group)) groups.set(battery.group, []);
      groups.get(battery.group).push(battery);
    }
    return [...groups.entries()].map(([group, batteries]) => ({
      group,
      ...aggregateBatteries(batteries.filter((battery) => battery.enabled)),
      totalCount: batteries.length,
      enabledCount: batteries.filter((battery) => battery.enabled).length,
    }));
  }

  emitChange(reason = "battery") {
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }
}

export function aggregateBatteries(batteries = []) {
  const enabled = batteries.filter((battery) => battery.enabled);
  const capacityKwh = enabled.reduce((sum, battery) => sum + battery.capacityKwh, 0);
  const weightedSocEnergy = enabled.reduce(
    (sum, battery) => sum + battery.capacityKwh * battery.telemetry.soc,
    0,
  );
  const soc = capacityKwh > 0 ? weightedSocEnergy / capacityKwh : 0;
  const minSoc = capacityKwh > 0
    ? enabled.reduce((sum, battery) => sum + battery.capacityKwh * battery.minSoc, 0) / capacityKwh
    : 0;
  const maxSoc = capacityKwh > 0
    ? enabled.reduce((sum, battery) => sum + battery.capacityKwh * battery.maxSoc, 0) / capacityKwh
    : 100;
  const roundtripEfficiency = capacityKwh > 0
    ? enabled.reduce(
      (sum, battery) => sum + battery.capacityKwh * battery.roundtripEfficiency,
      0,
    ) / capacityKwh
    : 0.9;

  return {
    id: "virtual",
    name: "Virtual BESS",
    enabled: enabled.length > 0,
    batteryCount: enabled.length,
    capacityKwh,
    soc,
    minSoc,
    maxSoc,
    maxChargeKw: enabled.reduce((sum, battery) => sum + battery.maxChargeKw, 0),
    maxDischargeKw: enabled.reduce((sum, battery) => sum + battery.maxDischargeKw, 0),
    powerKw: enabled.reduce((sum, battery) => sum + battery.telemetry.powerKw, 0),
    availableKwh: Math.max(0, capacityKwh * (soc - minSoc) / 100),
    headroomKwh: Math.max(0, capacityKwh * (maxSoc - soc) / 100),
    roundtripEfficiency,
  };
}

function normalizeBattery(input = {}) {
  const telemetry = { ...DEFAULT_BATTERY.telemetry, ...(input.telemetry || {}) };
  const id = String(input.id || input.entityId || cryptoRandomId()).trim();
  return {
    ...DEFAULT_BATTERY,
    ...input,
    id,
    enabled: input.enabled !== false,
    capacityKwh: positiveNumber(input.capacityKwh, DEFAULT_BATTERY.capacityKwh),
    minSoc: clamp(numberOr(input.minSoc, DEFAULT_BATTERY.minSoc), 0, 100),
    maxSoc: clamp(numberOr(input.maxSoc, DEFAULT_BATTERY.maxSoc), 0, 100),
    maxChargeKw: positiveNumber(input.maxChargeKw, DEFAULT_BATTERY.maxChargeKw),
    maxDischargeKw: positiveNumber(input.maxDischargeKw, DEFAULT_BATTERY.maxDischargeKw),
    roundtripEfficiency: clamp(
      numberOr(input.roundtripEfficiency, DEFAULT_BATTERY.roundtripEfficiency),
      0.5,
      1,
    ),
    telemetry: {
      ...telemetry,
      soc: clamp(numberOr(telemetry.soc, DEFAULT_BATTERY.telemetry.soc), 0, 100),
      powerKw: numberOr(telemetry.powerKw, 0),
    },
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `battery-${Math.random().toString(36).slice(2, 10)}`;
}
