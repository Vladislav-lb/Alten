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
  theme: "dark",
  batteries: [],
});
const GLOBAL_STATE_KEY = "__altenEmsCardState";

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
    this.manualStartTime = "11:00";
    this.manualEndTime = "12:00";
    this.manualUseRange = false;
    this.selectedBatteryId = null;
    this.activeView = "control";
    this.activeScope = "clients";
    this.activeGroup = "ALTEN";
    this.selectedPlanDate = readStoredPlanDate() || defaultPlanDate();
    this.configDateInitialized = false;
    this.datePickerActive = false;
    this.pendingRender = false;
    this.priceLoading = false;
    this.treeCollapsed = false;
    this.powerUnit = "kw";
    this.theme = readStoredTheme() || normalizeTheme(this.config.theme);
    this.settingsOpen = false;
    this.planOverrides = [];
    this.backendPlanResult = null;
    this.dispatchStatus = null;
    this.commandHistory = [];
    this.backendSettings = {};
    this.haEntityOptions = [];
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
    this.priceService.setDate(this.selectedPlanDate);
    this.renderer = new UIRenderer(this.contentRoot);
  }

  async connectedCallback() {
    await this.loadStyles();
    await this.renderer.mount();
    this.bindEvents();
    this.priceService.startAutoRefresh();
    await this.refreshBackendState();
    this.startTelemetryRefresh();
    this.refreshPricesForSelectedDate().catch((error) => this.addAlert(error.message, "warning"));
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
    this.selectedPlanDate = this.resolvePlanDate(config);
    this.configDateInitialized = true;
    this.theme = readStoredTheme() || normalizeTheme(config?.theme || this.config.theme);
    this.haService.setConfig(this.config);
    this.priceService.setConfig(this.config);
    this.priceService.setDate(this.selectedPlanDate);
    this.backendService.setConfig(this.config);
    this.batteryManager.setBatteries(this.config.batteries || []);
    this.refreshBackendState().catch((error) => this.addAlert(error.message, "warning"));
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.haService.setHass(hass);
    this.priceService.setHass(hass);
    this.haEntityOptions = buildHaEntityOptions(hass);

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

  handleInput({ field, id, value, eventType }) {
    if (field === "battery-enabled") {
      const battery = this.batteryManager.setEnabled(id, value);
      this.backendService.saveBattery(battery).catch((error) => this.addAlert(error.message, "warning"));
      return;
    }

    if (field === "manual-target") {
      this.manualTarget = value;
      this.selectedBatteryId = value === "virtual" ? null : value;
      this.render();
      return;
    }

    if (field === "active-group") {
      this.activeGroup = value || "ALTEN";
      return;
    }

    if (field === "theme") {
      this.setTheme(value);
      this.render();
      return;
    }

    if (field === "setting-control-channel") {
      this.backendSettings = { ...this.backendSettings, control_channel: value };
      this.render();
      return;
    }

    if (field === "setting-grid-switch") {
      this.backendSettings = { ...this.backendSettings, grid_charging_switch: value };
      return;
    }

    if (field === "setting-safety") {
      this.backendSettings = { ...this.backendSettings, safety_checks_enabled: Boolean(value) };
      this.render();
      return;
    }

    if (field === "plan-date") {
      const nextDate = normalizePlanDate(value);
      if (!nextDate || nextDate === this.selectedPlanDate) return;
      this.changePlanDate(value).catch((error) => this.addAlert(error.message, "warning"));
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

    if (field === "manual-start") {
      this.manualStartTime = value || "11:00";
      return;
    }

    if (field === "manual-end") {
      this.manualEndTime = value || "12:00";
      return;
    }

    if (field === "manual-use-range") {
      this.manualUseRange = Boolean(value);
      return;
    }

    if (["min-margin", "efficiency", "min-soc"].includes(field)) {
      const configKey = field.replaceAll("-", "_");
      const numericValue = Number(value) || 0;
      this.config = { ...this.config, [configKey]: numericValue };
      if (field === "min-soc") this.config = { ...this.config, reserve_soc: numericValue };
      this.backendPlanResult = null;
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
      override.powerKw = this.normalizePowerInput(value);
      override.mode = override.powerKw > 0 ? "charge" : "idle";
    }
    if (field === "plan-sell") {
      override.powerKw = this.normalizePowerInput(value);
      override.mode = override.powerKw > 0 ? "discharge" : "idle";
    }

    this.planOverrides = upsertById(this.planOverrides, override);
    this.render();
  }

  async handleAction({ action, id, mode, battery, settings }) {
    try {
      if (action === "refresh") {
        await this.refreshBackendState();
        await this.refreshPricesForSelectedDate();
      }
      if (action === "date-focus") {
        this.datePickerActive = true;
      }
      if (action === "date-blur") {
        this.datePickerActive = false;
        if (this.pendingRender) this.render();
      }
      if (action === "refresh-prices") await this.refreshPricesForSelectedDate();
      if (action === "date-prev") await this.changePlanDate(shiftPlanDate(this.selectedPlanDate, -1));
      if (action === "date-next") await this.changePlanDate(shiftPlanDate(this.selectedPlanDate, 1));
      if (action === "open-monitor") {
        this.activeView = "monitoring";
      }
      if (action === "navigate") {
        this.activeView = id || "control";
      }
      if (action === "scope") {
        this.activeScope = id || "clients";
      }
      if (action === "toggle-tree") {
        this.treeCollapsed = !this.treeCollapsed;
      }
      if (action === "toggle-unit") {
        this.powerUnit = this.powerUnit === "kw" ? "mw" : "kw";
      }
      if (action === "toggle-theme") {
        this.setTheme(this.theme === "dark" ? "light" : "dark");
      }
      if (action === "toggle-settings") {
        this.settingsOpen = !this.settingsOpen;
      }
      if (action === "close-settings") {
        this.settingsOpen = false;
      }
      if (action === "set-theme") {
        this.setTheme(id);
      }
      if (action === "save-backend-settings") {
        await this.backendService.saveSettings(settings || this.backendSettings);
        await this.refreshBackendState();
        this.addAlert("EMS settings saved.", "success");
      }
      if (action === "auto-plan") {
        this.planOverrides = [];
        this.backendPlanResult = null;
        await this.optimizePlan();
      }
      if (action === "clear-plan") this.planOverrides = this.getPlanResult().plan.map((entry) => ({
        ...entry,
        mode: "idle",
        powerKw: 0,
        locked: true,
      }));
      if (action === "select-all") {
        await this.setAllBatteriesEnabled(true);
      }
      if (action === "clear-selection") {
        await this.setAllBatteriesEnabled(false);
      }
      if (action === "select-battery") this.selectedBatteryId = id;
      if (action === "add-battery") {
        this.selectedBatteryId = "__new__";
        this.activeView = "monitoring";
      }
      if (action === "delete-battery") {
        if (!id) return;
        if (!window.confirm(`Видалити батарею ${id}?`)) return;
        await this.backendService.deleteBattery(id);
        if (this.selectedBatteryId === id) this.selectedBatteryId = null;
        await this.refreshBackendState();
      }
      if (action === "save-battery-config") {
        if (!battery?.id) {
          this.addAlert("Вкажіть ID батареї перед збереженням.", "warning");
          return;
        }
        await this.backendService.saveBattery(battery);
        this.selectedBatteryId = battery.id;
        await this.refreshBackendState();
      }
      if (action === "save-group") await this.saveSelectedGroup();
      if (action === "delete-group") await this.clearActiveGroup();
      if (action === "confirm-plan") await this.confirmPlan();
      if (action === "manual-control") {
        const result = await this.backendService.manualControl({
          batteryId: this.manualTarget || this.selectedBatteryId || "virtual",
          mode,
          powerKw: this.getManualPower(mode),
          startTime: this.manualStartTime,
          endTime: this.manualEndTime,
          useRange: this.manualUseRange,
        });
        this.addAlert(this.manualCommandMessage(mode, result), mode === "idle" ? "warning" : "success");
        await this.refreshBackendState();
      }
      if (action === "grid-charging") {
        const enabled = mode === "on";
        const result = await this.backendService.gridCharging({
          batteryId: this.manualTarget || this.selectedBatteryId || "virtual",
          enabled,
        });
        this.addAlert(this.gridChargingMessage(enabled, result), enabled ? "success" : "warning");
        await this.refreshBackendState();
      }
      if (action === "emergency-stop") {
        try {
          await this.backendService.manualControl({
            batteryId: this.selectedBatteryId || "virtual",
            mode: "idle",
            powerKw: 0,
          });
        } catch {
          await this.haService.emergencyStop();
        }
        this.addAlert("Emergency stop requested by operator.", "critical");
        await this.refreshBackendState();
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
        minMargin: this.config.min_margin,
        efficiency: this.config.efficiency,
        targetSoc: this.config.target_soc,
        cycleCostPerMwh: this.config.cycle_cost_per_mwh || 0,
        maxCyclesPerDay: this.config.max_cycles_per_day || 1.5,
      },
    });
  }

  async refreshBackendState() {
    const [batteries, dispatchStatus, commandHistory, settings] = await Promise.allSettled([
      this.backendService.fetchBatteries(),
      this.backendService.fetchDispatchStatus(),
      this.backendService.fetchCommandHistory(12),
      this.backendService.fetchSettings(),
    ]);
    if (batteries.status === "fulfilled") {
      this.batteryManager.setBatteries(batteries.value);
    } else {
      this.addAlert(`Backend batteries unavailable: ${batteries.reason.message}`, "warning");
    }
    if (dispatchStatus.status === "fulfilled") this.dispatchStatus = dispatchStatus.value;
    if (commandHistory.status === "fulfilled") this.commandHistory = commandHistory.value;
    if (settings.status === "fulfilled") this.backendSettings = settings.value;
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
      const result = await this.backendService.applyPlan(plan);
      this.dispatchStatus = result.dispatch || this.dispatchStatus;
      this.addAlert("Plan confirmed and dispatched.", "success");
      await this.refreshBackendState();
    } catch {
      await this.haService.confirmPlan(plan);
    }
  }

  render() {
    if (!this.shadowRoot || !this.renderer) return;
    if (this.datePickerActive) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
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
      activeScope: this.activeScope,
      activeGroup: this.activeGroup,
      treeCollapsed: this.treeCollapsed,
      powerUnit: this.powerUnit,
      theme: this.theme,
      settingsOpen: this.settingsOpen,
      priceLoading: this.priceLoading,
      manualControl: {
        target: this.manualTarget,
        chargePowerKw: this.manualChargePowerKw,
        dischargePowerKw: this.manualDischargePowerKw,
        startTime: this.manualStartTime,
        endTime: this.manualEndTime,
        useRange: this.manualUseRange,
      },
      selectedPlanDate: this.selectedPlanDate,
      dispatchStatus: this.dispatchStatus,
      commandHistory: this.commandHistory,
      backendSettings: this.backendSettings,
      haEntityOptions: this.haEntityOptions,
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

  async changePlanDate(value) {
    const nextDate = normalizePlanDate(value);
    if (!nextDate) return;
    if (nextDate === this.selectedPlanDate) return;
    this.datePickerActive = false;
    this.selectedPlanDate = nextDate;
    storePlanDate(this.selectedPlanDate);
    this.priceService.setDate(this.selectedPlanDate);
    this.backendPlanResult = null;
    this.planOverrides = [];
    await this.refreshPricesForSelectedDate({ renderBefore: false });
  }

  async refreshPricesForSelectedDate({ renderBefore = true } = {}) {
    this.priceLoading = true;
    if (renderBefore) this.render();
    try {
      await this.priceService.refresh({ date: this.selectedPlanDate });
    } finally {
      this.priceLoading = false;
      this.render();
    }
  }

  resolvePlanDate(config = {}) {
    const selectedDate = normalizePlanDate(this.selectedPlanDate);
    const storedDate = readStoredPlanDate();
    const configuredDate = normalizePlanDate(config?.plan_date);
    if (!this.configDateInitialized && configuredDate && !storedDate) return configuredDate;
    return selectedDate || storedDate || configuredDate || defaultPlanDate();
  }

  setTheme(theme) {
    this.theme = normalizeTheme(theme);
    this.config = { ...this.config, theme: this.theme };
    storeTheme(this.theme);
  }

  async saveSelectedGroup() {
    const selected = this.selectedBatteryId ? this.batteryManager.getBattery(this.selectedBatteryId) : null;
    if (!selected) {
      this.addAlert("Оберіть батарею, щоб змінити її групу.", "warning");
      return;
    }
    await this.backendService.saveBattery({ ...selected, group: this.activeGroup || selected.group || "ALTEN" });
    await this.refreshBackendState();
  }

  async clearActiveGroup() {
    const group = this.activeGroup || "ALTEN";
    const batteries = this.batteryManager.getBatteries().filter((battery) => battery.group === group);
    if (!batteries.length) {
      this.addAlert("У цій групі немає батарей.", "warning");
      return;
    }
    await Promise.all(batteries.map((battery) => this.backendService.saveBattery({ ...battery, group: "ALTEN" })));
    this.activeGroup = "ALTEN";
    await this.refreshBackendState();
  }

  async setAllBatteriesEnabled(enabled) {
    const batteries = this.batteryManager.getBatteries().map((battery) => ({ ...battery, enabled }));
    batteries.forEach((battery) => this.batteryManager.upsertBattery(battery));
    await Promise.all(batteries.map((battery) => this.backendService.saveBattery(battery)));
    await this.refreshBackendState();
  }

  getManualPower(mode) {
    if (mode === "charge") return this.manualChargePowerKw || this.manualPowerKw || 0;
    if (mode === "discharge") return this.manualDischargePowerKw || this.manualPowerKw || 0;
    return 0;
  }

  manualCommandMessage(mode, result = {}) {
    const control = result.control || result;
    if (control.blocked) return `Command blocked by EMS safety: ${firstSafetyReason(control)}`;
    const targetCount = Array.isArray(control.targets) ? control.targets.length : 1;
    if (mode === "charge") return `Manual charge command sent (${targetCount} target).`;
    if (mode === "discharge") return `Manual discharge command sent (${targetCount} target).`;
    return `Manual stop command sent (${targetCount} target).`;
  }

  gridChargingMessage(enabled, result = {}) {
    if (result.blocked) return `Grid charging blocked by EMS safety: ${firstSafetyReason(result)}`;
    return enabled ? "Grid charging switch enabled." : "Grid charging switch disabled.";
  }

  normalizePowerInput(value) {
    const power = Math.max(0, Number(value) || 0);
    return this.powerUnit === "mw" ? power * 1000 : power;
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

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("alten-ems-theme");
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function storeTheme(theme) {
  try {
    localStorage.setItem("alten-ems-theme", normalizeTheme(theme));
  } catch {
    // localStorage can be unavailable in restricted embeds.
  }
}

function defaultPlanDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function shiftPlanDate(value, deltaDays) {
  const normalized = normalizePlanDate(value) || defaultPlanDate();
  const date = new Date(`${normalized}T00:00:00`);
  date.setDate(date.getDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function normalizePlanDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : text;
}

function readStoredPlanDate() {
  const globalDate = normalizePlanDate(globalCardState().planDate);
  if (globalDate) return globalDate;
  try {
    return normalizePlanDate(localStorage.getItem("alten-ems-plan-date"));
  } catch {
    return null;
  }
}

function storePlanDate(value) {
  globalCardState().planDate = normalizePlanDate(value) || defaultPlanDate();
  try {
    localStorage.setItem("alten-ems-plan-date", globalCardState().planDate);
  } catch {
    // localStorage can be unavailable in restricted embeds.
  }
}

function firstSafetyReason(result = {}) {
  const checks = result.safety?.checks || [];
  const blocker = checks.find((check) => check.ok === false) || checks[0];
  return blocker?.reason || "blocked";
}

function buildHaEntityOptions(hass) {
  const states = hass?.states || {};
  return Object.entries(states)
    .filter(([entityId]) => /^(sensor|binary_sensor|switch|number|select|input_number)\./.test(entityId))
    .map(([entityId, entity]) => ({
      entityId,
      name: entity.attributes?.friendly_name || entityId,
      domain: entityId.split(".", 1)[0],
      unit: entity.attributes?.unit_of_measurement || "",
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function globalCardState() {
  window[GLOBAL_STATE_KEY] = window[GLOBAL_STATE_KEY] || {};
  return window[GLOBAL_STATE_KEY];
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
