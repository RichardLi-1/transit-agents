import os
import unittest
from datetime import date
from unittest import mock

import prices

TODAY = date(2026, 11, 7)


class PriceTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": ""}))

    def test_a_million_tokens_each_way(self):
        self.assertEqual(prices.cost("gemini-3.6-flash", 1_000_000, 1_000_000, on=TODAY), 4.5)
        self.assertEqual(prices.cost("gemini-3.5-flash-lite", 1_000_000, 1_000_000, on=TODAY), 2.8)
        self.assertEqual(prices.cost("models/gemini-3.1-pro-preview", 1_000_000, 0, on=TODAY), 2.0)

    def test_cached_input_costs_less_where_the_price_says(self):
        # Half the prompt cached: 0.5 × $0.75 + 0.5 × $0.075, and the output.
        self.assertEqual(prices.cost("gemini-3.6-flash", 1_000_000, 0, cached_tokens=500_000, on=TODAY), 0.4125)
        # No cached price: cached input costs as input.
        self.assertEqual(prices.cost("gemini-4-argon", 1_000_000, 0, cached_tokens=500_000, on=TODAY), 2.0)

    def test_prices_change_on_the_day_google_set(self):
        self.assertEqual(prices.cost("gemini-4-argon", 1_000_000, 1_000_000, on=date(2026, 11, 30)), 12.0)
        self.assertEqual(prices.cost("gemini-4-argon", 1_000_000, 1_000_000, on=date(2026, 12, 1)), 24.0)
        self.assertEqual(prices.cost("gemini-3.8-flash", 1_000_000, 1_000_000, on=date(2027, 1, 1)), 9.0)

    def test_a_small_call(self):
        # 5,600 in and 320 out on Flash: about half a cent.
        self.assertEqual(prices.cost("gemini-3.6-flash", 5_600, 320, on=TODAY), 0.0054)

    def test_a_model_with_no_price(self):
        self.assertIsNone(prices.cost("gemini-nope", 1000, 1000, on=TODAY))

    def test_model_prices_add_or_replace_a_price(self):
        with mock.patch.dict(os.environ, {"MODEL_PRICES": "gemini-nope=1/10, gemini-3.6-flash = 2/20/0.5"}):
            self.assertEqual(prices.cost("gemini-nope", 1_000_000, 100_000, on=TODAY), 2.0)
            self.assertEqual(prices.cost("gemini-3.6-flash", 1_000_000, 0, cached_tokens=1_000_000, on=TODAY), 0.5)

    def test_model_prices_must_be_readable(self):
        for bad in ("gemini-x", "gemini-x=1", "gemini-x=a/b", "=1/2", "gemini-x=1/2/3/4", "gemini-x=-1/2"):
            with self.subTest(bad), mock.patch.dict(os.environ, {"MODEL_PRICES": bad}):
                with self.assertRaisesRegex(ValueError, "MODEL_PRICES: write each as model=input/output"):
                    prices.overrides()


if __name__ == "__main__":
    unittest.main()
