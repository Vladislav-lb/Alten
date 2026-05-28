import { BackendService, getDefaultBackendBase } from "./backend-service.js";
import { BatteryManager } from "./battery-manager.js";
import { HomeAssistantService } from "./ha-service.js";
import { PlanCalculator } from "./plan-calculator.js";
import { PriceService } from "./price-service.js";
import { UIRenderer } from "./ui-renderer.js";

const DEFAULT_CONFIG = Object.freeze({
  title: "Alten EMS",
  reserve_soc: 15,
  target_soc: null,
  price_refresh_ms: 15 * 60 * 1000,
  min_margin: 500,
  efficiency: 92,
  use_min_soc: false,
  use_backend_optimizer: true,
  telemetry_refresh_ms: 10000,
  batteries: [
    {
      id: "bess-1",
      name: "BESS Block 1",
      group: "main",
      site: "site-a",
      region: "ua",
      capacityKwh: 500,
      maxChargeKw: 250,
      maxDischargeKw: 250,
      minSoc: 15,
      maxSoc: 95,
      roundtripEfficiency: 0.91,
      protocol: "modbus-tcp",
      telemetry: { soc: 48, powerKw: 0, status: "idle" },
    },
  ],
});

class AltenEmsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.contentRoot = document.createElement("div");
    this.shadowRoot.appendChild(this.contentRoot);
    this.config = { ...DEFAULT_CONFIG };
    this.alerts = [];
    this.manualTarget = "virtual";
    this.manualPowerKw = 0;
    this.manualChargePowerKw = 50;
    this.manualDischargePowerKw = 50;
    this.selectedBatteryId = null;
    this.activeView = "control";
    this.planOverrides = [];
    this.backendPlanResult = null;
    this.telemetryTimer = null;
    this.eventsBound = false;
    this.batteryManager = new BatteryManager({ batteries: DEFAULT_CONFIG.batteries });
    this.planCalculator = new PlanCalculator();
    this.haService = new HomeAssistantService({ config: this.config });
    this.backendService = new BackendService({
      config: this.config,
      baseUrl: getDefaultBackendBase(import.meta.url),
    });
    this.priceService = new PriceService({
      config: this.config,
      baseUrl: getDefaultBackendBase(import.meta.url),
    });
    this.renderer = new UIRenderer(this.contentRoot);
  }

  async connectedCallback() {
    await this.loadStyles();
    await this.renderer.mount();
    this.bindEvents();
    this.priceService.startAutoRefresh();
    await this.refreshBackendState();
    this.startTelemetryRefresh();
    this.priceService.refresh().catch((error) => this.addAlert(error.message, "warning"));
    this.render();
  }

  disconnectedCallback() {
    this.priceService.stopAutoRefresh();
    this.stopTelemetryRefresh();
    this.renderer.unmount();
  }

  startTelemetryRefresh() {
    this.stopTelemetryRefresh();
    const refreshMs = Number(this.config.telemetry_refresh_ms) || 10000;
    this.telemetryTimer = setInterval(() => {
      this.refreshBackendState().catch((error) => this.addAlert(error.message, "warning"));
    }, refreshMs);
  }

  stopTelemetryRefresh() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
  }

  setConfig(config) {
    this.config = deepMerge(DEFAULT_CONFIG, config || {});
    this.haService.setConfig(this.config);
    this.priceService.setConfig(this.config);
    this.backendService.setConfig(this.config);
    this.batteryManager.setBatteries(this.config.batteries || []);
    this.refreshBackendState().catch((error) => this.addAlert(error.message, "warning"));
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.haService.setHass(hass);
    this.priceService.setHass(hass);

    const batteries = this.haService.readBatteriesFromEntities(this.config.batteries || []);
    batteries.forEach((battery) => this.batteryManager.upsertBattery(battery));
    this.render();
  }

  getCardSize() {
    return 12;
  }

  static getStubConfig() {
    return DEFAULT_CONFIG;
  }

  bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    this.batteryManager.addEventListener("change", () => this.render());
    this.priceService.addEventListener("prices", () => this.render());
    this.priceService.addEventListener("error", (event) => this.addAlert(event.detail.error.message, "warning"));
    this.renderer.addEventListener("action", (event) => this.handleAction(event.detail));
    this.renderer.addEventListener("input", (event) => this.handleInput(event.detail));
  }

  handleInput({ field, id, value }) {
    if (field === "battery-enabled") {
      this.batteryManager.setEnabled(id, value);
      return;
    }

    if (field === "manual-target") {
      this.manualTarget = value;
      this.selectedBatteryId = value === "virtual" ? null : value;
      this.render();
      return;
    }

    if (field === "manual-power") {
      this.manualPowerKw = Number(value) || 0;
      return;
    }

    if (field === "manual-charge-power") {
      this.manualChargePowerKw = Number(value) || 0;
      return;
    }

    if (field === "manual-discharge-power") {
      this.manualDischargePowerKw = Number(value) || 0;
      return;
    }

    if (["min-margin", "efficiency", "min-soc"].includes(field)) {
      const configKey = field.replaceAll("-", "_");
      this.config = { ...this.config, [configKey]: Number(value) || 0 };
      this.render();
      return;
    }

    if (field === "use-min-soc") {
      this.config = { ...this.config, use_min_soc: Boolean(value) };
      this.render();
      return;
    }

    const currentPlan = this.getPlanResult().plan;
    const target = currentPlan.find((entry) => entry.id === id);
    if (!target) return;
    const override = { ...target, locked: true };

    if (field === "plan-mode") override.mode = value;
    if (field === "plan-power") override.powerKw = Math.max(0, Number(value) || 0);
    if (field === "plan-lock") override.locked = Boolean(value);
    if (field === "plan-buy") {
      override.powerKw = Math.max(0, Number(value) || 0);
      override.mode = override.powerKw > 0 ? "charge" : "idle";
    }
    if (field === "plan-sell") {
      override.powerKw = Math.max(0, Number(value) || 0);
      override.mode = override.powerKw > 0 ? "discharge" : "idle";
    }

    this.planOverrides = upsertById(this.planOverrides, override);
    this.render();
  }

  async handleAction({ action, id, mode }) {
    try {
      if (action === "refresh") {
        await this.refreshBackendState();
        await this.priceService.refresh();
      }
      if (action === "navigate") {
        this.activeView = id || "control";
      }
      if (action === "auto-plan") {
        this.planOverrides = [];
        await this.optimizePlan();
      }
      if (action === "clear-plan") this.planOverrides = this.getPlanResult().plan.map((entry) => ({
        ...entry,
        mode: "idle",
        powerKw: 0,
        locked: true,
      }));
      if (action === "select-all") {
        this.batteryManager.getBatteries().forEach((battery) => this.batteryManager.setEnabled(battery.id, true));
      }
      if (action === "clear-selection") {
        this.batteryManager.getBatteries().forEach((battery) => this.batteryManager.setEnabled(battery.id, false));
      }
      if (action === "select-battery") this.selectedBatteryId = id;
      if (action === "add-battery") this.addDemoBattery();
      if (action === "confirm-plan") await this.confirmPlan();
      if (action === "manual-control") {
        await this.backendService.manualControl({
          batteryId: this.selectedBatteryId || "virtual",
          mode,
          powerKw: this.getManualPower(mode),
        });
      }
      if (action === "emergency-stop") {
        await this.haService.emergencyStop();
        this.addAlert("Emergency stop requested by operator.", "critical");
      }
    } catch (error) {
      this.addAlert(error.message, "critical");
    }
    this.render();
  }

  getPlanResult() {
    if (this.backendPlanResult && this.planOverrides.length === 0) return this.backendPlanResult;
    return this.planCalculator.calculate({
      prices: this.priceService.getPrices(),
      virtualBattery: this.batteryManager.getVirtualBattery(),
      existingPlan: this.planOverrides,
      options: {
        reserveSoc: this.config.reserve_soc,
        targetSoc: this.config.target_soc,
        cycleCostPerMwh: this.config.cycle_cost_per_mwh || 0,
        maxCyclesPerDay: this.config.max_cycles_per_day || 1.5,
      },
    });
  }

  async refreshBackendState() {
    try {
      const batteries = await this.backendService.fetchBatteries();
      if (batteries.length) this.batteryManager.setBatteries(batteries);
    } catch (error) {
      this.addAlert(`Backend batteries unavailable: ${error.message}`, "warning");
    }
  }

  async optimizePlan() {
    if (!this.config.use_backend_optimizer) {
      this.backendPlanResult = null;
      return;
    }
    const result = await this.backendService.optimizePlan({
      prices: this.priceService.getPrices(),
      virtualBattery: this.batteryManager.getVirtualBattery(),
      options: {
        reserveSoc: this.config.reserve_soc,
        minMargin: this.config.min_margin,
        efficiency: this.config.efficiency,
        cycleCostPerMwh: this.config.cycle_cost_per_mwh || 0,
      },
    });
    this.backendPlanResult = result;
  }

  async confirmPlan() {
    const plan = this.getPlanResult().plan;
    try {
      await this.backendService.applyPlan(plan);
    } catch {
      await this.haService.confirmPlan(plan);
    }
  }

  render() {
    if (!this.shadowRoot || !this.renderer) return;
    const virtualBattery = this.batteryManager.getVirtualBattery();
    const planResult = this.getPlanResult();
    const alerts = this.buildAlerts(virtualBattery);
    this.renderer.render({
      config: this.config,
      virtualBattery,
      groups: this.batteryManager.getGroupSummaries(),
      batteries: this.batteryManager.getBatteries(),
      planResult,
      alerts,
      selectedBatteryId: this.selectedBatteryId,
      activeView: this.activeView,
    });
  }

  buildAlerts(virtualBattery) {
    const alerts = [...this.alerts].slice(-5);
    if (virtualBattery.enabled && virtualBattery.soc <= virtualBattery.minSoc + 2) {
      alerts.push({ level: "critical", message: "SOC is near minimum reserve." });
    }
    if (!virtualBattery.enabled) {
      alerts.push({ level: "warning", message: "No enabled batteries in aggregation." });
    }
    return alerts;
  }

  addAlert(message, level = "warning") {
    this.alerts.push({ message, level, time: new Date().toISOString() });
    this.render();
  }

  addDemoBattery() {
    const index = this.batteryManager.getBatteries().length + 1;
    this.batteryManager.upsertBattery({
      id: `bess-${index}`,
      name: `BESS Block ${index}`,
      group: index % 2 ? "main" : "reserve",
      site: "site-a",
      region: "ua",
      capacityKwh: 500,
      maxChargeKw: 250,
      maxDischargeKw: 250,
      minSoc: 15,
      maxSoc: 95,
      protocol: index % 2 ? "mqtt" : "modbus-rs485",
      telemetry: { soc: 45 + index, powerKw: 0, status: "idle" },
    });
  }

  getManualPower(mode) {
    if (mode === "charge") return this.manualChargePowerKw || this.manualPowerKw || 0;
    if (mode === "discharge") return this.manualDischargePowerKw || this.manualPowerKw || 0;
    return 0;
  }

  async loadStyles() {
    if (this.shadowRoot.querySelector("style")) return;
    const style = document.createElement("style");
    try {
      const response = await fetch(new URL("./styles.css", import.meta.url));
      style.textContent = await response.text();
    } catch {
      style.textContent = ":host{display:block;color:#eef3f8;background:#101820}";
    }
    this.shadowRoot.insertBefore(style, this.contentRoot);
  }
}

function upsertById(items, item) {
  const next = items.filter((candidate) => candidate.id !== item.id);
  if (item.locked) next.push(item);
  return next;
}

function deepMerge(base, override) {
  const result = { ...base, ...override };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(base[key] || {}, value);
    }
  }
  return result;
}

if (!customElements.get("alten-ems-card")) {
  customElements.define("alten-ems-card", AltenEmsCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "alten-ems-card",
  name: "Alten EMS Platform",
  description: "Industrial EMS dashboard for virtualized BESS fleets.",
});
