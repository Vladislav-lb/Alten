const DEFAULT_OPTIONS = Object.freeze({
  intervalHours: 1,
  reserveSoc: 15,
  targetSoc: null,
  priceUnitScale: 1000,
  cycleCostPerMwh: 0,
  maxCyclesPerDay: 1.5,
});

export class PlanCalculator {
  calculate({ prices = [], virtualBattery, options = {}, existingPlan = [] }) {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const battery = normalizeVirtualBattery(virtualBattery, settings);
    const normalizedPrices = normalizePrices(prices);

    if (!battery.enabled || battery.capacityKwh <= 0 || normalizedPrices.length === 0) {
      return emptyResult(normalizedPrices, "No active batteries or prices available.");
    }

    const minMargin = Number(settings.minMargin ?? settings.min_margin ?? 0) || 0;
    const chargeEfficiency = Math.sqrt(battery.roundtripEfficiency);
    const dischargeEfficiency = Math.sqrt(battery.roundtripEfficiency);
    const dailyThroughputLimit = battery.capacityKwh * settings.maxCyclesPerDay;
    const usableCapacityKwh = battery.capacityKwh * Math.max(0, battery.maxSoc - battery.minSoc) / 100;
    const chargeSlotIds = selectEnergySlots({
      prices: normalizedPrices,
      energyTargetKwh: usableCapacityKwh,
      energyPerSlotKwh: battery.maxChargeKw * settings.intervalHours * chargeEfficiency,
      reverse: false,
    });
    const dischargeSlotIds = selectEnergySlots({
      prices: normalizedPrices,
      energyTargetKwh: usableCapacityKwh,
      energyPerSlotKwh: battery.maxDischargeKw * settings.intervalHours / dischargeEfficiency,
      reverse: true,
    });
    const cheapestPrice = Math.min(...normalizedPrices.filter((slot) => chargeSlotIds.has(slot.id)).map((slot) => slot.price));
    const mostExpensivePrice = Math.max(...normalizedPrices.filter((slot) => dischargeSlotIds.has(slot.id)).map((slot) => slot.price));

    let soc = clamp(battery.soc, battery.minSoc, battery.maxSoc);
    let chargedThroughput = 0;
    let dischargedThroughput = 0;
    let profit = 0;

    const plan = normalizedPrices.map((slot, index) => {
      const manual = existingPlan.find((entry) => sameHour(entry.time, slot.time));
      const socStart = soc;
      const action = manual?.locked
        ? manualAction(manual)
        : optimizeAction({
          slot,
          index,
          prices: normalizedPrices,
          soc,
          battery,
          chargeSlotIds,
          dischargeSlotIds,
          cheapestPrice: Number.isFinite(cheapestPrice) ? cheapestPrice : Math.min(...normalizedPrices.map((item) => item.price)),
          mostExpensivePrice: Number.isFinite(mostExpensivePrice) ? mostExpensivePrice : Math.max(...normalizedPrices.map((item) => item.price)),
          chargedThroughput,
          dischargedThroughput,
          dailyThroughputLimit,
          minMargin,
        });

      const bounded = boundAction(action, {
        battery,
        soc,
        intervalHours: settings.intervalHours,
        chargeEfficiency,
        dischargeEfficiency,
        remainingChargeThroughput: Math.max(0, dailyThroughputLimit - chargedThroughput),
        remainingDischargeThroughput: Math.max(0, dailyThroughputLimit - dischargedThroughput),
      });

      const economics = calculateEconomics({
        mode: bounded.mode,
        gridEnergyKwh: bounded.gridEnergyKwh,
        batteryEnergyKwh: bounded.batteryEnergyKwh,
        price: slot.price,
        priceUnitScale: settings.priceUnitScale,
        cycleCostPerMwh: settings.cycleCostPerMwh,
      });

      if (bounded.mode === "charge") {
        soc += (bounded.batteryEnergyKwh / battery.capacityKwh) * 100;
        chargedThroughput += bounded.batteryEnergyKwh;
      } else if (bounded.mode === "discharge") {
        soc -= (bounded.batteryEnergyKwh / battery.capacityKwh) * 100;
        dischargedThroughput += bounded.batteryEnergyKwh;
      }
      soc = clamp(soc, battery.minSoc, battery.maxSoc);
      profit += economics.profit;

      return {
        id: slot.id || `slot-${index}`,
        time: slot.time,
        hour: hourLabel(slot.time),
        price: slot.price,
        mode: bounded.mode,
        powerKw: round(bounded.powerKw, 3),
        energyKwh: round(bounded.gridEnergyKwh, 3),
        batteryEnergyKwh: round(bounded.batteryEnergyKwh, 3),
        socStart: round(socStart, 2),
        socEnd: round(soc, 2),
        profit: round(economics.profit, 2),
        reason: manual?.locked ? "Manual override" : bounded.reason,
        locked: Boolean(manual?.locked),
      };
    });

    const targetAdjustment = settings.targetSoc == null
      ? []
      : calculateTargetAdjustment(plan, battery, settings.targetSoc);

    return {
      plan,
      targetAdjustment,
      summary: summarizePlan(plan, battery, profit),
      generatedAt: new Date().toISOString(),
    };
  }
}

export function summarizePlan(plan, battery, profit = null) {
  const chargeKwh = plan
    .filter((entry) => entry.mode === "charge")
    .reduce((sum, entry) => sum + entry.energyKwh, 0);
  const dischargeKwh = plan
    .filter((entry) => entry.mode === "discharge")
    .reduce((sum, entry) => sum + entry.energyKwh, 0);
  const calculatedProfit = profit ?? plan.reduce((sum, entry) => sum + entry.profit, 0);
  return {
    chargeKwh: round(chargeKwh, 2),
    dischargeKwh: round(dischargeKwh, 2),
    profit: round(calculatedProfit, 2),
    finalSoc: plan.length ? plan[plan.length - 1].socEnd : battery.soc,
    activeHours: plan.filter((entry) => entry.mode !== "idle").length,
  };
}

export function normalizePrices(prices = []) {
  return prices
    .map((entry, index) => normalizePriceEntry(entry, index))
    .filter((entry) => Number.isFinite(entry.price))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

function normalizePriceEntry(entry, index) {
  if (typeof entry === "number") {
    return {
      id: `price-${index}`,
      time: new Date(Date.now() + index * 3600000).toISOString(),
      price: entry,
      currency: "UAH",
      market: "RDN",
      source: "api",
    };
  }
  return {
    id: entry.id || `price-${index}`,
    time: entry.time || entry.datetime || entry.start || new Date(Date.now() + index * 3600000).toISOString(),
    price: Number(entry.price ?? entry.value ?? entry.rdn ?? 0),
    currency: entry.currency || "UAH",
    market: entry.market || "RDN",
    source: entry.source || "api",
  };
}

export function planToCsv(plan = []) {
  const header = [
    "time",
    "hour",
    "price",
    "mode",
    "powerKw",
    "energyKwh",
    "socStart",
    "socEnd",
    "profit",
    "locked",
    "reason",
  ];
  const rows = plan.map((entry) => header.map((key) => csvEscape(entry[key])).join(","));
  return [header.join(","), ...rows].join("\n");
}

function optimizeAction(context) {
  const {
    slot,
    index,
    prices,
    soc,
    battery,
    chargeSlotIds,
    dischargeSlotIds,
    cheapestPrice,
    mostExpensivePrice,
    dischargedThroughput,
    dailyThroughputLimit,
    minMargin,
  } = context;
  const nearReserve = soc <= battery.minSoc + 1;
  const nearFull = soc >= battery.maxSoc - 1;
  const buySpreadOk = (mostExpensivePrice * battery.roundtripEfficiency) - slot.price >= minMargin;
  const sellSpreadOk = slot.price - (cheapestPrice / Math.max(battery.roundtripEfficiency, 0.001)) >= minMargin;

  if (
    chargeSlotIds.has(slot.id)
    && !nearFull
    && buySpreadOk
  ) {
    return { mode: "charge", powerKw: battery.maxChargeKw, reason: "Buy in cheap hour" };
  }

  if (
    dischargeSlotIds.has(slot.id)
    && !nearReserve
    && dischargedThroughput < dailyThroughputLimit
    && sellSpreadOk
  ) {
    return { mode: "discharge", powerKw: battery.maxDischargeKw, reason: "Sell in expensive hour" };
  }

  return { mode: "idle", powerKw: 0, reason: "Hold for better spread" };
}

function boundAction(action, limits) {
  const {
    battery,
    soc,
    intervalHours,
    chargeEfficiency,
    dischargeEfficiency,
    remainingChargeThroughput,
    remainingDischargeThroughput,
  } = limits;

  if (action.mode === "charge") {
    const headroomKwh = battery.capacityKwh * (battery.maxSoc - soc) / 100;
    const batteryEnergyKwh = Math.min(
      action.powerKw * intervalHours * chargeEfficiency,
      headroomKwh,
      remainingChargeThroughput,
    );
    const gridEnergyKwh = batteryEnergyKwh / chargeEfficiency;
    return {
      ...action,
      mode: batteryEnergyKwh > 0.001 ? "charge" : "idle",
      powerKw: gridEnergyKwh / intervalHours,
      gridEnergyKwh,
      batteryEnergyKwh,
    };
  }

  if (action.mode === "discharge") {
    const availableKwh = battery.capacityKwh * (soc - battery.minSoc) / 100;
    const batteryEnergyKwh = Math.min(
      action.powerKw * intervalHours / dischargeEfficiency,
      availableKwh,
      remainingDischargeThroughput,
    );
    const gridEnergyKwh = batteryEnergyKwh * dischargeEfficiency;
    return {
      ...action,
      mode: batteryEnergyKwh > 0.001 ? "discharge" : "idle",
      powerKw: gridEnergyKwh / intervalHours,
      gridEnergyKwh,
      batteryEnergyKwh,
    };
  }

  return {
    ...action,
    powerKw: 0,
    gridEnergyKwh: 0,
    batteryEnergyKwh: 0,
  };
}

function calculateEconomics({ mode, gridEnergyKwh, batteryEnergyKwh, price, priceUnitScale, cycleCostPerMwh }) {
  const energyMwh = gridEnergyKwh / priceUnitScale;
  const batteryMwh = batteryEnergyKwh / priceUnitScale;
  const cycleCost = batteryMwh * cycleCostPerMwh;
  if (mode === "charge") return { profit: -(energyMwh * price) - cycleCost };
  if (mode === "discharge") return { profit: (energyMwh * price) - cycleCost };
  return { profit: 0 };
}

function manualAction(entry) {
  return {
    mode: ["charge", "discharge", "idle"].includes(entry.mode) ? entry.mode : "idle",
    powerKw: Math.max(0, Number(entry.powerKw) || 0),
    reason: "Manual override",
  };
}

function normalizeVirtualBattery(battery = {}, settings) {
  return {
    enabled: battery.enabled !== false,
    capacityKwh: Number(battery.capacityKwh) || 0,
    soc: Number(battery.soc) || 0,
    minSoc: Math.max(Number(settings.reserveSoc ?? battery.minSoc) || 0, Number(battery.minSoc) || 0),
    maxSoc: Number(battery.maxSoc) || 100,
    maxChargeKw: Number(battery.maxChargeKw) || 0,
    maxDischargeKw: Number(battery.maxDischargeKw) || 0,
    roundtripEfficiency: clamp(Number(battery.roundtripEfficiency) || 0.9, 0.5, 1),
  };
}

function selectEnergySlots({ prices, energyTargetKwh, energyPerSlotKwh, reverse }) {
  if (energyTargetKwh <= 0 || energyPerSlotKwh <= 0) return new Set();
  const ranked = [...prices].sort((a, b) => reverse ? b.price - a.price : a.price - b.price);
  const selected = new Set();
  let remaining = energyTargetKwh;
  for (const slot of ranked) {
    if (remaining <= 0) break;
    selected.add(slot.id);
    remaining -= energyPerSlotKwh;
  }
  return selected;
}

function sameHour(a, b) {
  return new Date(a).toISOString().slice(0, 13) === new Date(b).toISOString().slice(0, 13);
}

function hourLabel(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function calculateTargetAdjustment(plan, battery, targetSoc) {
  const finalSoc = plan.length ? plan[plan.length - 1].socEnd : battery.soc;
  const deltaSoc = clamp(targetSoc, battery.minSoc, battery.maxSoc) - finalSoc;
  if (Math.abs(deltaSoc) < 0.5) return [];
  return [{
    direction: deltaSoc > 0 ? "charge" : "discharge",
    energyKwh: round(Math.abs(deltaSoc) * battery.capacityKwh / 100, 2),
    message: "Target SOC requires post-plan balancing.",
  }];
}

function emptyResult(prices, message) {
  return {
    plan: prices.map((slot, index) => ({
      id: slot.id || `slot-${index}`,
      time: slot.time,
      hour: hourLabel(slot.time),
      price: slot.price,
      mode: "idle",
      powerKw: 0,
      energyKwh: 0,
      batteryEnergyKwh: 0,
      socStart: 0,
      socEnd: 0,
      profit: 0,
      reason: message,
      locked: false,
    })),
    summary: { chargeKwh: 0, dischargeKwh: 0, profit: 0, finalSoc: 0, activeHours: 0 },
    generatedAt: new Date().toISOString(),
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
