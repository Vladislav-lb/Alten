from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.const import CONF_URL
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "alten_ems"
DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"

SERVICE_APPLY_PLAN = "apply_plan"
SERVICE_EMERGENCY_STOP = "emergency_stop"
SERVICE_MANUAL_CHARGE = "manual_charge"
SERVICE_MANUAL_DISCHARGE = "manual_discharge"

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_URL, default=DEFAULT_BACKEND_URL): str,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    domain_config = config.get(DOMAIN, {})
    backend_url = domain_config.get(CONF_URL, DEFAULT_BACKEND_URL).rstrip("/")
    session = async_get_clientsession(hass)

    async def post(path: str, payload: dict[str, Any]) -> None:
        url = f"{backend_url}{path}"
        try:
            async with session.post(url, json=payload) as response:
                response.raise_for_status()
        except Exception as err:
            _LOGGER.error("Alten EMS backend request failed: %s", err)
            raise

    async def apply_plan(call: ServiceCall) -> None:
        await post(
            "/api/services/alten_ems/apply_plan",
            {"plan": call.data.get("plan", {}), "status": "applied"},
        )

    async def emergency_stop(call: ServiceCall) -> None:
        await post(
            "/api/services/alten_ems/emergency_stop",
            {"battery_id": call.data.get("battery_id", "batt_1"), "power_kw": 0},
        )

    async def manual_charge(call: ServiceCall) -> None:
        await post(
            "/api/services/alten_ems/manual_charge",
            {
                "battery_id": call.data["battery_id"],
                "power_kw": call.data["power_kw"],
            },
        )

    async def manual_discharge(call: ServiceCall) -> None:
        await post(
            "/api/services/alten_ems/manual_discharge",
            {
                "battery_id": call.data["battery_id"],
                "power_kw": call.data["power_kw"],
            },
        )

    hass.services.async_register(
        DOMAIN,
        SERVICE_APPLY_PLAN,
        apply_plan,
        schema=vol.Schema({vol.Optional("plan", default={}): dict}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_EMERGENCY_STOP,
        emergency_stop,
        schema=vol.Schema({vol.Optional("battery_id", default="batt_1"): str}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_MANUAL_CHARGE,
        manual_charge,
        schema=vol.Schema({
            vol.Required("battery_id", default="batt_1"): str,
            vol.Required("power_kw", default=50): vol.Coerce(float),
        }),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_MANUAL_DISCHARGE,
        manual_discharge,
        schema=vol.Schema({
            vol.Required("battery_id", default="batt_1"): str,
            vol.Required("power_kw", default=50): vol.Coerce(float),
        }),
    )

    return True
