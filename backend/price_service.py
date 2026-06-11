from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


class MarketPriceService:
    def __init__(
        self,
        *,
        data_dir: Path,
        api_key: str | None,
        prices_url: str,
        zone_eic: str,
        date_param: str = "date",
        fallback_prices: list[float] | None = None,
    ) -> None:
        self.api_key = api_key
        self.prices_url = prices_url
        self.zone_eic = normalize_zone(zone_eic)
        self.date_param = date_param or "date"
        self.fallback_prices = fallback_prices or []
        self.cache_path = data_dir / "prices_cache.json"

    async def get_prices(self, trade_day: str | None = None, zone_eic: str | None = None) -> list[dict[str, Any]]:
        target_day = parse_trade_day(trade_day) if trade_day else tomorrow_kyiv()
        target_zone = normalize_zone(zone_eic or self.zone_eic)

        cached = self.read_cache(target_day, target_zone)
        try:
            prices = await self.fetch_oree_prices(target_day, target_zone)
            if prices:
                self.write_cache(target_day, target_zone, prices)
                return prices
        except Exception:
            if cached:
                return cached
            raise

        if cached:
            return cached
        return self.fallback_for_day(target_day, target_zone)

    async def fetch_oree_prices(self, trade_day: date, zone_eic: str) -> list[dict[str, Any]]:
        if not self.api_key:
            return []

        import aiohttp

        headers = {
            "Accept": "application/json, */*",
            "X-API-KEY": self.api_key,
        }
        url = with_query_param(self.prices_url, self.date_param, format_oree_date(trade_day))
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                if response.status == 403:
                    raise RuntimeError("OREE API key rejected or data is not available for this date")
                response.raise_for_status()
                payload = await response.json(content_type=None)

        return normalize_oree_payload(payload, trade_day, zone_eic)

    def read_cache(self, trade_day: date, zone_eic: str) -> list[dict[str, Any]]:
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        key = cache_key(trade_day, zone_eic)
        prices = payload.get(key, {}).get("prices", [])
        return prices if isinstance(prices, list) else []

    def write_cache(self, trade_day: date, zone_eic: str, prices: list[dict[str, Any]]) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
        payload[cache_key(trade_day, zone_eic)] = {
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "prices": prices,
        }
        self.cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def fallback_for_day(self, trade_day: date, zone_eic: str) -> list[dict[str, Any]]:
        return [
            {
                "id": f"{trade_day.isoformat()}-{period:02d}",
                "time": datetime.combine(trade_day, datetime.min.time()).replace(tzinfo=timezone.utc).replace(hour=period - 1).isoformat(),
                "period": period,
                "price": float(price),
                "currency": "UAH",
                "market": "RDN",
                "zone_eic": zone_eic,
                "trade_day": trade_day.isoformat(),
                "source": "fallback",
            }
            for period, price in enumerate(self.fallback_prices[:24], start=1)
        ]


def normalize_oree_payload(payload: Any, trade_day: date, zone_eic: str) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []

    requested_day = trade_day.isoformat()
    requested_zone = normalize_zone(zone_eic)
    exact = [
        record for record in payload
        if normalize_zone(str(record.get("zone_eic", ""))) == requested_zone
        and normalize_day(str(record.get("trade_day", ""))) == requested_day
    ]
    same_day = [
        record for record in payload
        if normalize_day(str(record.get("trade_day", ""))) == requested_day
    ]
    candidates = exact or same_day
    if not candidates:
        return []

    record = candidates[0]
    data = record.get("data")
    if not isinstance(data, list):
        return []

    prices: list[dict[str, Any]] = []
    for item in data:
        try:
            period = int(item.get("period"))
            price = float(str(item.get("price", "0")).replace(",", "."))
        except (TypeError, ValueError):
            continue
        hour = max(0, min(23, period - 1))
        timestamp = datetime.combine(trade_day, datetime.min.time()).replace(tzinfo=timezone.utc).replace(hour=hour)
        prices.append(
            {
                "id": f"{requested_day}-{period:02d}",
                "time": timestamp.isoformat(),
                "period": period,
                "price": price,
                "currency": "UAH",
                "market": "RDN",
                "zone_eic": record.get("zone_eic") or zone_eic,
                "trade_day": requested_day,
                "source": "oree",
            }
        )
    return sorted(prices, key=lambda item: item["period"])


def parse_trade_day(value: str) -> date:
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError("date must be YYYY-MM-DD or DD.MM.YYYY")


def tomorrow_kyiv() -> date:
    return (datetime.now(timezone.utc) + timedelta(days=1)).date()


def format_oree_date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def normalize_day(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    try:
        return parse_trade_day(value).isoformat()
    except ValueError:
        return value[:10]


def normalize_zone(value: str) -> str:
    return value.replace(chr(0x2014), "-").replace(chr(0x2013), "-").strip()


def cache_key(trade_day: date, zone_eic: str) -> str:
    return f"{trade_day.isoformat()}::{normalize_zone(zone_eic)}"


def with_query_param(url: str, key: str, value: str) -> str:
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode({key: value})}"
