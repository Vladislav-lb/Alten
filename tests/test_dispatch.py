import unittest
from datetime import datetime, timezone

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))

from dispatch import find_current_slot, should_enable_grid_charging


class DispatchTests(unittest.TestCase):
    def test_enables_grid_charging_for_current_charge_slot(self):
        plan = {
            "slots": [
                {"time": "2026-06-12T09:00:00+00:00", "mode": "idle", "powerKw": 0},
                {"time": "2026-06-12T10:00:00+00:00", "mode": "charge", "powerKw": 5.7},
            ]
        }

        slot = find_current_slot(plan, datetime(2026, 6, 12, 10, 15, tzinfo=timezone.utc))

        self.assertIsNotNone(slot)
        self.assertTrue(should_enable_grid_charging(slot))

    def test_disables_grid_charging_for_discharge_or_idle_slot(self):
        discharge_slot = {"hour": "19-20", "mode": "discharge", "power_kw": 5.7}
        idle_slot = {"hour": "11-12", "mode": "idle", "power_kw": 0}

        self.assertFalse(should_enable_grid_charging(discharge_slot))
        self.assertFalse(should_enable_grid_charging(idle_slot))

    def test_can_match_slot_by_hour_when_time_is_missing(self):
        plan = {"slots": [{"hour": "05-06", "mode": "charge", "power_kw": 1}]}

        slot = find_current_slot(plan, datetime(2026, 6, 12, 5, 30, tzinfo=timezone.utc))

        self.assertEqual(slot["hour"], "05-06")


if __name__ == "__main__":
    unittest.main()
