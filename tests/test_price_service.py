import unittest
from datetime import date
from tempfile import TemporaryDirectory

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))

from price_service import MarketPriceService, PriceDataUnavailable, normalize_oree_history, normalize_oree_payload


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

    def test_normalizes_all_oree_records_for_history_storage(self):
        payload = [
            {
                "zone_eic": "10YUA-WEPS-----0",
                "trade_day": "2026-06-12",
                "data": [{"period": "1", "price": "100.00"}],
            },
            {
                "zone_eic": "10Y1001C--000182",
                "trade_day": "2026-06-12",
                "data": [{"period": "1", "price": "200.00"}],
            },
        ]

        history = normalize_oree_history(payload)

        self.assertEqual(len(history), 2)
        self.assertEqual(history[0][0].isoformat(), "2026-06-12")
        self.assertEqual(history[0][1], "10YUA-WEPS-----0")
        self.assertEqual(history[1][1], "10Y1001C--000182")
        self.assertEqual(history[1][2][0]["price"], 200.0)

    def test_get_prices_reads_saved_history_for_selected_date(self):
        payload = [
            {
                "zone_eic": "10Y1001C--000182",
                "trade_day": "2026-06-12",
                "data": [{"period": "1", "price": "200.00"}],
            }
        ]

        with TemporaryDirectory() as directory:
            service = MarketPriceService(
                data_dir=Path(directory),
                api_key="test",
                prices_url="https://example.test/api/damprices",
                zone_eic="10Y1001C--000182",
            )
            service.write_payload_history(payload)
            prices = service.read_cache(date(2026, 6, 12), "10Y1001C--000182")

        self.assertEqual(len(prices), 1)
        self.assertEqual(prices[0]["trade_day"], "2026-06-12")
        self.assertEqual(prices[0]["price"], 200.0)

    def test_api_key_mode_does_not_silently_fall_back_when_api_is_unavailable(self):
        class FailingMarketPriceService(MarketPriceService):
            async def fetch_oree_prices(self, trade_day, zone_eic):
                raise RuntimeError("external API unavailable")

        async def run_case():
            with TemporaryDirectory() as directory:
                service = FailingMarketPriceService(
                    data_dir=Path(directory),
                    api_key="test",
                    prices_url="https://example.test/api/damprices",
                    zone_eic="10Y1001C--000182",
                    fallback_prices=list(range(24)),
                )
                return await service.get_prices("2026-05-01")

        import asyncio

        with self.assertRaises(PriceDataUnavailable):
            asyncio.run(run_case())

    def test_explicit_fallback_uses_selected_day_when_api_is_unavailable(self):
        class FailingMarketPriceService(MarketPriceService):
            async def fetch_oree_prices(self, trade_day, zone_eic):
                raise RuntimeError("external API unavailable")

        async def run_case():
            with TemporaryDirectory() as directory:
                service = FailingMarketPriceService(
                    data_dir=Path(directory),
                    api_key="test",
                    prices_url="https://example.test/api/damprices",
                    zone_eic="10Y1001C--000182",
                    allow_fallback=True,
                    fallback_prices=list(range(24)),
                )
                return await service.get_prices("2026-05-01")

        import asyncio

        prices = asyncio.run(run_case())

        self.assertEqual(len(prices), 24)
        self.assertEqual(prices[0]["trade_day"], "2026-05-01")
        self.assertEqual(prices[-1]["trade_day"], "2026-05-01")
        self.assertEqual(prices[0]["source"], "fallback")


if __name__ == "__main__":
    unittest.main()
