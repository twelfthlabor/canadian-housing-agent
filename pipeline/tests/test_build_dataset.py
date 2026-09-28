#!/usr/bin/env python3
"""Tests for pipeline/build_dataset.py (stdlib unittest, offline)."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "pipeline" / "build_dataset.py"
FIXTURES = ROOT / "pipeline" / "fixtures"
EPOCH = "1700000000"  # fixed so generated_at is reproducible in tests


def load_module():
    spec = importlib.util.spec_from_file_location("build_dataset", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = load_module()


def run_pipeline(out_dir: Path, source: Path = FIXTURES) -> subprocess.CompletedProcess:
    command = [sys.executable, str(SCRIPT), "--source", str(source), "--out", str(out_dir)]
    env = os.environ.copy()
    env["SOURCE_DATE_EPOCH"] = EPOCH
    return subprocess.run(command, capture_output=True, text=True, env=env, check=False)


def report_number(output: str, label: str) -> int:
    match = re.search(rf"{re.escape(label)}: (\d+)", output)
    if match is None:
        raise AssertionError(f"report label not found: {label!r}\n{output}")
    return int(match.group(1))


# Fixture builds are far below MIN_CITY_ROWS, so every published estimate is
# null; the 10 transformed fields still have to match exactly.
EXPECTED_LISTINGS = [dict(row, estValue=None, discountPct=None) for row in [
    {
        "city": "ottawa",
        "province": "ON",
        "fsa": "K1A",
        "price": 650000,
        "beds": 4,
        "baths": 3,
        "sqft": 1700,
        "seen": "2026-09-01",
        "address": "2 Bank St, Ottawa, ON K1A 0B1",
        "url": "https://example.com/o2",
    },
    {
        "city": "ottawa",
        "province": "ON",
        "fsa": "K1A",
        "price": 500000,
        "beds": 3,
        "baths": 2,
        "sqft": 1400,
        "seen": "2026-09-01",
        "address": "1 Wellington St, Ottawa, ON K1A 0A9",
        "url": "https://example.com/o1",
    },
    {
        "city": "ottawa",
        "province": "ON",
        "fsa": "K1P",
        "price": 250000,
        "beds": None,
        "baths": 2,
        "sqft": None,
        "seen": "2026-09-01",
        "address": "4 Sparks St, Ottawa, ON K1P 5A5",
        "url": "https://example.com/o4",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": "M5C",
        "price": 5000000,
        "beds": None,
        "baths": None,
        "sqft": None,
        "seen": "2026-09-04",
        "address": "90 Queen St E, Toronto, ON M5C 1S6",
        "url": "https://example.com/t9",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": "M5X",
        "price": 2000000,
        "beds": 3,
        "baths": 2,
        "sqft": None,
        "seen": "2026-09-04",
        "address": "100 King St W, Toronto, ON M5X 1A9",
        "url": "https://example.com/t10",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": "M4N",
        "price": 1200000,
        "beds": 3,
        "baths": 2,
        "sqft": 1100,
        "seen": "2026-09-02",
        "address": "20 Queen St, Toronto, ON M4N 2G7",
        "url": "https://example.com/t2",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": "M5H",
        "price": 950000,
        "beds": 2,
        "baths": 2,
        "sqft": 850,
        "seen": "2026-09-05",
        "address": "10 King St W, Toronto, ON M5H 1A1",
        "url": "https://example.com/t1",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": "M5V",
        "price": 800000,
        "beds": None,
        "baths": None,
        "sqft": None,
        "seen": "2026-09-03",
        "address": "50 Spadina Ave, Toronto, ON M5V 2K7",
        "url": "https://example.com/t5",
    },
    {
        "city": "toronto",
        "province": "ON",
        "fsa": None,
        "price": 700000,
        "beds": 1,
        "baths": 1,
        "sqft": None,
        "seen": "2026-09-03",
        "address": "70 Bloor St W, Toronto, ON",
        "url": "https://example.com/t7",
    },
    {
        "city": "vancouver",
        "province": "BC",
        "fsa": None,
        "price": 950000,
        "beds": 2,
        "baths": 2,
        "sqft": 850,
        "seen": "2026-09-20",
        "address": "10 King St W, Vancouver, BC M5H 1A1",
        "url": "https://example.com/v2",
    },
    {
        "city": "vancouver",
        "province": "BC",
        "fsa": "V6P",
        "price": 878000,
        "beds": 2,
        "baths": 2,
        "sqft": 846,
        "seen": "2026-09-20",
        "address": "6688 Cambie St, Vancouver, BC V6P 0E6",
        "url": "https://example.com/v1",
    },
]]


class PipelineEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "out"
        cls.proc = run_pipeline(cls.out)
        cls.listings = json.loads((cls.out / "listings.json").read_text(encoding="utf-8"))
        cls.summary = json.loads((cls.out / "market_summary.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_exit_code_and_outputs(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)
        self.assertTrue((self.out / "listings.json").is_file())
        self.assertTrue((self.out / "market_summary.json").is_file())

    def test_filter_report_counts(self):
        out = self.proc.stdout
        self.assertEqual(report_number(out, "rows read"), 20)
        self.assertEqual(report_number(out, "unique listing_ids"), 17)
        self.assertEqual(report_number(out, "kept"), 11)
        self.assertEqual(report_number(out, "malformed rows"), 2)
        self.assertEqual(report_number(out, "duplicate listing_id"), 1)
        self.assertEqual(report_number(out, "non-CA address"), 2)
        self.assertEqual(report_number(out, "price below 50000"), 1)
        self.assertEqual(report_number(out, "unparseable price"), 1)
        self.assertEqual(report_number(out, "invalid beds/baths"), 2)
        self.assertEqual(report_number(out, "implausible sqft (nulled)"), 2)
        self.assertEqual(report_number(out, "fsa/province mismatch (nulled)"), 1)
        self.assertEqual(report_number(out, "cities"), 3)
        self.assertIn("Valuation report", out)
        self.assertIn("min discount: 15%", out)

    def test_listings_sorted_and_transformed(self):
        self.assertEqual(self.listings, EXPECTED_LISTINGS)
        for row in self.listings:
            self.assertEqual(
                set(row),
                {
                    "city", "province", "fsa", "price", "beds", "baths", "sqft", "seen",
                    "address", "url", "estValue", "discountPct",
                },
            )
            self.assertTrue(row["address"])
            self.assertTrue(row["url"])

    def test_valuation_nulls_are_paired(self):
        for row in self.listings:
            self.assertIsNone(row["estValue"])
            self.assertIsNone(row["discountPct"])

    def test_province_comes_from_dir_slug(self):
        by_url = {row["url"]: row for row in self.listings}
        self.assertEqual(by_url["https://example.com/o1"]["province"], "ON")
        self.assertEqual(by_url["https://example.com/t2"]["province"], "ON")
        self.assertEqual(by_url["https://example.com/v1"]["province"], "BC")
        self.assertEqual(by_url["https://example.com/v2"]["province"], "BC")

    def test_fsa_mismatch_nulled_not_dropped(self):
        by_url = {row["url"]: row for row in self.listings}
        # M5H is an Ontario FSA in a BC directory: kept, but the FSA is nulled.
        self.assertIsNone(by_url["https://example.com/v2"]["fsa"])
        self.assertEqual(by_url["https://example.com/v2"]["price"], 950000)
        self.assertEqual(len(self.listings), 11)

    def test_dedupe_keeps_newest_timestamp(self):
        t1 = [row for row in self.listings if row["city"] == "toronto" and row["price"] in (900000, 950000)]
        self.assertEqual([row["price"] for row in t1], [950000])
        self.assertEqual(t1[0]["seen"], "2026-09-05")

    def test_drops(self):
        prices = {row["price"] for row in self.listings}
        self.assertNotIn(1, prices)  # $1 placeholder
        self.assertNotIn(400000, prices)  # invalid baths (15)
        toronto_prices = sorted(row["price"] for row in self.listings if row["city"] == "toronto")
        self.assertEqual(toronto_prices, [700000, 800000, 950000, 1200000, 2000000, 5000000])
        self.assertNotIn(600000, prices)  # malformed short row
        self.assertNotIn("https://example.com/v3", {row["url"] for row in self.listings})  # US spillover
        vancouver_prices = sorted(row["price"] for row in self.listings if row["city"] == "vancouver")
        self.assertEqual(vancouver_prices, [878000, 950000])

    def test_implausible_sqft_nulled_not_dropped(self):
        by_price = {row["price"]: row for row in self.listings}
        self.assertIsNone(by_price[5000000]["sqft"])  # 22 (lot acreage)
        self.assertIsNone(by_price[2000000]["sqft"])  # 25000 (non-residential)
        self.assertEqual(len(self.listings), 11)  # rows survive, only sqft is null

    def test_market_summary(self):
        self.assertEqual(self.summary["source"], "zillow research sample")
        self.assertEqual(self.summary["generated_at"], "2023-11-14T22:13:20Z")
        self.assertEqual(self.summary["totals"], {"rows": 11, "cities": 3, "provinces": 2})

        toronto = self.summary["cities"]["toronto"]
        self.assertEqual(toronto["count"], 6)
        self.assertEqual(toronto["medianPrice"], 1075000)
        self.assertEqual(toronto["q1Price"], 800000)
        self.assertEqual(toronto["q3Price"], 2000000)
        self.assertEqual(toronto["shareUnder1M"], 0.5)
        self.assertIsNone(toronto["medianSqft"])  # only 2 plausible samples
        self.assertEqual(toronto["updated"], "2026-09-05")
        self.assertEqual(
            toronto["medianByBeds"],
            {"1": 700000, "2": 950000, "3": 1600000, "4": None, "5+": None},
        )

        ottawa = self.summary["cities"]["ottawa"]
        self.assertEqual(ottawa["count"], 3)
        self.assertEqual(ottawa["medianPrice"], 500000)
        self.assertEqual(ottawa["q1Price"], 250000)
        self.assertEqual(ottawa["q3Price"], 650000)
        self.assertEqual(ottawa["shareUnder1M"], 1)
        self.assertIsNone(ottawa["medianSqft"])  # only 2 plausible samples
        self.assertEqual(ottawa["updated"], "2026-09-01")
        self.assertEqual(
            ottawa["medianByBeds"],
            {"1": None, "2": None, "3": 500000, "4": 650000, "5+": None},
        )

        vancouver = self.summary["cities"]["vancouver"]
        self.assertEqual(vancouver["count"], 2)
        self.assertEqual(vancouver["medianPrice"], 914000)
        self.assertEqual(vancouver["q1Price"], 878000)
        self.assertEqual(vancouver["q3Price"], 950000)
        self.assertEqual(vancouver["shareUnder1M"], 1)
        self.assertIsNone(vancouver["medianSqft"])  # only 2 plausible samples
        self.assertEqual(vancouver["updated"], "2026-09-20")
        self.assertEqual(
            vancouver["medianByBeds"],
            {"1": None, "2": 914000, "3": None, "4": None, "5+": None},
        )

    def test_valuation_meta_block(self):
        valuation = self.summary["valuation"]
        self.assertEqual(valuation["method"], "hmb-v1")
        self.assertEqual(valuation["coverage_pct"], 0)
        self.assertEqual(valuation["cities_estimated"], 0)
        self.assertIsNone(valuation["oof_mdape_pct"])
        self.assertIsNone(valuation["oof_bias_pct"])
        self.assertEqual(valuation["oof_mdape_pct_top_cities"], {})
        self.assertEqual(valuation["oof_mdape_pct_by_city"], {})
        self.assertEqual(valuation["params"]["min_discount_pct"], 15)
        self.assertEqual(valuation["params"]["max_discount_pct"], 60)
        self.assertEqual(valuation["params"]["deal_min_price"], 100000)
        self.assertEqual(valuation["params"]["folds"], 5)
        self.assertEqual(valuation["params"]["min_city_rows"], 30)

    def test_idempotent_across_runs(self):
        with tempfile.TemporaryDirectory() as other_tmp:
            other = Path(other_tmp) / "out"
            second = run_pipeline(other)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(
                (other / "listings.json").read_bytes(),
                (self.out / "listings.json").read_bytes(),
            )
            self.assertEqual(
                (other / "market_summary.json").read_bytes(),
                (self.out / "market_summary.json").read_bytes(),
            )

    def test_refuses_empty_source_without_clobbering_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "empty-source"
            source.mkdir()
            out = Path(tmp) / "out"
            out.mkdir()
            sentinel = out / "listings.json"
            sentinel.write_text("keep me", encoding="utf-8")
            proc = run_pipeline(out, source=source)
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")


class PureHelpers(unittest.TestCase):
    def test_should_replace(self):
        older = MODULE.parse_timestamp("2026-09-01T00:00:00Z")
        newer = MODULE.parse_timestamp("2026-09-05T00:00:00Z")
        self.assertTrue(MODULE.should_replace(newer, 1, older, 2))
        self.assertFalse(MODULE.should_replace(older, 2, newer, 1))
        # equal timestamps fall back to encounter order
        self.assertTrue(MODULE.should_replace(newer, 2, newer, 1))
        # unparseable timestamps fall back to encounter order
        self.assertTrue(MODULE.should_replace(None, 5, older, 4))
        self.assertFalse(MODULE.should_replace(None, 4, None, 5))

    def test_parse_money(self):
        self.assertEqual(MODULE.parse_money("$1,288,000"), 1288000.0)
        self.assertEqual(MODULE.parse_money("50000"), 50000.0)
        self.assertIsNone(MODULE.parse_money("N/A"))
        self.assertIsNone(MODULE.parse_money(""))

    def test_parse_optional_int(self):
        self.assertEqual(MODULE.parse_optional_int("", 1, 12), (True, None))
        self.assertEqual(MODULE.parse_optional_int("2", 1, 12), (True, 2))
        self.assertEqual(MODULE.parse_optional_int("0", 1, 12), (False, None))
        self.assertEqual(MODULE.parse_optional_int("13", 1, 12), (False, None))
        self.assertEqual(MODULE.parse_optional_int("abc", 1, 12), (False, None))

    def test_extract_fsa(self):
        self.assertEqual(MODULE.extract_fsa("20 Queen St, Toronto, ON M4N 2G7", "ON"), "M4N")
        self.assertEqual(MODULE.extract_fsa("6688 Cambie St, Vancouver, BC V6P 0E6", "BC"), "V6P")
        self.assertIsNone(MODULE.extract_fsa("70 Bloor St W, Toronto, ON", "ON"))
        self.assertIsNone(MODULE.extract_fsa("40 Elm St, Buffalo, NY 14201", "ON"))

    def test_extract_fsa_province_sanity(self):
        # An Ontario FSA in a BC directory is a data error: null, never a drop.
        self.assertIsNone(MODULE.extract_fsa("10 King St W, Vancouver, BC M5H 1A1", "BC"))
        self.assertEqual(MODULE.extract_fsa("10 King St W, Vancouver, BC M5H 1A1", "ON"), "M5H")
        # X covers both northern territories; Y is Yukon-only.
        self.assertEqual(MODULE.extract_fsa("53 Pine Cres, Fort Smith, NT X0E 0P0", "NT"), "X0E")
        self.assertEqual(MODULE.extract_fsa("53 Pine Cres, Fort Smith, NT X0E 0P0", "NU"), "X0E")
        self.assertIsNone(MODULE.extract_fsa("53 Pine Cres, Fort Smith, NT X0E 0P0", "YT"))

    def test_dir_slug_parsing(self):
        self.assertEqual(MODULE.parse_dir_slug("vancouver-bc"), ("vancouver", "BC"))
        self.assertEqual(MODULE.parse_dir_slug("toronto-on"), ("toronto", "ON"))
        self.assertEqual(MODULE.parse_dir_slug("chatham-kent-on"), ("chatham-kent", "ON"))
        self.assertEqual(MODULE.parse_dir_slug("three-rivers-pe"), ("three-rivers", "PE"))
        self.assertEqual(MODULE.city_from_dir("vancouver-bc"), "vancouver")

    def test_duplicate_city_stem_fails_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "regions"
            header = "listing_id,address,price,beds,baths,sqft,agent,url,source_page,scraped_at\n"
            for slug, prov in (("springfield-on", "ON"), ("springfield-bc", "BC")):
                region = source / slug
                region.mkdir(parents=True)
                (region / "listings.csv").write_text(
                    header
                    + f'X1,"1 Main St, Springfield, {prov} A1A 1A1",500000,3,2,1200,Agent,https://example.com/x,1,2026-09-01T00:00:00Z\n',
                    encoding="utf-8",
                )
            out = Path(tmp) / "out"
            with self.assertRaises(RuntimeError):
                MODULE.build(source, out)

    def test_median_and_quartiles(self):
        self.assertEqual(MODULE.median([700000, 800000, 950000, 1200000]), 875000)
        self.assertEqual(MODULE.median([250000, 500000, 650000]), 500000)
        self.assertEqual(
            MODULE.quartiles([700000, 800000, 950000, 1200000]),
            (750000, 1075000),
        )
        self.assertEqual(MODULE.quartiles([250000, 500000, 650000]), (250000, 650000))

    def test_round_half_up_matches_js_math_round(self):
        self.assertEqual(MODULE.round_half_up(0.0625, 3), 0.063)
        self.assertEqual(MODULE.round_half_up(0.75, 3), 0.75)
        self.assertEqual(MODULE.round_half_up(1.0, 3), 1.0)

    def test_seen_date(self):
        self.assertEqual(MODULE.seen_date("2026-09-05T10:00:00Z"), "2026-09-05")
        self.assertEqual(MODULE.seen_date("2026-09-05"), "2026-09-05")
        self.assertEqual(MODULE.seen_date("not-a-date"), "")
        self.assertEqual(MODULE.seen_date(None), "")

    def test_parse_sqft_and_plausibility(self):
        self.assertEqual(MODULE.parse_sqft("1,500"), 1500)
        self.assertEqual(MODULE.parse_sqft("0"), 0)
        self.assertIsNone(MODULE.parse_sqft("N/A"))
        self.assertIsNone(MODULE.parse_sqft(""))
        self.assertFalse(MODULE.is_plausible_sqft(199))
        self.assertTrue(MODULE.is_plausible_sqft(200))
        self.assertTrue(MODULE.is_plausible_sqft(20000))
        self.assertFalse(MODULE.is_plausible_sqft(20001))
        self.assertFalse(MODULE.is_plausible_sqft(0))

    def test_median_sqft_requires_min_samples(self):
        def row(price, sqft):
            return {
                "city": "testville",
                "province": "ON",
                "fsa": None,
                "price": price,
                "beds": 2,
                "baths": 1,
                "sqft": sqft,
                "seen": "2026-09-01",
            }

        nine = [row(500000 + i, 1000 + i) for i in range(9)]
        summary_nine = MODULE.build_summary(nine, "2026-09-01T00:00:00Z")
        self.assertIsNone(summary_nine["cities"]["testville"]["medianSqft"])

        ten = nine + [row(600000, 1500)]
        summary_ten = MODULE.build_summary(ten, "2026-09-01T00:00:00Z")
        self.assertEqual(summary_ten["cities"]["testville"]["medianSqft"], 1004.5)

    def test_default_source_is_relative(self):
        self.assertFalse(MODULE.DEFAULT_SOURCE.is_absolute())
        self.assertNotIn("/Users/", str(MODULE.DEFAULT_SOURCE))
        self.assertEqual(str(MODULE.DEFAULT_SOURCE), "../property-scraper/data/regions")


if __name__ == "__main__":
    unittest.main()
