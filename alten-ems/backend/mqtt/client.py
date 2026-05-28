from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class MqttTopicMap:
    telemetry_prefix: str = "alten/ems"
    command_prefix: str = "alten/ems/command"
    discovery_prefix: str = "homeassistant"


class EmsMqttClient:
    """Adapter boundary for MQTT libraries such as aiomqtt or paho-mqtt."""

    def __init__(self, topics: MqttTopicMap | None = None) -> None:
        self.topics = topics or MqttTopicMap()
        self.connected = False

    async def connect(self) -> None:
        self.connected = True

    async def publish_telemetry(self, battery_id: str, payload: dict[str, Any]) -> tuple[str, str]:
        topic = f"{self.topics.telemetry_prefix}/{battery_id}/state"
        message = json.dumps(payload, separators=(",", ":"))
        await self._publish(topic, message, retain=False)
        return topic, message

    async def publish_discovery(self, battery_id: str, name: str) -> tuple[str, str]:
        topic = f"{self.topics.discovery_prefix}/sensor/alten_ems_{battery_id}/config"
        payload = {
            "name": f"Alten EMS {name}",
            "state_topic": f"{self.topics.telemetry_prefix}/{battery_id}/state",
            "json_attributes_topic": f"{self.topics.telemetry_prefix}/{battery_id}/state",
            "unique_id": f"alten_ems_{battery_id}",
            "device": {
                "identifiers": [f"alten_ems_{battery_id}"],
                "name": name,
                "manufacturer": "Alten",
                "model": "BESS EMS",
            },
        }
        message = json.dumps(payload, separators=(",", ":"))
        await self._publish(topic, message, retain=True)
        return topic, message

    async def publish_command(self, battery_id: str, mode: str, power_kw: float) -> tuple[str, str]:
        topic = f"{self.topics.command_prefix}/{battery_id}"
        message = json.dumps({"mode": mode, "power_kw": power_kw}, separators=(",", ":"))
        await self._publish(topic, message, retain=False)
        return topic, message

    async def _publish(self, topic: str, message: str, retain: bool) -> None:
        if not self.connected:
            raise RuntimeError("MQTT client is not connected")
        _ = (topic, message, retain)

    def diagnostics(self) -> dict[str, Any]:
        return {"connected": self.connected, "topics": asdict(self.topics)}
