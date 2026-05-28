import { normalizePrices } from "./plan-calculator.js";

const CACHE_KEY = "alten-ems-prices";
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

export class PriceService extends EventTarget {
  constructor({ hass = null, config = {} } = {}) {
    super();
    this.hass = hass;
    this.config = config;
    this.prices = loadCachedPrices();
    this.refreshTimer = null;
  }

  setHass(hass) {
    this.hass = hass;
  }

  setConfig(config = {}) {
    this.config = config;
  }

  getPrices() {
    return this.prices;
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    const refreshMs = Number(this.config.price_refresh_ms) || DEFAULT_REFRESH_MS;
    this.refreshTimer = setInterval(() => this.refresh().catch((error) => {
      this.emitError(error);
    }), refreshMs);
  }

  stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refresh() {
    const sources = [
      () => this.fetchFromApi(),
      () => this.fetchFromHomeAssistant(),
      () => this.fetchFromCache(),
      () => this.generateFallbackPrices(),
    ];

    let lastError = null;
    for (const source of sources) {
      try {
        const prices = normalizePrices(await source());
        if (prices.length) {
          this.prices = prices;
          saveCachedPrices(prices);
          this.dispatchEvent(new CustomEvent("prices", { detail: { prices } }));
          return prices;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) this.emitError(lastError);
    return this.prices;
  }

  async fetchFromApi() {
    const url = this.config.price_api_url;
    if (!url) return [];

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(this.config.price_api_token ? { Authorization: `Bearer ${this.config.price_api_token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`Price API failed: ${response.status}`);
    const payload = await response.json();
    return normalizeApiPayload(payload);
  }

  async fetchFromHomeAssistant() {
    const entityId = this.config.price_entity;
    if (!entityId || !this.hass?.states?.[entityId]) return [];
    const entity = this.hass.states[entityId];
    const raw = entity.attributes?.prices
      || entity.attributes?.hourly
      || entity.attributes?.data
      || entity.state;
    if (typeof raw === "string") {
      try {
        return normalizeApiPayload(JSON.parse(raw));
      } catch {
        return [];
      }
    }
    return normalizeApiPayload(raw);
  }

  async fetchFromCache() {
    return loadCachedPrices();
  }

  async generateFallbackPrices() {
    const now = new Date();
    return Array.from({ length: 24 }, (_, index) => {
      const time = new Date(now);
      time.setMinutes(0, 0, 0);
      time.setHours(now.getHours() + index);
      const peak = index >= 17 && index <= 21 ? 1.35 : 1;
      const night = index >= 0 && index <= 5 ? 0.72 : 1;
      return {
        time: time.toISOString(),
        price: Math.round(3200 * peak * night + Math.sin(index / 2) * 180),
        currency: "UAH",
        market: "RDN",
        source: "fallback",
      };
    });
  }

  emitError(error) {
    this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
  }
}

function normalizeApiPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.prices)) return payload.prices;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function loadCachedPrices() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return [];
    const payload = JSON.parse(cached);
    if (!Array.isArray(payload.prices)) return [];
    const ageMs = Date.now() - new Date(payload.cachedAt).getTime();
    if (ageMs > 36 * 60 * 60 * 1000) return [];
    return normalizePrices(payload.prices);
  } catch {
    return [];
  }
}

function saveCachedPrices(prices) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      cachedAt: new Date().toISOString(),
      prices,
    }));
  } catch {
    // Local storage can be disabled in kiosk browsers.
  }
}
