import unittest
from datetime import date

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))

from price_service import normalize_oree_payload


class PriceServiceTests(unittest.TestCase):
    def test_normalizes_oree_dam_prices_for_selected_day_and_zone(self):
        payload = [
            {
                "zone_eic": "10Y1001C--000182",
                "trade_day": "2026-05-30",
                "data": [
                    {"period": "1", "price": "9000.10"},
                    {"period": "2", "price": "7600,50"},
                ],
            }
        ]

        prices = normalize_oree_payload(payload, date(2026, 5, 30), "10Y1001C--000182")

        self.assertEqual(len(prices), 2)
        self.assertEqual(prices[0]["trade_day"], "2026-05-30")
        self.assertEqual(prices[0]["period"], 1)
        self.assertEqual(prices[0]["price"], 9000.10)
        self.assertEqual(prices[1]["price"], 7600.50)
        self.assertEqual(prices[0]["source"], "oree")


if __name__ == "__main__":
    unittest.main()
