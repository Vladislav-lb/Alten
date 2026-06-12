import { planToCsv } from "./plan-calculator.js";

const HOURS = Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);

export class UIRenderer extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.state = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundInput = (event) => this.handleInput(event);
    this.boundFocusIn = (event) => this.handleFocusIn(event);
    this.boundFocusOut = (event) => this.handleFocusOut(event);
  }

  async mount() {
    this.root.addEventListener("click", this.boundClick);
    this.root.addEventListener("change", this.boundInput);
    this.root.addEventListener("input", this.boundInput);
    this.root.addEventListener("focusin", this.boundFocusIn);
    this.root.addEventListener("focusout", this.boundFocusOut);
  }

  unmount() {
    this.root.removeEventListener("click", this.boundClick);
    this.root.removeEventListener("change", this.boundInput);
    this.root.removeEventListener("input", this.boundInput);
    this.root.removeEventListener("focusin", this.boundFocusIn);
    this.root.removeEventListener("focusout", this.boundFocusOut);
  }

  render(state) {
    this.state = state;
    const matrixScroll = this.captureMatrixScroll();
    const focusedField = this.captureFocusedField();
    const {
      virtualBattery,
      groups,
      batteries,
      planResult,
      alerts,
      selectedBatteryId,
      config,
      activeView = "control",
      activeScope = "clients",
      activeGroup: selectedGroup,
      treeCollapsed = false,
      powerUnit = "kw",
      theme = "dark",
      settingsOpen = false,
      priceLoading = false,
      manualControl = {},
      selectedPlanDate = tomorrowValue(),
      dispatchStatus = null,
      commandHistory = [],
      backendSettings = {},
      haEntityOptions = [],
    } = state;
    const activeGroup = selectedGroup || groups[0]?.group || "ALTEN";
    const unitLabel = powerUnit === "mw" ? "MW" : "kW";

    this.root.innerHTML = `
      <section class="ems-app theme-${theme === "light" ? "light" : "dark"}">
        <header class="app-bar">
          <nav class="top-nav">
            <button class="${activeView === "control" ? "active" : ""}" data-action="navigate" data-id="control">Керування</button>
            <button class="${activeView === "monitoring" ? "active" : ""}" data-action="navigate" data-id="monitoring">Моніторинг</button>
            <button class="${activeView === "analytics" ? "active" : ""}" data-action="navigate" data-id="analytics">Графіки</button>
          </nav>
          <div class="app-tools">
            <button class="icon-only" data-action="refresh" title="Оновити">⌕</button>
            <button class="icon-only" data-action="open-monitor" title="Монітор">▣</button>
            <button class="icon-only" data-action="toggle-settings" title="Налаштування">⚙</button>
            <span class="user-dot"></span>
          </div>
        </header>

        ${settingsOpen ? renderSettingsPanel(theme, backendSettings) : ""}

        <div class="workspace">
          <aside class="control-sidebar">
            <section class="side-section side-title">🔧 Керування</section>

            <section class="side-section">
              <div class="segmented">
                <button class="${activeScope === "clients" ? "active" : ""}" data-action="scope" data-id="clients">По клієнтах</button>
                <button class="${activeScope === "regions" ? "active" : ""}" data-action="scope" data-id="regions">По регіонах</button>
                <button class="${activeScope === "osr" ? "active" : ""}" data-action="scope" data-id="osr">По ОСР</button>
              </div>
              <input class="search-input" data-field="battery-search" placeholder="Пошук..." type="search">
              <div class="side-actions">
                <button data-action="select-all">Обрати всі</button>
                <button data-action="clear-selection">Скасувати</button>
              </div>
              <div class="group-tools">
                <select data-field="active-group">
                  <option>${escapeHtml(activeGroup)}</option>
                  ${groups.map((group) => `<option>${escapeHtml(group.group)}</option>`).join("")}
                </select>
                <button class="save-button" data-action="save-group">Зберегти</button>
                <button class="delete-button" data-action="delete-group">Видалити</button>
              </div>
            </section>

            <section class="side-section">
              <h3>ВІРТУАЛЬНА БАТАРЕЯ</h3>
              <div class="metric-grid">
                ${sideMetric(formatNumber(virtualBattery.capacityKwh, 0), "кВт·год")}
                ${sideMetric(formatNumber(virtualBattery.maxDischargeKw, 0), "кВт (макс)")}
                ${sideMetric(String(virtualBattery.batteryCount), "обрано")}
                ${sideMetric(`${formatNumber(virtualBattery.soc, 0)}%`, "сер. SOC")}
              </div>
            </section>

            <section class="side-section battery-tree">
              ${renderBatteryTree(batteries, selectedBatteryId, treeCollapsed)}
            </section>
          </aside>

          <main class="main-stage">
            ${alerts.length ? renderAlerts(alerts) : ""}
            ${activeView === "analytics" ? renderChartsView(planResult.plan, planResult.summary, virtualBattery) : ""}
            ${activeView === "monitoring" ? renderMonitoringView(batteries, virtualBattery, selectedBatteryId, haEntityOptions) : ""}

            <section class="plan-card ${activeView !== "control" ? "view-hidden" : ""}">
              <div class="day-tab">${formatPlanDate(selectedPlanDate)}</div>
              <div class="plan-header">
                <h2>📊 План роботи BESS</h2>
                <div class="plan-toolbar">
                  <button class="date-step" data-action="date-prev" title="Попередній день">‹</button>
                  <label class="date-picker">
                    <input data-field="plan-date" type="date" value="${escapeHtml(selectedPlanDate)}">
                  </label>
                  <button class="date-step" data-action="date-next" title="Наступний день">›</button>
                  <button class="price-refresh ${priceLoading ? "loading" : ""}" data-action="refresh-prices" title="Оновити ціни для вибраної дати">${priceLoading ? "⟳" : "↻"} Ціни</button>
                  <button data-action="export-plan">📊 Експорт</button>
                  <button data-action="toggle-unit">${unitLabel} ↔ ${powerUnit === "mw" ? "kW" : "MW"}</button>
                </div>
              </div>

              <div class="date-status ${priceLoading ? "loading" : ""}">
                <span>${priceLoading ? "Оновлення цін через API..." : "Дані таблиці для вибраної дати"}</span>
                <strong>${escapeHtml(selectedPlanDate)}</strong>
              </div>

              <div class="summary-strip">
                ${summaryItem("🔋 Ємність:", `${formatNumber(virtualBattery.capacityKwh, 0)} kWh`)}
                ${summaryItem("⚡ Заряд:", `${formatPower(totalCharge(planResult.plan), powerUnit)} ${unitLabel}`)}
                ${summaryItem("⚡ Розряд:", `${formatPower(totalDischarge(planResult.plan), powerUnit)} ${unitLabel}`)}
                ${summaryItem("📊 SOC:", `${formatNumber(virtualBattery.soc, 0)}% (${formatNumber(virtualBattery.capacityKwh * virtualBattery.soc / 100, 0)} kWh)`)}
              </div>

              ${renderPlanMatrix(planResult.plan, powerUnit)}

              <div class="settings-band">
                ${sliderRow("Мін. маржа:", "min-margin", config.min_margin ?? 500, "грн/МВт·год", 100, 2000)}
                ${sliderRow("Ефективність:", "efficiency", config.efficiency ?? 92, "%", 50, 100)}
                <label class="check-row">
                  <input data-field="use-min-soc" type="checkbox" ${config.use_min_soc ? "checked" : ""}>
                  <span>Мін. SOC:</span>
                  <input data-field="min-soc" type="range" min="0" max="80" value="${config.reserve_soc ?? 10}" ${config.use_min_soc ? "" : "disabled"}>
                  <strong>${formatNumber(config.reserve_soc ?? 10, 0)}</strong>
                  <span>%</span>
                </label>
              </div>

              <div class="command-row">
                <button data-action="auto-plan">⚡ Авто план</button>
                <button data-action="confirm-plan">✅ Підтвердити</button>
                <button data-action="clear-plan">🗑 Очистити</button>
                <button class="delete-button" data-action="emergency-stop">STOP</button>
              </div>
            </section>

            <section class="lower-grid ${activeView !== "control" ? "view-hidden" : ""}">
              <div class="utility-card manual-card">
                <h2>🎮 Ручне керування</h2>
                ${renderManualControl(selectedBatteryId, batteries, manualControl)}
              </div>
              <div class="utility-card status-card">
                <div class="status-header">
                  <h2>📋 Статус планів</h2>
                  <button data-action="refresh">⟳</button>
                </div>
                <div class="status-body">
                  ${renderDispatchStatus(dispatchStatus, commandHistory)}
                </div>
              </div>
            </section>
          </main>
        </div>
      </section>
    `;
    this.restoreMatrixScroll(matrixScroll);
    this.restoreFocusedField(focusedField);
  }

  handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "export-plan") {
      this.downloadPlanCsv();
      return;
    }
    if (action === "add-custom-sensor") {
      this.addCustomSensorRow();
      return;
    }
    if (action === "remove-custom-sensor") {
      button.closest("[data-custom-sensor-row]")?.remove();
      return;
    }
    this.dispatchEvent(new CustomEvent("action", {
      detail: {
        action,
        id: button.dataset.id,
        mode: button.dataset.mode,
        battery: action === "save-battery-config" ? this.collectBatteryForm() : null,
        settings: action === "save-backend-settings" ? this.collectBackendSettings() : null,
      },
    }));
  }

  handleInput(event) {
    const target = event.target;
    if (!target.dataset.field) return;
    this.dispatchEvent(new CustomEvent("input", {
      detail: {
        field: target.dataset.field,
        id: target.dataset.id,
        value: target.type === "checkbox" ? target.checked : target.value,
        eventType: event.type,
      },
    }));
  }

  handleFocusIn(event) {
    if (event.target?.dataset?.field !== "plan-date") return;
    this.dispatchEvent(new CustomEvent("action", {
      detail: { action: "date-focus" },
    }));
  }

  handleFocusOut(event) {
    if (event.target?.dataset?.field !== "plan-date") return;
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent("action", {
        detail: { action: "date-blur" },
      }));
    }, 250);
  }

  downloadPlanCsv() {
    const csv = planToCsv(this.state?.planResult?.plan || []);
    const planDate = this.state?.selectedPlanDate || new Date().toISOString().slice(0, 10);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alten-ems-plan-${planDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  collectBatteryForm() {
    const form = this.root.querySelector("[data-battery-config-form]");
    if (!form) return {};
    const read = (key) => form.querySelector(`[data-form-key="${key}"]`)?.value?.trim() || "";
    const sensors = {
      soc: read("sensor_soc"),
      power: read("sensor_power"),
      voltage: read("sensor_voltage"),
      current: read("sensor_current"),
      temperature: read("sensor_temperature"),
      status: read("sensor_status"),
    };
    form.querySelectorAll("[data-custom-sensor-row]").forEach((row) => {
      const key = row.querySelector('[data-form-key="custom_sensor_key"]')?.value?.trim();
      const entityId = row.querySelector('[data-form-key="custom_sensor_entity"]')?.value?.trim();
      if (!key || !entityId) return;
      sensors[sanitizeSensorKey(key)] = entityId;
    });
    return {
      id: read("id"),
      name: read("name"),
      group: read("group"),
      site: read("site"),
      region: read("region"),
      capacity_kwh: read("capacity_kwh"),
      max_charge_kw: read("max_charge_kw"),
      max_discharge_kw: read("max_discharge_kw"),
      min_soc_percent: read("min_soc_percent"),
      max_soc_percent: read("max_soc_percent"),
      efficiency_percent: read("efficiency_percent"),
      protocol: "home_assistant",
      connection: { type: "home_assistant" },
      sensors,
    };
  }

  collectBackendSettings() {
    const panel = this.root.querySelector("[data-backend-settings-form]");
    if (!panel) return {};
    const read = (key) => panel.querySelector(`[data-form-key="${key}"]`);
    return {
      control_channel: read("control_channel")?.value || "home_assistant",
      grid_charging_switch: read("grid_charging_switch")?.value?.trim() || "",
      safety_checks_enabled: Boolean(read("safety_checks_enabled")?.checked),
    };
  }

  addCustomSensorRow(key = "", entityId = "") {
    const list = this.root.querySelector("[data-custom-sensor-list]");
    if (!list) return;
    list.insertAdjacentHTML("beforeend", renderCustomSensorRow({ key, entityId }));
  }

  captureMatrixScroll() {
    const matrix = this.root.querySelector(".matrix-wrap");
    if (!matrix) return null;
    return {
      left: matrix.scrollLeft,
      top: matrix.scrollTop,
    };
  }

  restoreMatrixScroll(scroll) {
    if (!scroll) return;
    const matrix = this.root.querySelector(".matrix-wrap");
    if (!matrix) return;
    requestAnimationFrame(() => {
      matrix.scrollLeft = scroll.left;
      matrix.scrollTop = scroll.top;
    });
  }

  captureFocusedField() {
    const active = this.root.activeElement;
    if (!active?.dataset?.field) return null;
    return {
      field: active.dataset.field,
      id: active.dataset.id || "",
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  restoreFocusedField(focused) {
    if (!focused) return;
    if (focused.field === "plan-date") return;
    const selector = `[data-field="${focused.field}"][data-id="${focused.id}"]`;
    const fallbackSelector = `[data-field="${focused.field}"]`;
    const target = this.root.querySelector(selector) || this.root.querySelector(fallbackSelector);
    if (!target) return;
    requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      if (typeof focused.start === "number" && target.setSelectionRange) {
        target.setSelectionRange(focused.start, focused.end ?? focused.start);
      }
    });
  }
}

function renderChartPanel(plan) {
  const entries = normalizePlanSlots(plan);
  return `
    <section class="chart-panel">
      <article>
        <div class="chart-title">
          <strong>Price</strong>
          <span>RDN hourly curve</span>
        </div>
        ${barChart(entries, (entry) => entry.price, "price")}
      </article>
      <article>
        <div class="chart-title">
          <strong>SOC</strong>
          <span>State of charge forecast</span>
        </div>
        ${lineChart(entries, (entry) => entry.socEnd || 0)}
      </article>
      <article>
        <div class="chart-title">
          <strong>Profit</strong>
          <span>Hourly P&L</span>
        </div>
        ${barChart(entries, (entry) => entry.profit, "profit")}
      </article>
    </section>
  `;
}

function renderSettingsPanel(theme, backendSettings = {}) {
  const channel = backendSettings.control_channel || "home_assistant";
  const switchEntity = backendSettings.grid_charging_switch || "switch.inverter_battery_grid_charging";
  const safetyEnabled = backendSettings.safety_checks_enabled !== false;
  return `
    <aside class="settings-drawer" aria-label="Налаштування EMS">
      <div class="settings-drawer-head">
        <div>
          <strong>Налаштування</strong>
          <span>Інтерфейс програми</span>
        </div>
        <button class="icon-only" data-action="close-settings" title="Закрити">×</button>
      </div>
      <div class="settings-block">
        <span>Тема</span>
        <div class="theme-switcher" role="group" aria-label="Тема інтерфейсу">
          <button class="${theme === "dark" ? "active" : ""}" data-action="set-theme" data-id="dark">Темна</button>
          <button class="${theme === "light" ? "active" : ""}" data-action="set-theme" data-id="light">Світла</button>
        </div>
      </div>
      <label class="settings-field">
        <span>Поточна тема</span>
        <select data-field="theme">
          <option value="dark" ${theme === "dark" ? "selected" : ""}>Темна</option>
          <option value="light" ${theme === "light" ? "selected" : ""}>Світла</option>
        </select>
      </label>
      <div class="settings-divider"></div>
      <div data-backend-settings-form>
        <div class="settings-block">
          <span>EMS керування</span>
        </div>
        <label class="settings-field">
          <span>Канал керування</span>
          <select data-field="setting-control-channel" data-form-key="control_channel">
            <option value="home_assistant" ${channel === "home_assistant" ? "selected" : ""}>Home Assistant switch</option>
            <option value="modbus" ${channel === "modbus" ? "selected" : ""}>Modbus</option>
            <option value="mqtt" ${channel === "mqtt" ? "selected" : ""}>MQTT</option>
          </select>
        </label>
        <label class="settings-field">
          <span>Grid charging switch</span>
          <input data-field="setting-grid-switch" data-form-key="grid_charging_switch" value="${escapeHtml(switchEntity)}">
        </label>
        <label class="settings-check">
          <input data-field="setting-safety" data-form-key="safety_checks_enabled" type="checkbox" ${safetyEnabled ? "checked" : ""}>
          <span>Safety checks</span>
        </label>
        <button class="save-button settings-save" data-action="save-backend-settings">Зберегти EMS</button>
      </div>
    </aside>
  `;
}

function renderChartsView(plan, summary, virtualBattery) {
  return `
    <section class="analytics-view">
      <div class="analytics-header">
        <div>
          <h2>📈 Графіки EMS</h2>
          <p>Ціна, SOC, потужність та прибуток за погодинним планом</p>
        </div>
        <div class="analytics-kpis">
          ${analyticsKpi("Прибуток", `${formatNumber(summary.profit, 0)} ₴`)}
          ${analyticsKpi("Заряд", `${formatNumber(summary.chargeKwh, 0)} kWh`)}
          ${analyticsKpi("Розряд", `${formatNumber(summary.dischargeKwh, 0)} kWh`)}
          ${analyticsKpi("SOC", `${formatNumber(summary.finalSoc || virtualBattery.soc, 0)}%`)}
        </div>
      </div>
      ${renderChartPanel(plan)}
      <div class="wide-chart">
        <div class="chart-title">
          <strong>Power dispatch</strong>
          <span>Charge and discharge profile</span>
        </div>
        ${dispatchChart(normalizePlanSlots(plan))}
      </div>
    </section>
  `;
}

function renderMonitoringView(batteries, virtualBattery, selectedBatteryId, haEntityOptions = []) {
  const enabled = batteries.filter((battery) => battery.enabled);
  const online = batteries.filter((battery) => battery.telemetry?.online !== false && battery.telemetry?.lastSeen).length;
  const totalPower = batteries.reduce((sum, battery) => sum + (Number(battery.telemetry?.powerKw) || 0), 0);
  return `
    <section class="monitoring-view">
      <div class="monitoring-header">
        <div>
          <h2>📟 Моніторинг батарей</h2>
          <p>Реальні сенсори Home Assistant / Modbus / MQTT для BESS</p>
        </div>
        <button class="save-button" data-action="add-battery">+ Нова батарея</button>
        <div class="analytics-kpis">
          ${analyticsKpi("Онлайн", `${online}/${batteries.length}`)}
          ${analyticsKpi("Активні", `${enabled.length}`)}
          ${analyticsKpi("Потужність", `${formatNumber(totalPower, 1)} kW`)}
          ${analyticsKpi("Virtual SOC", `${formatNumber(virtualBattery.soc, 1)}%`)}
        </div>
      </div>
      <div class="battery-monitor-grid">
        ${batteries.map(renderBatteryMonitorCard).join("") || emptyState("Немає підключених батарей")}
      </div>
      ${renderBatteryConfigForm(batteries, selectedBatteryId, haEntityOptions)}
      <div class="sensor-table-card">
        <div class="chart-title">
          <strong>Сенсори батарей</strong>
          <span>Останні отримані значення</span>
        </div>
        ${renderSensorTable(batteries)}
      </div>
    </section>
  `;
}

function renderBatteryMonitorCard(battery) {
  const telemetry = battery.telemetry || {};
  const isOnline = telemetry.online !== false && Boolean(telemetry.lastSeen);
  return `
    <article class="battery-monitor-card ${isOnline ? "online" : "offline"}">
      <div class="battery-monitor-head">
        <div>
          <strong>${escapeHtml(battery.name)}</strong>
          <span>${escapeHtml(battery.group)} | ${escapeHtml(battery.protocol)}</span>
        </div>
        <span class="online-pill">${isOnline ? "online" : "waiting"}</span>
      </div>
      <div class="battery-card-actions">
        <button data-action="select-battery" data-id="${battery.id}">Редагувати</button>
        <button class="delete-button" data-action="delete-battery" data-id="${battery.id}">Видалити</button>
      </div>
      <div class="soc-ring" style="--soc:${Math.max(0, Math.min(100, Number(telemetry.soc) || 0))}%">
        <strong>${formatNumber(telemetry.soc, 0)}%</strong>
        <span>SOC</span>
      </div>
      <div class="sensor-grid">
        ${sensorValue("Power", `${formatNumber(telemetry.powerKw, 1)} kW`)}
        ${sensorValue("Voltage", telemetry.voltage == null ? "n/a" : `${formatNumber(telemetry.voltage, 1)} V`)}
        ${sensorValue("Current", telemetry.current == null ? "n/a" : `${formatNumber(telemetry.current, 1)} A`)}
        ${sensorValue("Temp", telemetry.temperature == null ? "n/a" : `${formatNumber(telemetry.temperature, 1)} °C`)}
        ${sensorValue("Status", telemetry.status || "unknown")}
        ${sensorValue("Source", telemetry.source || "backend")}
      </div>
    </article>
  `;
}

function renderBatteryConfigForm(batteries, selectedBatteryId, haEntityOptions = []) {
  const candidate = selectedBatteryId === "__new__"
    ? {}
    : batteries.find((battery) => battery.id === selectedBatteryId)
      || batteries.find((battery) => battery.id === "inverter_battery")
      || batteries[0]
      || {};
  const sensors = candidate.sensors || {};
  const customSensors = Object.entries(sensors)
    .filter(([key]) => !STANDARD_SENSOR_KEYS.includes(key))
    .map(([key, entityId]) => ({ key, entityId }));
  return `
    <div class="battery-config-card" data-battery-config-form>
      <div class="chart-title">
        <strong>Налаштування батареї</strong>
        <span>Додати або оновити сенсори без SSH</span>
      </div>
      <div class="battery-config-grid">
        ${formInput("ID", "id", candidate.id || "inverter_battery")}
        ${formInput("Назва", "name", candidate.name || "Inverter Battery")}
        ${formInput("Група", "group", candidate.group || "ALTEN")}
        ${formInput("Site", "site", candidate.site || "home")}
        ${formInput("Region", "region", candidate.region || "ua")}
        ${formInput("Ємність kWh", "capacity_kwh", candidate.capacityKwh || 16.1, "number")}
        ${formInput("Max charge kW", "max_charge_kw", candidate.maxChargeKw || 5.7, "number")}
        ${formInput("Max discharge kW", "max_discharge_kw", candidate.maxDischargeKw || 5.7, "number")}
        ${formInput("Min SOC %", "min_soc_percent", candidate.minSoc || 35, "number")}
        ${formInput("Max SOC %", "max_soc_percent", candidate.maxSoc || 100, "number")}
        ${formInput("Efficiency %", "efficiency_percent", Math.round((candidate.roundtripEfficiency || 0.99) * 100), "number")}
        ${sensorEntityInput("SOC sensor", "sensor_soc", sensors.soc || "sensor.inverter_battery")}
        ${sensorEntityInput("Power sensor", "sensor_power", sensors.power || "sensor.inverter_battery_power")}
        ${sensorEntityInput("Voltage sensor", "sensor_voltage", sensors.voltage || "sensor.inverter_battery_voltage")}
        ${sensorEntityInput("Current sensor", "sensor_current", sensors.current || "sensor.inverter_battery_current")}
        ${sensorEntityInput("Temperature sensor", "sensor_temperature", sensors.temperature || "sensor.inverter_battery_temperature")}
        ${sensorEntityInput("Status sensor", "sensor_status", sensors.status || "sensor.inverter_device_alarm")}
      </div>
      ${renderHaEntityDatalist(haEntityOptions)}
      <div class="custom-sensor-card">
        <div class="chart-title">
          <strong>Кастомні сенсори</strong>
          <span>Додаткові entity будуть збережені в telemetry батареї</span>
        </div>
        <div class="custom-sensor-list" data-custom-sensor-list>
          ${customSensors.map(renderCustomSensorRow).join("") || renderCustomSensorRow({ key: "", entityId: "" })}
        </div>
        <button data-action="add-custom-sensor">+ Додати кастомний сенсор</button>
      </div>
      <div class="command-row">
        <button class="save-button" data-action="save-battery-config">Зберегти батарею</button>
      </div>
    </div>
  `;
}

function formInput(label, key, value = "", type = "text") {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input data-form-key="${key}" type="${type}" value="${escapeHtml(value)}">
    </label>
  `;
}

const STANDARD_SENSOR_KEYS = ["soc", "power", "voltage", "current", "temperature", "status"];

function sensorEntityInput(label, key, value = "") {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input data-form-key="${key}" list="ha-entity-options" value="${escapeHtml(value)}" placeholder="sensor.example">
    </label>
  `;
}

function renderHaEntityDatalist(options = []) {
  return `
    <datalist id="ha-entity-options">
      ${options.map((option) => `<option value="${escapeHtml(option.entityId)}">${escapeHtml(option.name)}${option.unit ? ` · ${escapeHtml(option.unit)}` : ""}</option>`).join("")}
    </datalist>
  `;
}

function renderCustomSensorRow({ key = "", entityId = "" } = {}) {
  return `
    <div class="custom-sensor-row" data-custom-sensor-row>
      <input data-form-key="custom_sensor_key" value="${escapeHtml(key)}" placeholder="telemetry_key">
      <input data-form-key="custom_sensor_entity" list="ha-entity-options" value="${escapeHtml(entityId)}" placeholder="sensor.custom_entity">
      <button class="delete-button" data-action="remove-custom-sensor" title="Видалити">×</button>
    </div>
  `;
}

function renderSensorTable(batteries) {
  return `
    <div class="sensor-table-wrap">
      <table class="sensor-table">
        <thead>
          <tr>
            <th>Battery</th>
            <th>SOC</th>
            <th>Power</th>
            <th>Voltage</th>
            <th>Current</th>
            <th>Temp</th>
            <th>Status</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          ${batteries.map((battery) => {
            const telemetry = battery.telemetry || {};
            return `
              <tr>
                <td>${escapeHtml(battery.name)}</td>
                <td>${formatNumber(telemetry.soc, 1)}%</td>
                <td>${formatNumber(telemetry.powerKw, 1)} kW</td>
                <td>${telemetry.voltage == null ? "n/a" : `${formatNumber(telemetry.voltage, 1)} V`}</td>
                <td>${telemetry.current == null ? "n/a" : `${formatNumber(telemetry.current, 1)} A`}</td>
                <td>${telemetry.temperature == null ? "n/a" : `${formatNumber(telemetry.temperature, 1)} °C`}</td>
                <td>${escapeHtml(telemetry.status || "unknown")}</td>
                <td>${telemetry.lastSeen ? escapeHtml(new Date(telemetry.lastSeen).toLocaleString()) : "waiting"}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function sensorValue(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function analyticsKpi(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function dispatchChart(entries) {
  const values = entries.map((entry) => {
    if (entry.mode === "charge") return -Math.abs(entry.powerKw);
    if (entry.mode === "discharge") return Math.abs(entry.powerKw);
    return 0;
  });
  const max = Math.max(...values.map((value) => Math.abs(value)), 1);
  return `
    <div class="dispatch-chart">
      <div class="zero-line"></div>
      ${values.map((value, index) => `
        <span
          title="${HOURS[index]}: ${formatNumber(value, 0)} kW"
          class="${value < 0 ? "charge-bar" : value > 0 ? "discharge-bar" : "idle-bar"}"
          style="--h:${Math.max(3, Math.abs(value) / max * 46)}%; --y:${value < 0 ? "50%" : `${50 - Math.abs(value) / max * 46}%`}"
        ></span>
      `).join("")}
    </div>
  `;
}

function barChart(entries, pickValue, type) {
  const values = entries.map((entry) => Number(pickValue(entry)) || 0);
  const max = Math.max(...values.map((value) => Math.abs(value)), 1);
  return `
    <div class="bar-chart ${type}">
      ${values.map((value, index) => `
        <span
          title="${HOURS[index]}: ${formatNumber(value, 0)}"
          class="${value < 0 ? "negative-bar" : ""}"
          style="--h:${Math.max(4, Math.abs(value) / max * 100)}%"
        ></span>
      `).join("")}
    </div>
  `;
}

function lineChart(entries, pickValue) {
  const values = entries.map((entry) => Number(pickValue(entry)) || 0);
  const points = values.map((value, index) => {
    const x = entries.length <= 1 ? 0 : index / (entries.length - 1) * 100;
    const y = 100 - Math.max(0, Math.min(100, value));
    return `${x},${y}`;
  }).join(" ");
  return `
    <svg class="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="SOC chart">
      <polyline points="${points}" pathLength="100"></polyline>
    </svg>
  `;
}

function renderBatteryTree(batteries, selectedBatteryId, treeCollapsed = false) {
  if (!batteries.length) return emptyState("Немає батарей");
  return `
    <div class="tree-node">
      <button class="tree-toggle" data-action="toggle-tree">${treeCollapsed ? "▸" : "▾"}</button>
      <label><input type="checkbox" checked> 🏢 ALTEN</label>
    </div>
    <div class="tree-children ${treeCollapsed ? "collapsed" : ""}">
      ${batteries.map((battery) => `
        <article class="battery-item ${selectedBatteryId === battery.id ? "selected" : ""}">
          <button data-action="select-battery" data-id="${battery.id}">
            <strong>${escapeHtml(battery.name)}</strong>
            <small>${formatNumber(battery.telemetry.soc, 0)}% SOC | ${escapeHtml(battery.protocol)}</small>
          </button>
          <input data-field="battery-enabled" data-id="${battery.id}" type="checkbox" ${battery.enabled ? "checked" : ""}>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAlerts(alerts) {
  return `
    <section class="alert-strip">
      ${alerts.map((alert) => `<div class="alert ${alert.level || "warning"}">${escapeHtml(alert.message)}</div>`).join("")}
    </section>
  `;
}

function renderDispatchStatus(status = null, history = []) {
  if (!status?.updated_at) {
    return `<div class="dispatch-state empty-state">Команд ще не було</div>`;
  }
  const result = status.result || {};
  const control = result.control || result;
  const safetyChecks = status.safety?.checks || [];
  return `
    <div class="dispatch-state ${status.blocked ? "blocked" : status.ok ? "ok" : "failed"}">
      <div class="dispatch-head">
        <div>
          <strong>${status.blocked ? "Заблоковано safety" : status.ok ? "Активно" : "Помилка"}</strong>
          <span>${formatDateTime(status.updated_at)}</span>
        </div>
        <span class="mode-pill ${status.mode || "idle"}">${modeIcon(status.mode)} ${escapeHtml(status.mode || "idle")}</span>
      </div>
      <div class="dispatch-grid">
        ${dispatchMetric("Канал", status.channel || "n/a")}
        ${dispatchMetric("Ціль", status.battery_id || "virtual")}
        ${dispatchMetric("Потужність", `${formatNumber(status.effective_power_kw ?? status.power_kw ?? 0, 2)} kW`)}
        ${dispatchMetric("Switch", control.observed_state || control.state || "n/a")}
      </div>
      ${safetyChecks.length ? `<div class="safety-list">${safetyChecks.slice(0, 3).map((check) => `<p class="${check.ok === false ? "bad" : "good"}">${escapeHtml(check.reason || "Safety check")}</p>`).join("")}</div>` : ""}
      ${renderCommandHistory(history)}
    </div>
  `;
}

function renderCommandHistory(history = []) {
  const items = history.slice(0, 5);
  if (!items.length) return "";
  return `
    <div class="command-history">
      <strong>Останні команди</strong>
      ${items.map((item) => `
        <article class="${item.blocked ? "blocked" : item.ok ? "ok" : "failed"}">
          <span>${formatDateTime(item.time)}</span>
          <b>${escapeHtml(item.source || "ems")} · ${escapeHtml(item.mode || "idle")}</b>
          <em>${escapeHtml(item.channel || "n/a")} · ${formatNumber(item.effective_power_kw ?? item.power_kw ?? 0, 2)} kW</em>
        </article>
      `).join("")}
    </div>
  `;
}

function dispatchMetric(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderPlanMatrixLegacy(plan, powerUnit = "kw") {
  const entries = normalizePlanSlots(plan);
  const unitLabel = powerUnit === "mw" ? "MW" : "kW";
  const totalProfit = entries.reduce((sum, entry) => sum + entry.profit, 0);
  return `
    <div class="matrix-wrap">
      <table class="plan-matrix plan-matrix-wide">
        <thead>
          <tr>
            <th>Р“РѕРґРёРЅР°</th>
            ${HOURS.map((hour) => `<th>${hour}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${matrixRow("💰 Р¦С–РЅР° Р Р”Рќ", entries, (entry) => formatNumber(entry.price, 0), "price-row")}
          ${inputMatrixRow(`🔋 РљСѓРїС–РІР»СЏ (${unitLabel})`, entries, "plan-buy", (entry) => formatPowerValue(entry.mode === "charge" ? entry.powerKw : 0, powerUnit), "buy-row")}
          ${inputMatrixRow(`⚡ РџСЂРѕРґР°Р¶ (${unitLabel})`, entries, "plan-sell", (entry) => formatPowerValue(entry.mode === "discharge" ? entry.powerKw : 0, powerUnit), "sell-row")}
          ${matrixRow("↔ Р”С–СЏ", entries, (entry) => modeLabel(entry.mode), "action-row")}
          ${matrixRow("💵 РџСЂРёР±СѓС‚РѕРє", entries, (entry) => formatNumber(entry.profit, 0), "profit-row")}
          ${matrixRow("🔋 SOC (kWh)", entries, (entry) => formatNumber(entry.batteryEnergyKwh || 0, 0), "soc-row")}
          <tr class="total-row">
            <th>Σ Р’РЎР¬РћР“Рћ</th>
            <td colspan="24">${formatNumber(totalProfit, 0)} в‚ґ</td>
          </tr>
        </tbody>
      </table>
      <table class="plan-matrix plan-matrix-mobile">
        <thead>
          <tr>
            <th>Година</th>
            <th>Ціна РДН</th>
            <th>Купівля (${unitLabel})</th>
            <th>Продаж (${unitLabel})</th>
            <th>Дія</th>
            <th>Прибуток</th>
            <th>SOC</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry, index) => renderPlanHourTableRow(entry, index, powerUnit)).join("")}
          <tr class="total-row">
            <th>ВСЬОГО</th>
            <td colspan="4">24 години</td>
            <td>${formatNumber(totalProfit, 0)} ₴</td>
            <td>${formatNumber(entries.at(-1)?.batteryEnergyKwh || 0, 0)} kWh</td>
          </tr>
        </tbody>
      </table>
      <div class="mobile-plan-list">
        ${entries.map((entry, index) => renderPlanHourCard(entry, index, powerUnit, unitLabel)).join("")}
        <article class="mobile-plan-total">
          <span>ВСЬОГО</span>
          <strong>${formatNumber(totalProfit, 0)} ₴</strong>
        </article>
      </div>
    </div>
  `;
}

function renderPlanHourTableRowLegacy(entry, index, powerUnit) {
  const buyValue = entry.mode === "charge" ? entry.powerKw : 0;
  const sellValue = entry.mode === "discharge" ? entry.powerKw : 0;
  return `
    <tr class="plan-hour-table-row ${entry.mode || "idle"}">
      <th><span class="hour-chip">${HOURS[index]}</span></th>
      <td class="price-cell">${formatNumber(entry.price, 0)}</td>
      <td class="buy-cell">
        <input data-field="plan-buy" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(buyValue, powerUnit))}">
      </td>
      <td class="sell-cell">
        <input data-field="plan-sell" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(sellValue, powerUnit))}">
      </td>
      <td class="action-cell">${modeLabel(entry.mode)}</td>
      <td class="profit-cell">${formatNumber(entry.profit, 0)} ₴</td>
      <td class="soc-cell">${formatNumber(entry.batteryEnergyKwh || 0, 0)} kWh</td>
    </tr>
  `;
}

function renderPlanHourCard(entry, index, powerUnit, unitLabel) {
  const buyValue = entry.mode === "charge" ? entry.powerKw : 0;
  const sellValue = entry.mode === "discharge" ? entry.powerKw : 0;
  return `
    <article class="mobile-plan-card ${entry.mode || "idle"}">
      <header>
        <span class="hour-chip">${HOURS[index]}</span>
        <strong>${formatNumber(entry.price, 0)} грн/МВт·год</strong>
      </header>
      <div class="mobile-plan-grid">
        <label>
          <span>Купівля (${unitLabel})</span>
          <input data-field="plan-buy" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(buyValue, powerUnit))}">
        </label>
        <label>
          <span>Продаж (${unitLabel})</span>
          <input data-field="plan-sell" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(sellValue, powerUnit))}">
        </label>
        <div>
          <span>Дія</span>
          <strong>${modeLabel(entry.mode)}</strong>
        </div>
        <div>
          <span>Прибуток</span>
          <strong>${formatNumber(entry.profit, 0)} ₴</strong>
        </div>
        <div>
          <span>SOC</span>
          <strong>${formatNumber(entry.batteryEnergyKwh || 0, 0)} kWh</strong>
        </div>
      </div>
    </article>
  `;
}

function normalizePlanSlots(plan) {
  const source = plan.length ? plan : [];
  return HOURS.map((hour, index) => source[index] || {
    id: `slot-${index}`,
    hour,
    price: 0,
    mode: "idle",
    powerKw: 0,
    profit: 0,
    batteryEnergyKwh: 0,
  });
}

function matrixRow(label, entries, renderValue, rowClass) {
  return `
    <tr class="${rowClass}">
      <th>${label}</th>
      ${entries.map((entry) => `<td>${renderValue(entry)}</td>`).join("")}
    </tr>
  `;
}

function inputMatrixRow(label, entries, field, renderValue, rowClass) {
  return `
    <tr class="${rowClass}">
      <th>${label}</th>
      ${entries.map((entry) => `
        <td>
          <input data-field="${field}" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(renderValue(entry))}">
        </td>
      `).join("")}
    </tr>
  `;
}

function renderManualControlLegacy(selectedBatteryId, batteries, manualControl = {}) {
  const selected = batteries.find((battery) => battery.id === selectedBatteryId);
  const target = manualControl.target || selected?.id || "virtual";
  return `
    <div class="manual-grid">
      <label>
        Потужність заряду:
        <input data-field="manual-charge-power" type="number" min="0" step="1" value="${formatPlainNumber(manualControl.chargePowerKw ?? 50)}">
        <span>кВт</span>
      </label>
      <button data-action="manual-control" data-mode="charge">🔋 ЗАРЯД</button>

      <label>
        Потужність розряду:
        <input data-field="manual-discharge-power" type="number" min="0" step="1" value="${formatPlainNumber(manualControl.dischargePowerKw ?? 50)}">
        <span>кВт</span>
      </label>
      <button data-action="manual-control" data-mode="discharge">⚡ РОЗРЯД</button>

      <label>
        Ціль:
        <select data-field="manual-target">
          <option value="virtual" ${target === "virtual" ? "selected" : ""}>Virtual BESS</option>
          ${batteries.map((battery) => `<option value="${battery.id}" ${target === battery.id ? "selected" : ""}>${escapeHtml(battery.name)}</option>`).join("")}
        </select>
      </label>
      <button data-action="manual-control" data-mode="idle">■ СТОП</button>

      <label>
        Час початку:
        <input data-field="manual-start" type="time" value="${escapeHtml(manualControl.startTime || "11:00")}">
      </label>
      <label>
        Час завершення:
        <input data-field="manual-end" type="time" value="${escapeHtml(manualControl.endTime || "12:00")}">
      </label>
      <label class="range-check">
        <input data-field="manual-use-range" type="checkbox" ${manualControl.useRange ? "checked" : ""}>
        <span>Використати діапазон</span>
      </label>
    </div>
  `;
}

function renderManualControl(selectedBatteryId, batteries, manualControl = {}) {
  const selected = batteries.find((battery) => battery.id === selectedBatteryId);
  const target = manualControl.target || selected?.id || "virtual";
  const batteryOptions = `
    <option value="virtual" ${target === "virtual" ? "selected" : ""}>Virtual BESS</option>
    ${batteries.map((battery) => `<option value="${battery.id}" ${target === battery.id ? "selected" : ""}>${escapeHtml(battery.name)}</option>`).join("")}
  `;
  const cards = [
    {
      className: "charge",
      title: "Заряд",
      icon: "🔋",
      body: `
        <label class="card-field">
          <span>Потужність</span>
          <div class="with-unit">
            <input data-field="manual-charge-power" type="number" min="0" step="1" value="${formatPlainNumber(manualControl.chargePowerKw ?? 50)}">
            <em>кВт</em>
          </div>
        </label>
        <button data-action="manual-control" data-mode="charge">ЗАРЯД</button>
      `,
    },
    {
      className: "discharge",
      title: "Розряд",
      icon: "⚡",
      body: `
        <label class="card-field">
          <span>Потужність</span>
          <div class="with-unit">
            <input data-field="manual-discharge-power" type="number" min="0" step="1" value="${formatPlainNumber(manualControl.dischargePowerKw ?? 50)}">
            <em>кВт</em>
          </div>
        </label>
        <button data-action="manual-control" data-mode="discharge">РОЗРЯД</button>
      `,
    },
    {
      className: "target",
      title: "Ціль",
      icon: "▣",
      body: `
        <label class="card-field">
          <span>Батарея / група</span>
          <select data-field="manual-target">${batteryOptions}</select>
        </label>
        <button data-action="manual-control" data-mode="idle">■ СТОП</button>
      `,
    },
    {
      className: "grid-switch",
      title: "Зарядка від мережі",
      icon: "⏻",
      body: `
        <div class="manual-button-pair">
          <button class="save-button" data-action="grid-charging" data-mode="on">Увімкнути</button>
          <button class="delete-button" data-action="grid-charging" data-mode="off">Вимкнути</button>
        </div>
      `,
    },
    {
      className: "schedule",
      title: "Діапазон",
      icon: "◷",
      body: `
        <div class="manual-time-grid">
          <label class="card-field">
            <span>Початок</span>
            <input data-field="manual-start" type="time" value="${escapeHtml(manualControl.startTime || "11:00")}">
          </label>
          <label class="card-field">
            <span>Завершення</span>
            <input data-field="manual-end" type="time" value="${escapeHtml(manualControl.endTime || "12:00")}">
          </label>
        </div>
        <label class="range-check">
          <input data-field="manual-use-range" type="checkbox" ${manualControl.useRange ? "checked" : ""}>
          <span>Використати діапазон</span>
        </label>
      `,
    },
  ];
  return `<div class="manual-card-grid">${cards.map(renderControlCard).join("")}</div>`;
}

function renderControlCard({ className = "", title, icon, body }) {
  return `
    <article class="control-card ${className}">
      <header>
        <span>${escapeHtml(icon)}</span>
        <strong>${escapeHtml(title)}</strong>
      </header>
      <div class="control-card-body">${body}</div>
    </article>
  `;
}

function sideMetric(value, label) {
  return `
    <article class="side-metric">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </article>
  `;
}

function summaryItem(label, value) {
  return `
    <div class="summary-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function sliderRow(label, field, value, unit, min, max) {
  return `
    <label class="slider-row">
      <span>${escapeHtml(label)}</span>
      <input data-field="${field}" type="range" min="${min}" max="${max}" value="${value}">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(unit)}</span>
    </label>
  `;
}

function totalCharge(plan) {
  return plan.filter((entry) => entry.mode === "charge").reduce((sum, entry) => sum + entry.powerKw, 0);
}

function totalDischarge(plan) {
  return plan.filter((entry) => entry.mode === "discharge").reduce((sum, entry) => sum + entry.powerKw, 0);
}

function renderPlanMatrix(plan, powerUnit = "kw") {
  const entries = normalizePlanSlots(plan);
  const unitLabel = powerUnit === "mw" ? "MW" : "kW";
  const totalCost = entries.reduce((sum, entry) => sum + entry.profit, 0);
  const maxPrice = Math.max(...entries.map((entry) => Number(entry.price) || 0), 1);
  const maxCost = Math.max(...entries.map((entry) => Math.abs(Number(entry.profit) || 0)), 1);

  return `
    <div class="matrix-wrap">
      <table class="plan-matrix plan-matrix-wide">
        <thead>
          <tr>
            <th>Година</th>
            ${HOURS.map((hour) => `<th>${hour}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${matrixRow("💰 Ціна РДН", entries, (entry) => renderInlineMetric(entry.price, maxPrice, "price"), "price-row")}
          ${inputMatrixRow(`🔋 Купівля (${unitLabel})`, entries, "plan-buy", (entry) => formatPowerValue(entry.mode === "charge" ? entry.powerKw : 0, powerUnit), "buy-row")}
          ${inputMatrixRow(`⚡ Продаж (${unitLabel})`, entries, "plan-sell", (entry) => formatPowerValue(entry.mode === "discharge" ? entry.powerKw : 0, powerUnit), "sell-row")}
          ${matrixRow("↔ Дія", entries, (entry) => `<span class="mode-pill ${entry.mode || "idle"}">${modeIcon(entry.mode)} ${modeLabel(entry.mode)}</span>`, "action-row")}
          ${matrixRow("💵 Вартість", entries, (entry) => renderInlineMetric(entry.profit, maxCost, entry.profit < 0 ? "cost negative" : "cost positive", "₴"), "profit-row")}
          ${matrixRow("🔋 SOC (kWh)", entries, (entry) => `<span class="soc-badge">🔋 ${formatNumber(entry.batteryEnergyKwh || 0, 0)}</span>`, "soc-row")}
          <tr class="total-row">
            <th>📈 Маржа</th>
            <td colspan="24">${formatNumber(totalCost, 0)} ₴</td>
          </tr>
        </tbody>
      </table>

      <table class="plan-matrix plan-matrix-mobile">
        <thead>
          <tr>
            <th>🕒 Година</th>
            <th>💰 Ціна</th>
            <th>🔋 Купівля</th>
            <th>⚡ Продаж</th>
            <th>↔ Дія</th>
            <th>💵 Вартість</th>
            <th>🔋 SOC</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry, index) => renderPlanHourTableRow(entry, index, powerUnit, maxPrice, maxCost)).join("")}
          <tr class="total-row mobile-margin-row">
            <th>📈 Маржа</th>
            <td colspan="4">24 години</td>
            <td>${formatNumber(totalCost, 0)} ₴</td>
            <td>${formatNumber(entries.at(-1)?.batteryEnergyKwh || 0, 0)} kWh</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderPlanHourTableRow(entry, index, powerUnit, maxPrice = 1, maxCost = 1) {
  const buyValue = entry.mode === "charge" ? entry.powerKw : 0;
  const sellValue = entry.mode === "discharge" ? entry.powerKw : 0;
  const pricePercent = Math.max(4, Math.min(100, ((Number(entry.price) || 0) / maxPrice) * 100));
  const cost = Number(entry.profit) || 0;
  const costPercent = Math.max(4, Math.min(100, (Math.abs(cost) / maxCost) * 100));
  return `
    <tr class="plan-hour-table-row ${entry.mode || "idle"}">
      <th><span class="hour-chip">🕒 ${HOURS[index]}</span></th>
      <td class="price-cell">
        <div class="mobile-cell-viz price-viz">
          <strong>${formatNumber(entry.price, 0)}</strong>
          <span class="mini-bar"><i style="--w:${pricePercent}%"></i></span>
        </div>
      </td>
      <td class="buy-cell">
        <input data-field="plan-buy" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(buyValue, powerUnit))}">
      </td>
      <td class="sell-cell">
        <input data-field="plan-sell" data-id="${entry.id}" type="number" min="0" step="1" value="${formatPlainNumber(formatPowerValue(sellValue, powerUnit))}">
      </td>
      <td class="action-cell"><span class="mode-pill ${entry.mode || "idle"}">${modeIcon(entry.mode)} ${modeLabel(entry.mode)}</span></td>
      <td class="profit-cell">
        <div class="mobile-cell-viz cost-viz ${cost < 0 ? "negative" : "positive"}">
          <strong>${formatNumber(cost, 0)} ₴</strong>
          <span class="mini-bar"><i style="--w:${costPercent}%"></i></span>
        </div>
      </td>
      <td class="soc-cell">🔋 ${formatNumber(entry.batteryEnergyKwh || 0, 0)} kWh</td>
    </tr>
  `;
}

function renderInlineMetric(value, max, kind, suffix = "") {
  const number = Number(value) || 0;
  const percent = Math.max(4, Math.min(100, (Math.abs(number) / Math.max(Math.abs(max), 1)) * 100));
  return `
    <span class="inline-viz ${kind}">
      <strong>${formatNumber(number, 0)}${suffix ? ` ${suffix}` : ""}</strong>
      <i style="--w:${percent}%"></i>
    </span>
  `;
}

function modeIcon(mode) {
  if (mode === "charge") return "🔋";
  if (mode === "discharge") return "⚡";
  return "•";
}

function tomorrowValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function formatPlanDate(value) {
  if (!value) return "ПЛАН";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function modeLabel(mode) {
  if (mode === "charge") return "+";
  if (mode === "discharge") return "-";
  return "–";
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function formatNumber(value, decimals = 1) {
  return new Intl.NumberFormat("uk-UA", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) || 0);
}

function formatPower(valueKw, unit = "kw") {
  return formatNumber(formatPowerValue(valueKw, unit), unit === "mw" ? 3 : 0);
}

function formatPowerValue(valueKw, unit = "kw") {
  const value = Number(valueKw) || 0;
  return unit === "mw" ? value / 1000 : value;
}

function formatPlainNumber(value) {
  const number = Number(value) || 0;
  return Math.round(number * 1000) / 1000;
}

function sanitizeSensorKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
