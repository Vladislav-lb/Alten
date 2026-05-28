from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from plan_store import PlanStore


class PlanStoreTest(unittest.TestCase):
    def test_save_current_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = PlanStore(Path(temp_dir))
            saved = store.save({"id": "plan_test", "slots": []}, "confirmed")

            self.assertEqual(saved["status"], "confirmed")
            self.assertEqual(store.load_current()["id"], "plan_test")
            self.assertEqual(len(store.list_history()), 1)


if __name__ == "__main__":
    unittest.main()
