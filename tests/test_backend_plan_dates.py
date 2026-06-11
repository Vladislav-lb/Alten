import unittest
import importlib.util
from datetime import datetime, timezone

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))


class BackendPlanDateTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("fastapi"), "FastAPI dependency is not installed in this test runtime")
    def test_build_plan_preserves_price_slot_dates(self):
        from app import BatteryModel, build_plan

        selected_day = "2026-05-30"
        prices = [
            {
                "time": datetime(2026, 5, 30, index, tzinfo=timezone.utc).isoformat(),
                "period": index + 1,
                "price": 1000 + index,
            }
            for index in range(24)
        ]

        plan = build_plan(
            prices=prices,
            battery=BatteryModel(capacity_kwh=16, max_charge_kw=5, max_discharge_kw=5),
            min_margin=0,
            reserve_soc_percent=10,
            cycle_cost_per_mwh=0,
        )

        self.assertEqual(len(plan["slots"]), 24)
        self.assertTrue(plan["slots"][0]["time"].startswith(selected_day))
        self.assertTrue(plan["slots"][-1]["time"].startswith(selected_day))


if __name__ == "__main__":
    unittest.main()
