from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from optimizer.arbitrage import BatteryEnvelope, PriceSlot, optimize_arbitrage


class OptimizerTest(unittest.TestCase):
    def test_optimizer_respects_limits_and_generates_profit(self) -> None:
        prices = [
            9000, 7600, 6877, 6800, 7000, 7222,
            7766.99, 8000, 6700, 5550, 1650, 30,
            10, 10, 10, 44, 643, 1700,
            5957, 9939, 13700, 15000, 15000, 11000,
        ]
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        slots = [PriceSlot(now + timedelta(hours=index), price) for index, price in enumerate(prices)]
        battery = BatteryEnvelope(
            capacity_kwh=215,
            soc=50,
            min_soc=10,
            max_soc=95,
            max_charge_kw=125,
            max_discharge_kw=125,
            roundtrip_efficiency=0.92,
        )

        plan = optimize_arbitrage(slots, battery, min_margin_per_mwh=500)

        self.assertEqual(len(plan), 24)
        self.assertGreater(sum(slot.profit for slot in plan), 0)
        self.assertTrue(all(10 <= slot.soc_end <= 95 for slot in plan))
        self.assertTrue(all(slot.power_kw <= 125 for slot in plan))
        self.assertGreater(sum(slot.mode == "charge" for slot in plan), 0)
        self.assertGreater(sum(slot.mode == "discharge" for slot in plan), 0)
        self.assertTrue(all(slot.price <= 1700 for slot in plan if slot.mode == "charge"))
        self.assertTrue(all(slot.price >= 7766.99 for slot in plan if slot.mode == "discharge"))


if __name__ == "__main__":
    unittest.main()
