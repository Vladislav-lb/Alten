from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


class PlanStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or Path(__file__).resolve().parent / "data"
        self.history_dir = self.base_dir / "history"
        self.current_plan_path = self.base_dir / "current_plan.json"
        self.history_dir.mkdir(parents=True, exist_ok=True)

    def save(self, plan: dict[str, Any], status: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        payload = {
            "id": plan.get("id") or f"plan_{uuid4().hex[:12]}",
            "status": status,
            "updated_at": now.isoformat(),
            "plan": plan,
        }
        self._write_json(self.current_plan_path, payload)
        history_path = self.history_dir / f"{now.strftime('%Y%m%dT%H%M%SZ')}_{payload['id']}_{status}.json"
        self._write_json(history_path, payload)
        return payload

    def load_current(self) -> dict[str, Any]:
        if not self.current_plan_path.exists():
            return {
                "id": None,
                "status": "draft",
                "updated_at": None,
                "plan": None,
            }
        return self._read_json(self.current_plan_path)

    def list_history(self, limit: int = 20) -> list[dict[str, Any]]:
        files = sorted(self.history_dir.glob("*.json"), reverse=True)[:limit]
        return [self._read_json(path) for path in files]

    def set_status(self, status: str) -> dict[str, Any]:
        current = self.load_current()
        plan = current.get("plan") or {}
        if current.get("id") and "id" not in plan:
            plan["id"] = current["id"]
        return self.save(plan, status)

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))
