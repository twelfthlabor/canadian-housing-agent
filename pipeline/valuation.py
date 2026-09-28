#!/usr/bin/env python3
"""Deterministic asking-price valuation for listings ("hmb-v1").

Hierarchical median-residual (HMB) model over y = ln(price):

  1. start every row at the global median of y;
  2. one pass of shrunk grouped median residual shifts in fixed order
     (province, province x bed, city, city x bed, city x bath,
     city x bed x bath, city x fsa, city x fsa x bed, city x fsa x bed x bath),
     where a group of n >= MIN_CELL rows shifts its members by
     w * median(y - p) with w = n / (n + SHRINK_K);
  3. per-city log-log sqft slope, only in cities with enough sqft samples and
     coverage (coverage is not missing-at-random, so low-coverage cities get no
     sqft adjustment at all), slope clipped to SQFT_SLOPE_CLIP.

Published estimates are out-of-fold (5 folds) predictions plus one median bias
correction; in-sample fits are never published. Rows in cities with fewer than
MIN_CITY_ROWS rows get null estimates. Rows are never mutated: callers receive
an aligned list of (estValue, discountPct) pairs plus a metadata block for
market_summary.json.

Determinism: no RNG, no clock, no built-in hash(); fold assignment uses
zlib.crc32 over the near-identical/relisted listing key so it is stable across
runs and platforms. Published (estValue, discountPct) pairs and a metadata
block carry every estimated city's OOF MdAPE, not just the top cities.
Standard library only.
"""

from __future__ import annotations

import math
import zlib

METHOD = "hmb-v1"

SHRINK_K = 10
MIN_CELL = 5
MIN_CITY_ROWS = 30
FOLDS = 5
SQFT_MIN_SAMPLES = 50
SQFT_MIN_COVERAGE = 0.4
SQFT_SLOPE_CLIP = (0.0, 1.5)
MAX_DISCOUNT_PCT = 60
BASE_MIN_DISCOUNT_PCT = 15
DEAL_MIN_PRICE = 100_000
COVERAGE_MIN = 0.95
COVERAGE_GATE_MIN_ROWS = 1000

# Fold key: near-identical/relisted listing key (city, province, fsa, beds,
# baths, sqft), never address/url/price, so listings that could be the same
# property (relistings with a changed price/address/url included) cannot leak
# across folds. This key is finer than the model's finest correction cell
# (city x fsa x bed bucket x bath bucket): rows that merely share a model cell
# may land in different folds -- which mirrors serving, where a new listing is
# estimated from all other listings in its cell. Within-cell shared signal
# remains, so the reported OOF MdAPE is a lower bound on the error for a
# genuinely new property.
FOLD_FIELDS = ("city", "province", "fsa", "beds", "baths", "sqft")

# "bed"/"bath" are virtual fields resolved to the bucketed value.
LEVELS = (
    ("province",),
    ("province", "bed"),
    ("city",),
    ("city", "bed"),
    ("city", "bath"),
    ("city", "bed", "bath"),
    ("city", "fsa"),
    ("city", "fsa", "bed"),
    ("city", "fsa", "bed", "bath"),
)


def round_half_up(value: float, digits: int) -> float:
    factor = 10**digits
    return math.floor(value * factor + 0.5) / factor


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def fold_index(row: dict) -> int:
    """Stable 0..FOLDS-1 fold via crc32 over the near-identical/relisted key.

    Listings that could be the same property (including relistings with a
    changed price/address/url) hash to the same fold and cannot score each
    other's model. The key is finer than the model's finest correction cell,
    so rows that merely share a cell may land in different folds; the
    remaining within-cell shared signal makes the reported OOF MdAPE a lower
    bound on the error for a genuinely new property.
    """
    raw = "|".join(str(row.get(field, "")) for field in FOLD_FIELDS)
    return zlib.crc32(raw.encode("utf-8")) % FOLDS


def _bucket(value, cap: int) -> int | None:
    if value is None:
        return None
    return min(int(value), cap)


def _level_key(row: dict, fields: tuple[str, ...]) -> tuple | None:
    """Group key for a level, or None when the row misses one of the fields."""
    key = []
    for field in fields:
        if field == "bed":
            value = _bucket(row.get("beds"), 5)
        elif field == "bath":
            value = _bucket(row.get("baths"), 4)
        else:
            value = row.get(field)
        if value is None:
            return None
        key.append(value)
    return tuple(key)


def _row_sqft(row: dict) -> float | None:
    sqft = row.get("sqft")
    if sqft is None or sqft <= 0:
        return None
    return float(sqft)


def fit(rows: list[dict]) -> tuple[dict, list[float]]:
    """Fit the HMB model on rows.

    Returns (model, fitted) where fitted holds one fitted log price per row.
    The model dict is {"base": float, "levels": [(fields, {key: shift})],
    "sqft": {city: (slope, median_ln_sqft)}} and is applied by predict().
    """
    count = len(rows)
    if count == 0:
        return {"base": 0.0, "levels": [], "sqft": {}}, []

    ys = [math.log(float(row["price"])) for row in rows]
    base = _median(ys)
    fitted = [base] * count

    levels = []
    for fields in LEVELS:
        groups: dict[tuple, list[int]] = {}
        for index, row in enumerate(rows):
            key = _level_key(row, fields)
            if key is not None:
                groups.setdefault(key, []).append(index)
        shifts: dict[tuple, float] = {}
        for key, members in groups.items():
            if len(members) < MIN_CELL:
                continue
            # Groups within a level are disjoint, so in-place updates are safe.
            shift = _median([ys[i] - fitted[i] for i in members])
            weight = len(members) / (len(members) + SHRINK_K)
            shifts[key] = weight * shift
            for i in members:
                fitted[i] += weight * shift
        levels.append((fields, shifts))

    by_city: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        by_city.setdefault(row["city"], []).append(index)

    sqft: dict[str, tuple[float, float]] = {}
    for city, members in by_city.items():
        sample = [i for i in members if _row_sqft(rows[i]) is not None]
        if len(sample) < SQFT_MIN_SAMPLES:
            continue
        if len(sample) / len(members) < SQFT_MIN_COVERAGE:
            continue
        xs = [math.log(_row_sqft(rows[i])) for i in sample]
        mean_x = sum(xs) / len(xs)
        variance = sum((x - mean_x) ** 2 for x in xs) / len(xs)
        if variance <= 0.0:
            continue
        residuals = [ys[i] - fitted[i] for i in sample]
        mean_r = sum(residuals) / len(residuals)
        covariance = sum((x - mean_x) * (r - mean_r) for x, r in zip(xs, residuals)) / len(xs)
        slope = min(max(covariance / variance, SQFT_SLOPE_CLIP[0]), SQFT_SLOPE_CLIP[1])
        median_x = _median(xs)
        for i, x in zip(sample, xs):
            fitted[i] += slope * (x - median_x)
        sqft[city] = (slope, median_x)

    return {"base": base, "levels": levels, "sqft": sqft}, fitted


def predict(model: dict, rows: list[dict]) -> list[float]:
    """Apply a fitted model to rows; level shifts and the sqft slope are additive."""
    predicted = []
    for row in rows:
        value = model["base"]
        for fields, shifts in model["levels"]:
            key = _level_key(row, fields)
            if key is not None:
                value += shifts.get(key, 0.0)
        sqft_params = model["sqft"].get(row.get("city"))
        sqft = _row_sqft(row)
        if sqft_params is not None and sqft is not None:
            slope, median_x = sqft_params
            value += slope * (math.log(sqft) - median_x)
        predicted.append(value)
    return predicted


def _round1(value: float | None) -> float | None:
    if value is None:
        return None
    return _clean(round_half_up(value, 1))


def _clean(value: float) -> float | int:
    """Keep JSON clean: integral floats become ints."""
    if value.is_integer():
        return int(value)
    return value


def estimate_listings(rows: list[dict]) -> tuple[list[tuple[int | None, float | None]], dict, list[tuple[str, float]]]:
    """Value rows with the OOF-published hmb-v1 model.

    Returns (estimates, meta, worst_cities):
      estimates    aligned (estValue, discountPct); both None for small cities
      meta         the "valuation" block embedded in market_summary.json
      worst_cities the 5 highest per-city MdAPEs, worst first
    """
    total = len(rows)

    def build_meta(min_discount: int, coverage: float, mdape, bias_pct, top, by_city, cities: int) -> dict:
        return {
            "method": METHOD,
            "params": {
                "shrink_k": SHRINK_K,
                "min_cell": MIN_CELL,
                "min_city_rows": MIN_CITY_ROWS,
                "folds": FOLDS,
                "sqft_min_samples": SQFT_MIN_SAMPLES,
                "sqft_min_coverage": SQFT_MIN_COVERAGE,
                "min_discount_pct": min_discount,
                "max_discount_pct": MAX_DISCOUNT_PCT,
                "deal_min_price": DEAL_MIN_PRICE,
            },
            "coverage_pct": _clean(round_half_up(coverage, 1)),
            "oof_mdape_pct": _round1(mdape),
            "oof_bias_pct": _round1(bias_pct),
            "oof_mdape_pct_top_cities": {city: _clean(value) for city, value in top.items()},
            "oof_mdape_pct_by_city": {city: _clean(value) for city, value in by_city.items()},
            "cities_estimated": cities,
        }

    if total == 0:
        return [], build_meta(BASE_MIN_DISCOUNT_PCT, 0.0, None, None, {}, {}, 0), []

    # Out-of-fold predictions only: never publish an in-sample fit.
    folds = [fold_index(row) for row in rows]
    p_oof = [0.0] * total
    for fold in range(FOLDS):
        test = [i for i in range(total) if folds[i] == fold]
        if not test:
            continue
        train = [row for i, row in enumerate(rows) if folds[i] != fold]
        model, _ = fit(train)
        for i, value in zip(test, predict(model, [rows[i] for i in test])):
            p_oof[i] = value

    ys = [math.log(float(row["price"])) for row in rows]
    city_counts: dict[str, int] = {}
    for row in rows:
        city_counts[row["city"]] = city_counts.get(row["city"], 0) + 1
    eligible = [i for i in range(total) if city_counts[rows[i]["city"]] >= MIN_CITY_ROWS]
    bias = _median([ys[i] - p_oof[i] for i in eligible])
    if bias is None:
        bias = 0.0

    estimates: list[tuple[int | None, float | None]] = []
    eligible_set = set(eligible)
    for i, row in enumerate(rows):
        if i not in eligible_set:
            estimates.append((None, None))
            continue
        value = math.exp(p_oof[i] + bias)
        if not math.isfinite(value) or value <= 0:
            raise RuntimeError(f"non-finite valuation for row {i}")
        est_value = int(round_half_up(value / 1000.0, 0)) * 1000
        if est_value <= 0:
            raise RuntimeError(f"non-positive estimate for row {i}")
        discount = round_half_up(100.0 * (est_value - row["price"]) / est_value, 1)
        estimates.append((est_value, discount))

    # Guard: estimates must vary within at least one city (not a constant model).
    if eligible:
        city_estimates: dict[str, set[int]] = {}
        for i in eligible:
            city_estimates.setdefault(rows[i]["city"], set()).add(estimates[i][0])
        if not any(len(values) > 1 for values in city_estimates.values()):
            raise RuntimeError("valuation produced constant per-city estimates")

    ape: list[float] = []
    signed: list[float] = []
    per_city: dict[str, list[float]] = {}
    for i in eligible:
        est_value = estimates[i][0]
        error = 100.0 * (rows[i]["price"] - est_value) / est_value
        ape.append(abs(error))
        signed.append(error)
        per_city.setdefault(rows[i]["city"], []).append(abs(error))

    mdape = _median(ape)
    bias_pct = _median(signed)
    city_mdape = {city: _round1(_median(values)) for city, values in per_city.items()}

    coverage = 100.0 * len(eligible) / total
    if total >= COVERAGE_GATE_MIN_ROWS and coverage < COVERAGE_MIN * 100.0:
        raise RuntimeError(
            f"valuation coverage {coverage:.1f}% is below the {COVERAGE_MIN * 100:.0f}% gate"
        )

    if mdape is None:
        min_discount = BASE_MIN_DISCOUNT_PCT
    else:
        min_discount = min(
            max(BASE_MIN_DISCOUNT_PCT, math.ceil(mdape / 5.0) * 5),
            MAX_DISCOUNT_PCT,
        )
        assert min_discount >= mdape, (
            f"min_discount_pct {min_discount} below oof MdAPE {mdape:.1f}"
        )

    by_count = sorted(city_mdape, key=lambda city: (-len(per_city[city]), city))
    top_cities = {city: city_mdape[city] for city in by_count[:15]}
    worst_cities = sorted(
        ((city, city_mdape[city]) for city in city_mdape),
        key=lambda pair: (-pair[1], pair[0]),
    )[:5]

    meta = build_meta(min_discount, coverage, mdape, bias_pct, top_cities, city_mdape, len(city_mdape))
    return estimates, meta, worst_cities
