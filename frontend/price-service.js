import { normalizePrices } from "./plan-calculator.js";

const CACHE_KEY = "alten-ems-prices";
const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

export class PriceService extends EventTarget {
  constructor({ hass = null, config = {}, baseUrl = null } = {}) {
    super();
    this.hass = hass;
    this.config = config;
    this.baseUrl = baseUrl;
    this.date = null;
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

  setDate(date) {
    this.date = date || null;
    this.prices = loadCachedPrices(this.date);
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

  async refresh({ date = this.date } = {}) {
    this.date = date || this.date;
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
          saveCachedPrices(prices, this.date);
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
    const url = this.config.price_api_url || "/api/prices";
    if (!url) return [];

    const response = await fetch(this.withDateQuery(this.resolveUrl(url)), {
      headers: {
        Accept: "application/json",
        ...(this.config.price_api_token ? { Authorization: `Bearer ${this.config.price_api_token}` } : {}),
        ...(this.config.price_api_key ? { "X-API-KEY": this.config.price_api_key } : {}),
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
    return loadCachedPrices(this.date);
  }

  async generateFallbackPrices() {
    const base = this.date ? parseLocalDate(this.date) : new Date();
    return Array.from({ length: 24 }, (_, index) => {
      const time = new Date(base);
      time.setMinutes(0, 0, 0);
      time.setHours(index);
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

  resolveUrl(path) {
    const configured = this.config.backend_url || this.config.backendUrl;
    if (configured) return new URL(path, ensureTrailingSlash(configured)).toString();
    if (this.baseUrl) return new URL(path, this.baseUrl).toString();
    return path;
  }

  withDateQuery(url) {
    if (!this.date && !this.config.price_api_zone_eic) return url;
    const next = new URL(url, window.location.href);
    const dateParam = this.config.price_api_date_param || "date";
    if (this.date) next.searchParams.set(dateParam, this.date);
    if (this.config.price_api_zone_eic) {
      next.searchParams.set("zone_eic", this.config.price_api_zone_eic);
    }
    return next.toString();
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

function loadCachedPrices(date = null) {
  try {
    const cached = localStorage.getItem(cacheKey(date));
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

function saveCachedPrices(prices, date = null) {
  try {
    localStorage.setItem(cacheKey(date), JSON.stringify({
      cachedAt: new Date().toISOString(),
      prices,
    }));
  } catch {
    // Local storage can be disabled in kiosk browsers.
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function cacheKey(date = null) {
  return date ? `${CACHE_KEY}-${date}` : CACHE_KEY;
}

function parseLocalDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}
