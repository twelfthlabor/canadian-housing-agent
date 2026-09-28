#!/usr/bin/env python3
"""Tests for pipeline/valuation.py (stdlib unittest, deterministic synthetics)."""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = str(ROOT / "pipeline")
if PIPELINE not in sys.path:
    sys.path.insert(0, PIPELINE)

import valuation as V  # noqa: E402

META_KEYS = {
    "method",
    "params",
    "coverage_pct",
    "oof_mdape_pct",
    "oof_bias_pct",
    "oof_mdape_pct_top_cities",
    "oof_mdape_pct_by_city",
    "cities_estimated",
}
PARAM_KEYS = {
    "shrink_k",
    "min_cell",
    "min_city_rows",
    "folds",
    "sqft_min_samples",
    "sqft_min_coverage",
    "min_discount_pct",
    "max_discount_pct",
    "deal_min_price",
}


def make_row(city, price, beds=3, baths=2, sqft=None, fsa=None, province="ON", index=0):
    return {
        "city": city,
        "province": province,
        "fsa": fsa,
        "price": price,
        "beds": beds,
        "baths": baths,
        "sqft": sqft,
        "seen": "2026-01-01",
        "address": f"{index} Main St, {city}, {province}",
        "url": f"https://example.com/{city}/{index}",
    }


def city_rows(city, count, base=500_000, step=5_000, **kwargs):
    return [make_row(city, base + (i % 7) * step, index=i, **kwargs) for i in range(count)]


def varied_rows(city, count, base=300_000):
    """Rows whose bed/bath mix keeps predicted estimates spread within one city."""
    rows = []
    for i in range(count):
        beds = 2 + (i % 3)
        baths = 1 + (i % 2)
        price = base + beds * 90_000 + (i % 5) * 3_000
        rows.append(make_row(city, price, beds=beds, baths=baths, index=i))
    return rows


class SchemaAndEligibility(unittest.TestCase):
    def test_estimates_schema_and_discount_consistency(self):
        rows = varied_rows("alpha", 40) + city_rows("beta", 5)
        estimates, meta, _worst = V.estimate_listings(rows)

        self.assertEqual(len(estimates), len(rows))
        self.assertEqual(meta["cities_estimated"], 1)
        self.assertEqual(meta["coverage_pct"], round(100 * 40 / 45, 1))

        enriched = []
        for row, (est_value, discount_pct) in zip(rows, estimates):
            if row["city"] == "beta":
                self.assertIsNone(est_value)
                self.assertIsNone(discount_pct)
            else:
                self.assertIsInstance(est_value, int)
                self.assertGreater(est_value, 0)
                self.assertEqual(est_value % 1000, 0)
                expected = V.round_half_up(100 * (est_value - row["price"]) / est_value, 1)
                self.assertEqual(discount_pct, expected)
            # Null / non-null are always a pair.
            self.assertEqual(est_value is None, discount_pct is None)
            enriched.append({**row, "estValue": est_value, "discountPct": discount_pct})

        self.assertEqual(len(enriched[0]), 12)
        self.assertEqual(
            set(enriched[0]),
            {
                "city", "province", "fsa", "price", "beds", "baths", "sqft", "seen",
                "address", "url", "estValue", "discountPct",
            },
        )

    def test_small_city_is_null(self):
        rows = city_rows("tiny", 12)
        estimates, meta, _worst = V.estimate_listings(rows)
        self.assertEqual(estimates, [(None, None)] * 12)
        self.assertEqual(meta["coverage_pct"], 0)
        self.assertEqual(meta["cities_estimated"], 0)
        self.assertIsNone(meta["oof_mdape_pct"])
        self.assertIsNone(meta["oof_bias_pct"])


class Shrinkage(unittest.TestCase):
    def test_cell_shift_is_shrunk_from_raw_median_deviation(self):
        rows = city_rows("a", 40, base=500_000, step=0) + city_rows("b", 10, base=1_000_000, step=0)
        model, _fitted = V.fit(rows)
        city_shifts = dict(model["levels"][2][1])
        raw = math.log(1_000_000) - math.log(500_000)
        shift = city_shifts[("b",)]
        self.assertGreater(shift, 0)
        self.assertLess(shift, raw)
        self.assertAlmostEqual(shift / raw, 10 / (10 + V.SHRINK_K), places=9)
        self.assertEqual(city_shifts[("a",)], 0.0)


class SqftGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dense = [
            make_row("dense", 200_000 + (i * 30) * 250, sqft=800 + i * 30, index=i)
            for i in range(60)
        ]
        thin = [make_row("thin", 400_000 + i * 100, sqft=1200 + i, index=i) for i in range(30)]
        sparse = []
        for i in range(160):
            sqft = 1000 + i * 4 if i < 55 else None
            sparse.append(make_row("sparse", 400_000 + i * 100, sqft=sqft, index=i))
        cls.model, _ = V.fit(dense + thin + sparse)

    def test_low_coverage_city_gets_no_adjustment(self):
        self.assertNotIn("sparse", self.model["sqft"])  # 55/160 = 34% coverage
        self.assertNotIn("thin", self.model["sqft"])  # 30 samples < SQFT_MIN_SAMPLES

    def test_eligible_city_slope_within_clip(self):
        self.assertIn("dense", self.model["sqft"])
        slope, median_x = self.model["sqft"]["dense"]
        self.assertGreater(slope, 0)
        self.assertGreaterEqual(slope, V.SQFT_SLOPE_CLIP[0])
        self.assertLessEqual(slope, V.SQFT_SLOPE_CLIP[1])
        self.assertGreater(median_x, 0)


class MetricsAndDeterminism(unittest.TestCase):
    def test_oof_metric_keys_and_finiteness(self):
        rows = varied_rows("metro", 60) + varied_rows("bigtown", 35) + city_rows("smalltown", 3)
        estimates, meta, worst = V.estimate_listings(rows)

        self.assertEqual(set(meta), META_KEYS)
        self.assertEqual(set(meta["params"]), PARAM_KEYS)
        self.assertEqual(meta["method"], "hmb-v1")
        estimated = {"metro", "bigtown"}
        self.assertEqual(set(meta["oof_mdape_pct_by_city"]), estimated)
        self.assertEqual(set(meta["oof_mdape_pct_top_cities"]), estimated)
        for city in estimated:
            self.assertEqual(
                meta["oof_mdape_pct_by_city"][city],
                meta["oof_mdape_pct_top_cities"][city],
            )
        self.assertEqual(meta["cities_estimated"], 2)
        for value in (meta["coverage_pct"], meta["oof_mdape_pct"], meta["oof_bias_pct"]):
            self.assertTrue(math.isfinite(value))
        self.assertGreaterEqual(meta["oof_mdape_pct"], 0)
        self.assertLessEqual(abs(meta["oof_bias_pct"]), meta["oof_mdape_pct"] + 1e-9)
        self.assertTrue(all(isinstance(est, int) for est, _ in estimates if est is not None))
        # Calibrated threshold: multiple of 5, >= MdAPE, within the cap.
        self.assertEqual(meta["params"]["min_discount_pct"] % 5, 0)
        self.assertGreaterEqual(meta["params"]["min_discount_pct"], meta["oof_mdape_pct"])
        self.assertGreaterEqual(meta["params"]["min_discount_pct"], V.BASE_MIN_DISCOUNT_PCT)
        self.assertLessEqual(meta["params"]["min_discount_pct"], V.MAX_DISCOUNT_PCT)
        self.assertEqual(len(worst), 2)

    def test_fold_key_is_property_identity_not_listing_identity(self):
        self.assertEqual(V.FOLD_FIELDS, ("city", "province", "fsa", "beds", "baths", "sqft"))
        row = make_row("x", 500_000, index=0)
        relisted = dict(
            row,
            price=777_000,
            address="999 Other Rd, x, ON",
            url="https://example.com/x/relisted",
            seen="2026-02-02",
        )
        self.assertEqual(V.fold_index(row), V.fold_index(relisted))
        self.assertIn(V.fold_index(row), range(V.FOLDS))

    def test_deterministic_across_runs(self):
        rows = varied_rows("metro", 80, base=450_000)
        first = V.estimate_listings(rows)
        second = V.estimate_listings(rows)
        self.assertEqual(first[0], second[0])
        self.assertEqual(
            json.dumps(first[1], sort_keys=True),
            json.dumps(second[1], sort_keys=True),
        )
        self.assertEqual(first[2], second[2])
        self.assertEqual(
            [V.fold_index(row) for row in rows],
            [V.fold_index(dict(row)) for row in rows],
        )


class CoverageGate(unittest.TestCase):
    def test_degenerate_many_small_cities_raises(self):
        rows = []
        for city_index in range(40):
            rows.extend(
                city_rows(f"town{city_index}", 25, base=300_000 + city_index * 1000, step=10_000)
            )
        self.assertEqual(len(rows), 1000)
        with self.assertRaises(RuntimeError):
            V.estimate_listings(rows)

    def test_gate_constants_match_brief(self):
        self.assertEqual(V.COVERAGE_MIN, 0.95)
        self.assertEqual(V.COVERAGE_GATE_MIN_ROWS, 1000)


if __name__ == "__main__":
    unittest.main()
