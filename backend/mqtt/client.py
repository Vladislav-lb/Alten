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

    def __init__(
        self,
        topics: MqttTopicMap | None = None,
        host: str | None = None,
        port: int = 1883,
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self.topics = topics or MqttTopicMap()
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.connected = False
        self.client = None
        self.published: list[dict[str, Any]] = []

    async def connect(self) -> None:
        if not self.host:
            self.connected = True
            return
        import paho.mqtt.client as mqtt

        self.client = mqtt.Client()
        if self.username:
            self.client.username_pw_set(self.username, self.password)
        self.client.connect(self.host, self.port, keepalive=60)
        self.client.loop_start()
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
        self.published.append({"topic": topic, "payload": message, "retain": retain})
        if self.client is not None:
            result = self.client.publish(topic, message, retain=retain)
            if result.rc != 0:
                raise RuntimeError(f"MQTT publish failed: rc={result.rc}")

    def diagnostics(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "host": self.host,
            "topics": asdict(self.topics),
            "published_count": len(self.published),
        }
