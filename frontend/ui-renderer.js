import { planToCsv } from "./plan-calculator.js";

const HOURS = Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);

export class UIRenderer extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.state = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundInput = (event) => this.handleInput(event);
  }

  async mount() {
    this.root.addEventListener("click", this.boundClick);
    this.root.addEventListener("change", this.boundInput);
    this.root.addEventListener("input", this.boundInput);
  }

  unmount() {
    this.root.removeEventListener("click", this.boundClick);
    this.root.removeEventListener("change", this.boundInput);
    this.root.removeEventListener("input", this.boundInput);
  }

  render(state) {
    this.state = state;
    const { virtualBattery, groups, batteries, planResult, alerts, selectedBatteryId, config } = state;
    const activeGroup = groups[0]?.group || "-- Група --";

    this.root.innerHTML = `
      <section class="ems-app">
        <header class="app-bar">
          <nav class="top-nav">
            <button class="active" data-action="navigate" data-id="control">Керування</button>
            <button data-action="navigate" data-id="monitoring">Моніторинг</button>
            <button data-action="navigate" data-id="analytics">Аналітика</button>
          </nav>
          <div class="app-tools">
            <button class="icon-only" data-action="refresh" title="Оновити">⌕</button>
            <button class="icon-only" data-action="open-monitor" title="Монітор">▣</button>
            <span class="user-dot"></span>
          </div>
        </header>

        <div class="workspace">
          <aside class="control-sidebar">
            <section class="side-section side-title">🔧 Керування</section>

            <section class="side-section">
              <div class="segmented">
                <button class="active" data-action="scope" data-id="clients">По клієнтах</button>
                <button data-action="scope" data-id="regions">По регіонах</button>
                <button data-action="scope" data-id="osr">По ОСР</button>
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
              ${renderBatteryTree(batteries, selectedBatteryId)}
            </section>
          </aside>

          <main class="main-stage">
            ${alerts.length ? renderAlerts(alerts) : ""}

            <section class="plan-card">
              <div class="day-tab">ЗАВТРА</div>
              <div class="plan-header">
                <h2>📊 План роботи BESS</h2>
                <div class="plan-toolbar">
                  <label class="date-picker">
                    <input data-field="plan-date" type="date" value="${tomorrowValue()}">
                  </label>
                  <button data-action="export-plan">📊 Експорт</button>
                  <button data-action="toggle-unit">kW ↔ MW</button>
                </div>
              </div>

              <div class="summary-strip">
                ${summaryItem("🔋 Ємність:", `${formatNumber(virtualBattery.capacityKwh, 0)} kWh`)}
                ${summaryItem("⚡ Заряд:", `${formatNumber(totalCharge(planResult.plan), 0)} kW`)}
                ${summaryItem("⚡ Розряд:", `${formatNumber(totalDischarge(planResult.plan), 0)} kW`)}
                ${summaryItem("📊 SOC:", `${formatNumber(virtualBattery.soc, 0)}% (${formatNumber(virtualBattery.capacityKwh * virtualBattery.soc / 100, 0)} kWh)`)}
              </div>

              ${renderPlanMatrix(planResult.plan)}
              ${renderChartPanel(planResult.plan)}

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
              </div>
            </section>

            <section class="lower-grid">
              <div class="utility-card manual-card">
                <h2>🎮 Ручне керування</h2>
                ${renderManualControl(selectedBatteryId, batteries)}
              </div>
              <div class="utility-card status-card">
                <div class="status-header">
                  <h2>📋 Статус планів</h2>
                  <button data-action="refresh">⟳</button>
                </div>
                <div class="status-body">
                  ${alerts.length ? alerts.map((alert) => `<p class="${alert.level || "warning"}">${escapeHtml(alert.message)}</p>`).join("") : "Завантаження..."}
                </div>
              </div>
            </section>
          </main>
        </div>
      </section>
    `;
  }

  handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "export-plan") {
      this.downloadPlanCsv();
      return;
    }
    this.dispatchEvent(new CustomEvent("action", {
      detail: {
        action,
        id: button.dataset.id,
        mode: button.dataset.mode,
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
      },
    }));
  }

  downloadPlanCsv() {
    const csv = planToCsv(this.state?.planResult?.plan || []);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alten-ems-plan-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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

function renderBatteryTree(batteries, selectedBatteryId) {
  if (!batteries.length) return emptyState("Немає батарей");
  return `
    <div class="tree-node">
      <button class="tree-toggle" data-action="toggle-tree">▸</button>
      <label><input type="checkbox" checked> 🏢 ALTEN</label>
    </div>
    <div class="tree-children">
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

function renderPlanMatrix(plan) {
  const entries = normalizePlanSlots(plan);
  return `
    <div class="matrix-wrap">
      <table class="plan-matrix">
        <thead>
          <tr>
            <th>Година</th>
            ${HOURS.map((hour) => `<th>${hour}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${matrixRow("💰 Ціна РДН", entries, (entry) => formatNumber(entry.price, 0), "price-row")}
          ${inputMatrixRow("🔋 Купівля (kW)", entries, "plan-buy", (entry) => entry.mode === "charge" ? entry.powerKw : 0, "buy-row")}
          ${inputMatrixRow("⚡ Продаж (kW)", entries, "plan-sell", (entry) => entry.mode === "discharge" ? entry.powerKw : 0, "sell-row")}
          ${matrixRow("↔ Дія", entries, (entry) => modeLabel(entry.mode), "action-row")}
          ${matrixRow("💰 Прибуток", entries, (entry) => formatNumber(entry.profit, 0), "profit-row")}
          ${matrixRow("🔋 SOC (kWh)", entries, (entry) => formatNumber(entry.batteryEnergyKwh || 0, 0), "soc-row")}
          <tr class="total-row">
            <th>ВСЬОГО</th>
            <td colspan="24">${formatNumber(entries.reduce((sum, entry) => sum + entry.profit, 0), 0)} ₴</td>
          </tr>
        </tbody>
      </table>
    </div>
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

function renderManualControl(selectedBatteryId, batteries) {
  const selected = batteries.find((battery) => battery.id === selectedBatteryId);
  return `
    <div class="manual-grid">
      <label>
        Потужність заряду:
        <input data-field="manual-charge-power" type="number" min="0" step="1" value="50">
        <span>кВт</span>
      </label>
      <button data-action="manual-control" data-mode="charge">🔋 ЗАРЯД</button>

      <label>
        Потужність розряду:
        <input data-field="manual-discharge-power" type="number" min="0" step="1" value="50">
        <span>кВт</span>
      </label>
      <button data-action="manual-control" data-mode="discharge">⚡ РОЗРЯД</button>

      <label>
        Ціль:
        <select data-field="manual-target">
          <option value="virtual" ${!selected ? "selected" : ""}>Virtual BESS</option>
          ${batteries.map((battery) => `<option value="${battery.id}" ${selected?.id === battery.id ? "selected" : ""}>${escapeHtml(battery.name)}</option>`).join("")}
        </select>
      </label>
      <button data-action="manual-control" data-mode="idle">■ СТОП</button>

      <label>
        Час початку:
        <input data-field="manual-start" type="time" value="11:00">
      </label>
      <label>
        Час завершення:
        <input data-field="manual-end" type="time" value="12:00">
      </label>
      <label class="range-check">
        <input data-field="manual-use-range" type="checkbox">
        <span>Використати діапазон</span>
      </label>
    </div>
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

function tomorrowValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
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

function formatPlainNumber(value) {
  const number = Number(value) || 0;
  return Math.round(number * 1000) / 1000;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
