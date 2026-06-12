from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


class CommandStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or Path(__file__).resolve().parent / "data"
        self.log_path = self.base_dir / "command_log.jsonl"
        self.status_path = self.base_dir / "dispatch_status.json"
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def append(self, payload: dict[str, Any]) -> dict[str, Any]:
        entry = {
            "id": payload.get("id") or f"cmd_{uuid4().hex[:12]}",
            "time": payload.get("time") or datetime.now(timezone.utc).isoformat(),
            **payload,
        }
        with self.log_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        return entry

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.log_path.exists():
            return []
        lines = self.log_path.read_text(encoding="utf-8").splitlines()
        entries: list[dict[str, Any]] = []
        for line in reversed(lines[-max(1, limit * 2):]):
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(entries) >= limit:
                break
        return entries

    def save_status(self, status: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            **status,
        }
        self.status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload

    def load_status(self) -> dict[str, Any]:
        if not self.status_path.exists():
            return {
                "updated_at": None,
                "ok": None,
                "source": "boot",
                "message": "No dispatch command has been sent yet",
            }
        return json.loads(self.status_path.read_text(encoding="utf-8"))
