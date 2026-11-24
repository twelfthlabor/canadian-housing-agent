import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "enrich_types.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("enrich_types", SCRIPT)
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class EnrichTypes(unittest.TestCase):
    def test_backfills_type_by_zpid_and_keeps_field_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache" / "ottawa"
            cache.mkdir(parents=True)
            (cache / "tile.json").write_text(json.dumps([
                {"zpid": "111", "type": "CONDO"},
                {"zpid": "222", "type": "single family"},
                {"zpid": "333"},
            ]), encoding="utf-8")
            (cache / "broken.json").write_text("{not json", encoding="utf-8")
            data = Path(tmp) / "data"
            data.mkdir()
            rows = [
                {"city": "ottawa", "url": "https://www.zillow.com/homedetails/a/111_zpid/", "estValue": 1},
                {"city": "ottawa", "url": "https://www.zillow.com/homedetails/b/222_zpid/", "estValue": 2},
                {"city": "ottawa", "url": "https://www.zillow.com/homedetails/c/333_zpid/", "estValue": 3},
                {"city": "ottawa", "url": "", "estValue": 4},
                {"city": "ottawa", "url": "https://www.zillow.com/homedetails/d/444_zpid/", "type": "TOWNHOUSE", "estValue": 5},
            ]
            (data / "listings.json").write_text(json.dumps(rows), encoding="utf-8")

            self.assertEqual(MODULE.main(["--cache", str(Path(tmp) / "cache"), "--data", str(data)]), 0)
            out = json.loads((data / "listings.json").read_text(encoding="utf-8"))
            self.assertEqual([row["type"] for row in out], ["CONDO", "SINGLE_FAMILY", None, None, "TOWNHOUSE"])
            self.assertEqual(list(out[0]), ["city", "url", "type", "estValue"])

    def test_missing_cache_is_an_error(self):
        self.assertEqual(MODULE.main(["--cache", "does/not/exist", "--data", "data"]), 1)


if __name__ == "__main__":
    unittest.main()
