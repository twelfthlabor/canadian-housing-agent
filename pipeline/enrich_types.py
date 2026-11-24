#!/usr/bin/env python3
"""Fill the `type` field of an existing data/listings.json from the scraper's tile cache.

New builds get `type` straight from the scraper CSVs (build_dataset.py). This
backfills a snapshot built before that column was carried, matching listings
to cached Zillow results by the zpid in their source URL. Stdlib only.

    python3 pipeline/enrich_types.py --cache ../property-scraper/cache --data data
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset import normalize_type, write_json  # noqa: E402

ZPID_RE = re.compile(r"/(\d+)_zpid")


def load_types(cache: Path) -> dict[str, str]:
    """zpid -> normalized homeType from every cached tile file that parses."""
    types: dict[str, str] = {}
    for path in sorted(cache.rglob("*.json")):
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(rows, dict):
            rows = rows.get("listings", [])
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("zpid"):
                kind = normalize_type(row.get("type"))
                if kind:
                    types[str(row["zpid"])] = kind
    return types


def enrich(listings: list[dict], types: dict[str, str]) -> int:
    """Set `type` on every row (cache first, then any existing value, else None), right after `url`. Returns rows typed."""
    typed = 0
    for index, row in enumerate(listings):
        match = ZPID_RE.search(row.get("url") or "")
        # A type the build already took from the scraper CSV is kept when the cache has none.
        kind = (types.get(match.group(1)) if match else None) or row.get("type")
        typed += kind is not None
        rebuilt: dict = {}
        for key, value in row.items():
            if key == "type":
                continue
            rebuilt[key] = value
            if key == "url":
                rebuilt["type"] = kind
        rebuilt.setdefault("type", kind)
        listings[index] = rebuilt
    return typed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, default=Path("../property-scraper/cache"))
    parser.add_argument("--data", type=Path, default=Path("data"))
    args = parser.parse_args(argv)
    if not args.cache.is_dir():
        print(f"cache directory not found: {args.cache}", file=sys.stderr)
        return 1
    path = args.data / "listings.json"
    listings = json.loads(path.read_text(encoding="utf-8"))
    typed = enrich(listings, load_types(args.cache))
    write_json(path, listings)
    print(f"typed {typed} of {len(listings)} listings ({100 * typed / max(len(listings), 1):.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
