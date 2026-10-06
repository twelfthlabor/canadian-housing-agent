import { describe, expect, it } from "vitest";
import {
  citySnapshot,
  compareCities,
  DEAL_MIN_PRICE,
  defaultMinDiscountPct,
  findDeals,
  knownCities,
  MAX_DISCOUNT_PCT,
  rankAreas,
  searchListings,
  TOOL_IMPLS,
  TOOL_SPECS,
} from "../lib/tools";
import { listings, summary } from "../lib/dataset";
import type { AreaRank, Listing, RankMetric } from "../lib/types";

const cities = Object.keys(summary.cities);
const topCity = cities.reduce(
  (best, city) => (summary.cities[city].count > summary.cities[best].count ? city : best),
  cities[0],
);
const topCount = summary.cities[topCity].count;

/** A row has a usable estimate when the pipeline wrote both fields. */
function hasUsableEstimate(row: Listing): boolean {
  return typeof row.estValue === "number" && typeof row.discountPct === "number";
}

const dealDefaultPct = defaultMinDiscountPct();
/** Deterministic, data-derived city with the most rows that clear the default deal rules. */
const dealCity = (() => {
  const counts = new Map<string, number>();
  for (const row of listings) {
    if (!hasUsableEstimate(row) || row.price < DEAL_MIN_PRICE) continue;
    const discount = row.discountPct as number;
    if (discount < dealDefaultPct || discount > MAX_DISCOUNT_PCT) continue;
    counts.set(row.city, (counts.get(row.city) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
})();

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundHalfUp(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.floor(value * factor + 0.5) / factor;
}

type AreaFilters = { minPrice?: number; maxPrice?: number; beds?: number; bathsMin?: number };

/** Independent recomputation of the rank_areas grouping rules from the raw dataset. */
function expectedRankedAreas(city: string, filters: AreaFilters = {}): AreaRank[] {
  const pricesByFsa = new Map<string, number[]>();
  for (const row of listings) {
    if (row.city !== city || row.fsa === null) continue;
    if (filters.minPrice !== undefined && row.price < filters.minPrice) continue;
    if (filters.maxPrice !== undefined && row.price > filters.maxPrice) continue;
    if (filters.beds !== undefined && row.beds !== filters.beds) continue;
    if (filters.bathsMin !== undefined && (row.baths === null || row.baths < filters.bathsMin)) continue;
    const bucket = pricesByFsa.get(row.fsa) ?? [];
    bucket.push(row.price);
    pricesByFsa.set(row.fsa, bucket);
  }
  return [...pricesByFsa.entries()]
    .filter(([, prices]) => prices.length >= 5)
    .map(([fsa, prices]) => ({ fsa, count: prices.length, medianPrice: medianOf(prices) as number }));
}

function sortedAreas(areas: AreaRank[], metric: RankMetric, order: "asc" | "desc"): AreaRank[] {
  const direction = order === "asc" ? 1 : -1;
  return [...areas].sort(
    (a, b) =>
      direction * (metric === "count" ? a.count - b.count : a.medianPrice - b.medianPrice) ||
      a.fsa.localeCompare(b.fsa),
  );
}

describe("knownCities", () => {
  it("returns the sorted, non-empty city list from the dataset", () => {
    const known = knownCities();
    expect(cities.length).toBeGreaterThan(0);
    expect(known).toEqual([...known].sort());
    expect(new Set(known).size).toBe(known.length);
    expect(known.length).toBe(summary.totals.cities);
    expect(known).toContain(topCity);
  });
});

describe("searchListings", () => {
  it("returns an empty result for an unknown city", () => {
    expect(searchListings({ city: "atlantis" })).toEqual({
      totalMatches: 0,
      returned: 0,
      listings: [],
    });
    expect(searchListings({ city: "" }).totalMatches).toBe(0);
  });

  it("matches the city case-insensitively and reports the full totalMatches", () => {
    const upper = searchListings({ city: `${topCity.toUpperCase()} `, limit: 25 });
    expect(upper.totalMatches).toBe(topCount);
    expect(upper.returned).toBe(Math.min(25, topCount));
    expect(upper.listings.length).toBe(upper.returned);
    for (let i = 1; i < upper.listings.length; i += 1) {
      expect(upper.listings[i].price).toBeGreaterThanOrEqual(upper.listings[i - 1].price);
    }
  });

  it("applies inclusive price and exact beds filters", () => {
    const median = summary.cities[topCity].medianPrice;

    const priced = searchListings({
      city: topCity,
      minPrice: median,
      maxPrice: median * 1.5,
      limit: 25,
    });
    const expectedPriced = listings.filter(
      (row) => row.city === topCity && row.price >= median && row.price <= median * 1.5,
    );
    expect(priced.totalMatches).toBe(expectedPriced.length);
    for (const row of priced.listings) {
      expect(row.price).toBeGreaterThanOrEqual(median);
      expect(row.price).toBeLessThanOrEqual(median * 1.5);
    }

    const bedListing = listings.find((row) => row.city === topCity && row.beds !== null);
    expect(bedListing).toBeDefined();
    const bed = bedListing?.beds as number;
    const expectedBeds = listings.filter((row) => row.city === topCity && row.beds === bed);
    const bedResult = searchListings({ city: topCity, beds: bed, limit: 25 });
    expect(bedResult.totalMatches).toBe(expectedBeds.length);
    for (const row of bedResult.listings) {
      expect(row.beds).toBe(bed);
    }
  });

  it("sorts price_desc, clamps limit to 25, and defaults to 5", () => {
    const desc = searchListings({ city: topCity, sort: "price_desc", limit: 3 });
    expect(desc.returned).toBe(Math.min(3, topCount));
    expect(desc.totalMatches).toBe(topCount);
    for (let i = 1; i < desc.listings.length; i += 1) {
      expect(desc.listings[i].price).toBeLessThanOrEqual(desc.listings[i - 1].price);
    }

    expect(searchListings({ city: topCity }).returned).toBe(Math.min(5, topCount));
    expect(searchListings({ city: topCity, limit: 999 }).returned).toBe(Math.min(25, topCount));
    expect(searchListings({ city: topCity, limit: 2 }).totalMatches).toBe(topCount);
  });

  it("returns copies, not references into the dataset", () => {
    const first = searchListings({ city: topCity, limit: 1 }).listings[0];
    const source = listings.find(
      (row) =>
        row.city === topCity && row.price === first.price && row.seen === first.seen && row.fsa === first.fsa,
    );
    expect(source).toBeDefined();
    expect(first).toEqual(source);
    expect(first).not.toBe(source);
  });
});

describe("searchListings fsa filter", () => {
  const sample = listings.find((row) => row.city === topCity && row.fsa !== null);
  const fsa = sample?.fsa as string;
  const expected = listings.filter((row) => row.city === topCity && row.fsa === fsa);

  it("keeps only exact FSA matches, case-insensitively", () => {
    expect(expected.length).toBeGreaterThan(0);
    const lower = searchListings({ city: topCity, fsa: fsa.toLowerCase(), limit: 25 });
    const upper = searchListings({ city: topCity.toUpperCase(), fsa: fsa.toUpperCase(), limit: 25 });
    expect(lower.totalMatches).toBe(expected.length);
    expect(lower).toEqual(upper);
    expect(lower.returned).toBe(Math.min(25, expected.length));
    for (const row of lower.listings) {
      expect(row.fsa).toBe(fsa);
    }
  });

  it("reduces a full postal code to its FSA", () => {
    const spaced = searchListings({ city: topCity, fsa: `${fsa} 1A1`, limit: 25 });
    const compact = searchListings({ city: topCity, fsa: `${fsa}1A1`.toLowerCase(), limit: 25 });
    expect(spaced).toEqual(searchListings({ city: topCity, fsa, limit: 25 }));
    expect(compact).toEqual(spaced);
  });

  it("takes the empty path for a malformed or foreign postal code", () => {
    const empty = { totalMatches: 0, returned: 0, listings: [] };
    expect(searchListings({ city: topCity, fsa: "M6" })).toEqual(empty);
    expect(searchListings({ city: topCity, fsa: "90210" })).toEqual(empty);
  });

  it("composes with the other filters after the city filter", () => {
    const priced = searchListings({ city: topCity, fsa, minPrice: 500_000, limit: 25 });
    expect(priced.totalMatches).toBe(expected.filter((row) => row.price >= 500_000).length);
    for (const row of priced.listings) {
      expect(row.fsa).toBe(fsa);
      expect(row.price).toBeGreaterThanOrEqual(500_000);
    }
  });

  it("returns an empty result for an unknown FSA and excludes rows without an FSA", () => {
    expect(listings.some((row) => row.fsa === "Z9Z")).toBe(false);
    const empty = { totalMatches: 0, returned: 0, listings: [] };
    expect(searchListings({ city: topCity, fsa: "Z9Z" })).toEqual(empty);
    expect(searchListings({ city: "atlantis", fsa })).toEqual(empty);

    const nullFsaCity = cities.find(
      (city) =>
        listings.some((row) => row.city === city && row.fsa === null) &&
        listings.some((row) => row.city === city && row.fsa !== null),
    ) as string;
    const scopedFsa = listings.find((row) => row.city === nullFsaCity && row.fsa !== null)?.fsa as string;
    const scoped = searchListings({ city: nullFsaCity, fsa: scopedFsa, limit: 25 });
    expect(scoped.totalMatches).toBe(
      listings.filter((row) => row.city === nullFsaCity && row.fsa === scopedFsa).length,
    );
    expect(scoped.listings.some((row) => row.fsa === null)).toBe(false);
  });
});

describe("citySnapshot", () => {
  it("returns null for an unknown city", () => {
    expect(citySnapshot("atlantis")).toBeNull();
    expect(citySnapshot("")).toBeNull();
  });

  it("computes stats at runtime that match market_summary.json for every city", () => {
    for (const city of cities) {
      expect(citySnapshot(city)).toEqual({ city, ...summary.cities[city] });
    }
  });

  it("cross-checks the major city against its market_summary entry", () => {
    const major = citySnapshot(topCity.toUpperCase());
    const expected = summary.cities[topCity];
    expect(major).not.toBeNull();
    expect(major?.city).toBe(topCity);
    expect(major?.count).toBe(expected.count);
    expect(major?.medianPrice).toBe(expected.medianPrice);
    expect(major?.q1Price).toBe(expected.q1Price);
    expect(major?.q3Price).toBe(expected.q3Price);
    expect(major?.medianByBeds).toEqual(expected.medianByBeds);
    expect(major?.shareUnder1M).toBe(expected.shareUnder1M);
    expect(major?.medianSqft).toBe(expected.medianSqft);
    expect(major?.updated).toBe(expected.updated);
  });
});

describe("citySnapshot with fsa", () => {
  const sample = listings.find((row) => row.city === topCity && row.fsa !== null);
  const fsa = sample?.fsa as string;
  const scopedRows = listings.filter((row) => row.city === topCity && row.fsa === fsa);

  it("scopes every snapshot field to the FSA rows", () => {
    const snapshot = citySnapshot({ city: topCity, fsa: fsa.toLowerCase() });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.city).toBe(topCity);
    expect(snapshot?.count).toBe(scopedRows.length);
    expect(snapshot?.medianPrice).toBe(medianOf(scopedRows.map((row) => row.price)));
    expect(snapshot?.shareUnder1M).toBeGreaterThanOrEqual(0);
    expect(snapshot?.shareUnder1M).toBeLessThanOrEqual(1);
    expect(snapshot?.updated).toBe(
      scopedRows.reduce((latest, row) => (row.seen > latest ? row.seen : latest), ""),
    );
    const sqfts = scopedRows.filter((row) => row.sqft !== null).map((row) => row.sqft as number);
    expect(snapshot?.medianSqft).toBe(sqfts.length >= 10 ? medianOf(sqfts) : null);
  });

  it("reduces a full postal code to its FSA", () => {
    const expected = citySnapshot({ city: topCity, fsa });
    expect(expected).not.toBeNull();
    expect(citySnapshot({ city: topCity, fsa: `${fsa} 1A1` })).toEqual(expected);
    expect(citySnapshot({ city: topCity, fsa: `${fsa}1A1`.toLowerCase() })).toEqual(expected);
  });

  it("returns null for a malformed or foreign postal code", () => {
    expect(citySnapshot({ city: topCity, fsa: "M6" })).toBeNull();
    expect(citySnapshot({ city: topCity, fsa: "90210" })).toBeNull();
  });

  it("applies the 10-sample medianSqft rule inside the FSA", () => {
    const byFsa = new Map<string, Listing[]>();
    for (const row of listings) {
      if (row.fsa === null) continue;
      const bucket = byFsa.get(row.fsa) ?? [];
      bucket.push(row);
      byFsa.set(row.fsa, bucket);
    }
    const sqftCount = (rows: Listing[]) => rows.filter((row) => row.sqft !== null).length;
    const sparse = [...byFsa.values()].find((rows) => sqftCount(rows) < 10);
    const dense = [...byFsa.values()].find((rows) => sqftCount(rows) >= 10);
    expect(sparse).toBeDefined();
    expect(dense).toBeDefined();
    expect(citySnapshot({ city: sparse?.[0].city as string, fsa: sparse?.[0].fsa as string })?.medianSqft).toBeNull();
    expect(
      typeof citySnapshot({ city: dense?.[0].city as string, fsa: dense?.[0].fsa as string })?.medianSqft,
    ).toBe("number");
  });

  it("follows the not-found pattern for unknown FSAs and keeps city-wide lookups", () => {
    expect(citySnapshot({ city: topCity, fsa: "Z9Z" })).toBeNull();
    expect(citySnapshot({ city: "atlantis", fsa })).toBeNull();
    expect(citySnapshot({ city: topCity })).toEqual(citySnapshot(topCity));
    expect(citySnapshot({ city: topCity, fsa: "" })).toEqual(citySnapshot(topCity));
  });
});

describe("citySnapshot filters", () => {
  const cityRows = listings.filter((row) => row.city === topCity);

  it("computes the whole snapshot over the filtered subset", () => {
    const expected = cityRows.filter((row) => row.beds === 2 && row.price <= 700_000);
    expect(expected.length).toBeGreaterThan(0);

    const snapshot = citySnapshot({ city: topCity, beds: 2, maxPrice: 700_000 });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.city).toBe(topCity);
    expect(snapshot?.count).toBe(expected.length);

    const prices = expected.map((row) => row.price);
    expect(snapshot?.medianPrice).toBe(medianOf(prices));
    expect(snapshot?.shareUnder1M).toBe(
      roundHalfUp(prices.filter((price) => price < 1_000_000).length / expected.length, 3),
    );
    expect(snapshot?.medianByBeds).toEqual({
      "1": null,
      "2": medianOf(prices),
      "3": null,
      "4": null,
      "5+": null,
    });
    const sqfts = expected.filter((row) => row.sqft !== null).map((row) => row.sqft as number);
    expect(snapshot?.medianSqft).toBe(sqfts.length >= 10 ? medianOf(sqfts) : null);
    expect(snapshot?.updated).toBe(expected.reduce((latest, row) => (row.seen > latest ? row.seen : latest), ""));
  });

  it("applies bathsMin together with inclusive price bounds", () => {
    const expected = cityRows.filter(
      (row) => row.price >= 400_000 && row.price <= 900_000 && row.baths !== null && row.baths >= 2,
    );
    expect(expected.length).toBeGreaterThan(0);

    const snapshot = citySnapshot({ city: topCity, minPrice: 400_000, maxPrice: 900_000, bathsMin: 2 });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.count).toBe(expected.length);
    expect(snapshot?.medianPrice).toBe(medianOf(expected.map((row) => row.price)));
  });

  it("returns null when the filters match no listings", () => {
    expect(citySnapshot({ city: topCity, minPrice: 50_000_000 })).toBeNull();
    expect(citySnapshot({ city: topCity, beds: 99 })).toBeNull();
    expect(citySnapshot({ city: topCity, bathsMin: 99 })).toBeNull();
    expect(citySnapshot({ city: topCity, beds: 2, maxPrice: 1 })).toBeNull();
    expect(citySnapshot({ city: "atlantis", beds: 2 })).toBeNull();
  });

  it("composes filters with an fsa scope", () => {
    const byFsa = new Map<string, Listing[]>();
    for (const row of cityRows) {
      if (!row.fsa) continue;
      const bucket = byFsa.get(row.fsa) ?? [];
      bucket.push(row);
      byFsa.set(row.fsa, bucket);
    }
    const [fsa, fsaRows] = [...byFsa.entries()].find(([, bucket]) =>
      bucket.some((row) => row.beds !== null),
    ) as [string, Listing[]];
    const bed = fsaRows.find((row) => row.beds !== null)?.beds as number;
    const expected = fsaRows.filter((row) => row.beds === bed);

    const snapshot = citySnapshot({ city: topCity, fsa, beds: bed });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.count).toBe(expected.length);
    expect(snapshot?.medianPrice).toBe(medianOf(expected.map((row) => row.price)));
  });

  it("keeps the unfiltered path on the cached city snapshot", () => {
    expect(citySnapshot({ city: topCity })).toEqual(citySnapshot(topCity));
    expect(
      citySnapshot({
        city: topCity,
        fsa: "",
        minPrice: undefined,
        maxPrice: undefined,
        beds: undefined,
        bathsMin: undefined,
      }),
    ).toEqual(citySnapshot(topCity));
    expect(citySnapshot({ city: topCity.toUpperCase(), beds: 2, maxPrice: 700_000 })).toEqual(
      citySnapshot({ city: topCity, beds: 2, maxPrice: 700_000 }),
    );
  });
});

describe("city aliases", () => {
  const aliases: Array<[string, string]> = [
    ["St. Catharines", "st-catharines"],
    ["st. catharines", "st-catharines"],
    ["St Catharines", "st-catharines"],
    ["SAULT STE. MARIE", "sault-ste-marie"],
    ["Sault Ste. Marie", "sault-ste-marie"],
    ["Kawartha Lakes", "kawartha-lakes"],
    ["kawartha_lakes", "kawartha-lakes"],
  ];

  it("resolves punctuation and casing aliases to the same snapshot as the slug", () => {
    for (const [alias, slug] of aliases) {
      const snapshot = citySnapshot(alias);
      expect(snapshot).not.toBeNull();
      expect(snapshot).toEqual(citySnapshot(slug));
      expect(snapshot?.city).toBe(slug);
    }
  });

  it("keeps slug lookups working and still returns null for unknown cities", () => {
    expect(citySnapshot("st-catharines")).toEqual(citySnapshot("St. Catharines"));
    expect(citySnapshot("   ")).toBeNull();
    expect(citySnapshot("Nowhere. City")).toBeNull();
    expect(citySnapshot("St. Nowhere")).toBeNull();
  });

  it("applies the same alias normalisation to searchListings and compareCities", () => {
    const viaAlias = searchListings({ city: "St. Catharines", limit: 3 });
    const viaSlug = searchListings({ city: "st-catharines", limit: 3 });
    expect(viaAlias.totalMatches).toBeGreaterThan(0);
    expect(viaAlias).toEqual(viaSlug);
    expect(searchListings({ city: "Nowhere. City" }).totalMatches).toBe(0);
    expect(compareCities(["Sault Ste. Marie"])).toEqual(compareCities(["sault-ste-marie"]));
  });
});

describe("compareCities", () => {
  it("returns snapshots in request order and skips unknown cities", () => {
    const [firstCity, secondCity] = cities;
    const result = compareCities([secondCity, "atlantis", firstCity, secondCity.toUpperCase()]);
    expect(result.map((snapshot) => snapshot.city)).toEqual([secondCity, firstCity, secondCity]);
    expect(result[0]).toEqual(citySnapshot(secondCity));
    expect(compareCities([])).toEqual([]);
  });
});

describe("rankAreas", () => {
  it("returns null for an unknown or empty city", () => {
    expect(rankAreas({ city: "atlantis" })).toBeNull();
    expect(rankAreas({ city: "" })).toBeNull();
    expect(rankAreas({ city: "   " })).toBeNull();
  });

  it("groups by fsa, excludes rows with no fsa, drops areas under 5 listings, and defaults to the 5 cheapest by median", () => {
    const expected = expectedRankedAreas(topCity);
    expect(expected.length).toBeGreaterThan(0);
    const result = rankAreas({ city: topCity });

    expect(result).not.toBeNull();
    expect(result?.city).toBe(topCity);
    expect(result?.metric).toBe("median_price");
    expect(result?.order).toBe("asc");
    expect(result?.considered).toBe(
      listings.filter((row) => row.city === topCity && row.fsa !== null).length,
    );
    expect(result?.totalAreas).toBe(expected.length);
    expect(result?.areas.length).toBe(Math.min(5, expected.length));
    expect(result?.areas).toEqual(sortedAreas(expected, "median_price", "asc").slice(0, 5));
    for (const area of result?.areas ?? []) {
      expect(area.count).toBeGreaterThanOrEqual(5);
    }
    expect(result?.areas.some((area) => area.medianPrice > 0)).toBe(true);
  });

  it("ranks by count descending by default", () => {
    const expected = sortedAreas(expectedRankedAreas(topCity), "count", "desc");
    const result = rankAreas({ city: topCity, metric: "count" });

    expect(result?.metric).toBe("count");
    expect(result?.order).toBe("desc");
    expect(result?.totalAreas).toBe(expected.length);
    expect(result?.areas).toEqual(expected.slice(0, 5));
    for (let i = 1; i < (result?.areas.length ?? 0); i += 1) {
      expect(result?.areas[i].count).toBeLessThanOrEqual(result?.areas[i - 1].count as number);
    }
  });

  it("honours an explicit order for both metrics", () => {
    expect(rankAreas({ city: topCity, metric: "count", order: "asc" })?.areas).toEqual(
      sortedAreas(expectedRankedAreas(topCity), "count", "asc").slice(0, 5),
    );
    expect(rankAreas({ city: topCity, metric: "median_price", order: "desc" })?.areas).toEqual(
      sortedAreas(expectedRankedAreas(topCity), "median_price", "desc").slice(0, 5),
    );
  });

  it("defaults to 5 areas and caps the limit at 10", () => {
    const total = expectedRankedAreas(topCity).length;
    expect(total).toBeGreaterThan(6);
    expect(rankAreas({ city: topCity })?.areas.length).toBe(5);
    expect(rankAreas({ city: topCity, limit: 2 })?.areas.length).toBe(2);
    expect(rankAreas({ city: topCity, limit: 999 })?.areas.length).toBe(10);
    expect(rankAreas({ city: topCity, limit: 0 })?.areas.length).toBe(1);
    expect(rankAreas({ city: topCity, limit: 2 })?.totalAreas).toBe(total);
  });

  it("applies price, bed, and bath filters before grouping", () => {
    const filters = { beds: 2, maxPrice: 700_000, bathsMin: 1 };
    const expected = sortedAreas(expectedRankedAreas(topCity, filters), "median_price", "asc");
    expect(expected.length).toBeGreaterThan(0);

    const result = rankAreas({ city: topCity, ...filters, limit: 10 });
    expect(result?.considered).toBe(
      listings.filter(
        (row) =>
          row.city === topCity &&
          row.fsa !== null &&
          row.beds === 2 &&
          row.price <= 700_000 &&
          row.baths !== null &&
          row.baths >= 1,
      ).length,
    );
    expect(result?.totalAreas).toBe(expected.length);
    expect(result?.areas).toEqual(expected.slice(0, 10));
  });

  it("excludes rows without an fsa from the grouping", () => {
    const nullFsaCity = listings.find((row) => row.fsa === null)?.city as string;
    expect(nullFsaCity).toBeDefined();
    const result = rankAreas({ city: nullFsaCity, limit: 10 });
    expect(result).not.toBeNull();
    expect(result?.considered).toBe(
      listings.filter((row) => row.city === nullFsaCity && row.fsa !== null).length,
    );
    expect(result?.considered).toBeLessThan(listings.filter((row) => row.city === nullFsaCity).length);
    for (const area of result?.areas ?? []) {
      expect(listings.filter((row) => row.city === nullFsaCity && row.fsa === area.fsa)).toHaveLength(area.count);
    }
  });

  it("returns an empty ranking when the filters match nothing", () => {
    expect(rankAreas({ city: topCity, minPrice: 50_000_000 })).toEqual({
      city: topCity,
      metric: "median_price",
      order: "asc",
      considered: 0,
      areas: [],
      totalAreas: 0,
    });
  });

  it("normalises city aliases like the other tools", () => {
    expect(rankAreas({ city: "St. Catharines" })).toEqual(rankAreas({ city: "st-catharines" }));
  });
});

describe("findDeals", () => {
  const hasEstimate = hasUsableEstimate;
  const discountOf = (row: Listing): number => row.discountPct as number;
  const dealDefault = dealDefaultPct;

  const capCity = [...new Set(listings.map((row) => row.city))].find(
    (city) =>
      listings.some((row) => row.city === city && hasEstimate(row) && discountOf(row) > MAX_DISCOUNT_PCT) &&
      listings.some((row) => row.city === city && hasEstimate(row) && discountOf(row) <= MAX_DISCOUNT_PCT),
  ) as string;

  const floorCity = [...new Set(listings.map((row) => row.city))].find((city) =>
    listings.some((row) => row.city === city && hasEstimate(row) && row.price < DEAL_MIN_PRICE),
  ) as string;

  const nullOnlyCity = [...new Set(listings.map((row) => row.city))].find((city) =>
    listings.filter((row) => row.city === city).every((row) => row.estValue === null),
  ) as string;

  type DealFilters = { minPrice?: number; maxPrice?: number; beds?: number };
  function expectedConsidered(city: string, filters: DealFilters = {}): number {
    return listings.filter(
      (row) =>
        row.city === city &&
        hasEstimate(row) &&
        row.price >= DEAL_MIN_PRICE &&
        (filters.minPrice === undefined || row.price >= filters.minPrice) &&
        (filters.maxPrice === undefined || row.price <= filters.maxPrice) &&
        (filters.beds === undefined || row.beds === filters.beds),
    ).length;
  }

  function expectedMatches(city: string, minDiscount: number): Listing[] {
    return listings
      .filter(
        (row) =>
          row.city === city &&
          hasEstimate(row) &&
          row.price >= DEAL_MIN_PRICE &&
          discountOf(row) >= minDiscount &&
          discountOf(row) <= MAX_DISCOUNT_PCT,
      )
      .sort(
        (a, b) =>
          discountOf(b) - discountOf(a) ||
          a.price - b.price ||
          (a.address ?? "").localeCompare(b.address ?? ""),
      );
  }

  it("returns null for an unknown city and a zeroed result for a city without estimates", () => {
    expect(findDeals({ city: "atlantis" })).toBeNull();
    expect(findDeals({ city: "" })).toBeNull();
    expect(findDeals({ city: "   " })).toBeNull();

    expect(nullOnlyCity).toBeDefined();
    const empty = findDeals({ city: nullOnlyCity });
    expect(empty).not.toBeNull();
    expect(empty?.city).toBe(nullOnlyCity);
    expect(empty?.considered).toBe(0);
    expect(empty?.totalMatches).toBe(0);
    expect(empty?.returned).toBe(0);
    expect(empty?.listings).toEqual([]);
  });

  it("defaults minDiscount to the market_summary valuation metadata and clamps to [0, 60]", () => {
    const meta = summary.valuation?.params.min_discount_pct;
    expect(typeof meta).toBe("number");
    expect(defaultMinDiscountPct()).toBe(meta ?? 15);

    expect(findDeals({ city: dealCity })?.minDiscount).toBe(meta);
    expect(findDeals({ city: dealCity, minDiscount: -10 })?.minDiscount).toBe(0);
    expect(findDeals({ city: dealCity, minDiscount: 0 })?.minDiscount).toBe(0);
    expect(findDeals({ city: dealCity, minDiscount: 999 })?.minDiscount).toBe(MAX_DISCOUNT_PCT);
  });

  it("counts considered from usable in-scope rows at or above the deal price floor", () => {
    expect(floorCity).toBeDefined();
    const result = findDeals({ city: floorCity, limit: 25 });
    expect(result).not.toBeNull();
    expect(result?.considered).toBe(expectedConsidered(floorCity));
    expect(result?.considered).toBeLessThan(
      listings.filter((row) => row.city === floorCity && hasEstimate(row)).length,
    );
    expect(result?.totalMatches).toBeLessThanOrEqual(result?.considered as number);

    const scoped = findDeals({ city: dealCity, minPrice: 400_000, maxPrice: 900_000, beds: 3, limit: 25 });
    expect(scoped?.considered).toBe(expectedConsidered(dealCity, { minPrice: 400_000, maxPrice: 900_000, beds: 3 }));
    expect(scoped?.considered).toBeGreaterThan(0);
    for (const row of scoped?.listings ?? []) {
      expect(row.price).toBeGreaterThanOrEqual(400_000);
      expect(row.price).toBeLessThanOrEqual(900_000);
      expect(row.beds).toBe(3);
    }
  });

  it("excludes rows without an estimate, under the price floor, and beyond the 60% cap", () => {
    expect(capCity).toBeDefined();
    const result = findDeals({ city: capCity, minDiscount: 0, limit: 25 });
    expect(result).not.toBeNull();
    expect(result?.totalMatches).toBe(expectedMatches(capCity, 0).length);
    expect(expectedMatches(capCity, 0).length).toBeGreaterThan(0);
    expect(
      listings.some((row) => row.city === capCity && hasEstimate(row) && discountOf(row) > MAX_DISCOUNT_PCT),
    ).toBe(true);
    for (const row of result?.listings ?? []) {
      expect(row.discountPct).toBeGreaterThanOrEqual(0);
      expect(row.discountPct).toBeLessThanOrEqual(MAX_DISCOUNT_PCT);
      expect(row.estValue).not.toBeNull();
      expect(row.price).toBeGreaterThanOrEqual(DEAL_MIN_PRICE);
    }
  });

  it("sorts discount descending then price then address, and returns copies with all 12 fields", () => {
    const expected = expectedMatches(dealCity, dealDefault);
    expect(expected.length).toBeGreaterThan(0);

    const result = findDeals({ city: dealCity, limit: 25 });
    expect(result).not.toBeNull();
    expect(result?.totalMatches).toBe(expected.length);
    expect(result?.returned).toBe(Math.min(25, expected.length));
    expect(result?.listings).toEqual(expected.slice(0, 25));

    for (let i = 1; i < (result?.listings.length ?? 0); i += 1) {
      const previous = result?.listings[i - 1] as Listing;
      const current = result?.listings[i] as Listing;
      expect(discountOf(previous)).toBeGreaterThanOrEqual(discountOf(current));
      if (previous.discountPct === current.discountPct) {
        expect(previous.price).toBeLessThanOrEqual(current.price);
        if (previous.price === current.price) {
          expect((previous.address ?? "").localeCompare(current.address ?? "")).toBeLessThanOrEqual(0);
        }
      }
    }

    const first = result?.listings[0] as Listing;
    const source = listings.find(
      (row) => row.city === dealCity && row.address === first.address && row.url === first.url,
    );
    expect(source).toBeDefined();
    expect(first).toEqual(source);
    expect(first).not.toBe(source);
    expect(Object.keys(first).length).toBe(12);
    expect(Object.keys(first)).toContain("estValue");
    expect(Object.keys(first)).toContain("discountPct");

    expect(findDeals({ city: dealCity, limit: 25 })).toEqual(result);
  });

  it("defaults limit to 5 and clamps it to [1, 25]", () => {
    const full = findDeals({ city: dealCity, limit: 999 });
    expect(full?.returned).toBe(Math.min(25, full?.totalMatches as number));
    expect(findDeals({ city: dealCity })?.returned).toBe(Math.min(5, full?.totalMatches as number));
    expect(findDeals({ city: dealCity, limit: 0 })?.returned).toBe(1);
  });

  it("normalises city aliases like the other tools", () => {
    expect(findDeals({ city: "St. Catharines" })).toEqual(findDeals({ city: "st-catharines" }));
  });
});

describe("province filter", () => {
  const topProvince = listings.find((row) => row.city === topCity)?.province as string;

  it("keeps the full result when the province matches the city", () => {
    expect(searchListings({ city: topCity, province: topProvince.toLowerCase() }).totalMatches).toBe(topCount);
    expect(citySnapshot({ city: topCity, province: topProvince })).toEqual(citySnapshot(topCity));
  });

  it("returns empty when the province does not match the city", () => {
    expect(searchListings({ city: topCity, province: "NU" })).toEqual({
      totalMatches: 0,
      returned: 0,
      listings: [],
    });
    expect(citySnapshot({ city: topCity, province: "NU" })).toBeNull();
  });

  it("coerces the province argument through the tool implementation", () => {
    expect(TOOL_IMPLS.search_listings({ city: topCity, province: topProvince.toLowerCase() })).toEqual(
      searchListings({ city: topCity, province: topProvince }),
    );
    expect(TOOL_IMPLS.city_snapshot({ city: topCity, province: "nu" })).toBeNull();
  });
});

describe("tool specs and implementations", () => {
  it("exposes the six OpenAI-style specs", () => {
    const names = TOOL_SPECS.map((spec) => spec.function.name);
    expect(names).toEqual([
      "search_listings",
      "city_snapshot",
      "rank_areas",
      "compare_cities",
      "find_deals",
      "search_docs",
    ]);
    for (const spec of TOOL_SPECS) {
      expect(spec.type).toBe("function");
      expect(spec.function.description).toContain("never invent numbers");
      expect(spec.function.parameters.type).toBe("object");
      expect(spec.function.parameters.required.length).toBeGreaterThan(0);
    }
  });

  it("coerces tool-call arguments and delegates to the same functions", () => {
    const viaTool = TOOL_IMPLS.search_listings({
      city: topCity.toUpperCase(),
      minPrice: "1000000",
      maxPrice: "2000000",
      beds: "3",
      limit: "2",
    });
    expect(viaTool).toEqual(
      searchListings({ city: topCity, minPrice: 1_000_000, maxPrice: 2_000_000, beds: 3, limit: 2 }),
    );

    expect(TOOL_IMPLS.city_snapshot({ city: topCity })).toEqual(citySnapshot(topCity));
    expect(TOOL_IMPLS.city_snapshot({ city: "atlantis" })).toBeNull();
    expect(TOOL_IMPLS.compare_cities({ cities: [topCity, "atlantis"] })).toEqual(
      compareCities([topCity, "atlantis"]),
    );

    const fsa = listings.find((row) => row.city === topCity && row.fsa !== null)?.fsa as string;
    expect(
      TOOL_IMPLS.search_listings({ city: topCity.toUpperCase(), fsa: fsa.toLowerCase(), limit: "2" }),
    ).toEqual(searchListings({ city: topCity, fsa, limit: 2 }));
    expect(TOOL_IMPLS.city_snapshot({ city: topCity, fsa: fsa.toLowerCase() })).toEqual(
      citySnapshot({ city: topCity, fsa }),
    );

    expect(
      TOOL_IMPLS.city_snapshot({
        city: topCity.toUpperCase(),
        beds: "2",
        maxPrice: "700000",
        bathsMin: "1",
      }),
    ).toEqual(citySnapshot({ city: topCity, beds: 2, maxPrice: 700_000, bathsMin: 1 }));

    expect(
      TOOL_IMPLS.rank_areas({
        city: topCity.toUpperCase(),
        metric: "count",
        order: "asc",
        beds: "2",
        minPrice: "400000",
        maxPrice: "900000",
        bathsMin: "1",
        limit: "3",
      }),
    ).toEqual(
      rankAreas({
        city: topCity,
        metric: "count",
        order: "asc",
        beds: 2,
        minPrice: 400_000,
        maxPrice: 900_000,
        bathsMin: 1,
        limit: 3,
      }),
    );
    expect(TOOL_IMPLS.rank_areas({ city: "atlantis" })).toBeNull();
    expect(TOOL_IMPLS.rank_areas({ city: topCity, metric: "bogus", order: "bogus", limit: "999" })).toEqual(
      rankAreas({ city: topCity, limit: 999 }),
    );
  });

  it("documents the optional fsa parameter on the listing and snapshot specs", () => {
    for (const name of ["search_listings", "city_snapshot"]) {
      const spec = TOOL_SPECS.find((entry) => entry.function.name === name);
      const properties = spec?.function.parameters.properties as unknown as Record<
        string,
        { description?: string }
      >;
      expect(properties.fsa?.description?.toLowerCase()).toContain("forward sortation area");
      expect(properties.fsa?.description).toContain("full postal code is accepted and reduced to its FSA");
      expect(properties.fsa?.description).toContain("rows without a postal code are excluded");
      expect(spec?.function.parameters.required).toEqual(["city"]);
    }
  });

  it("documents find_deals as a comparable-asking-price estimate, not an appraisal", () => {
    const spec = TOOL_SPECS.find((entry) => entry.function.name === "find_deals");
    const description = spec?.function.description ?? "";
    expect(description).toContain("comparable-listings estimate");
    expect(description).toContain("comparable asking prices");
    expect(description).toContain("not sold prices");
    expect(description).toContain("appraisal");
    expect(description).toContain("noise margin");
    const overallMdape = summary.valuation?.oof_mdape_pct;
    if (typeof overallMdape === "number") expect(description).toContain(`±${Math.round(overallMdape)}%`);
    expect(description).toContain("per-city error is shown in the app");
    expect(description).toContain(`model artefacts and excluded`);
    expect(description).toContain(`[minDiscount, ${MAX_DISCOUNT_PCT}]`);
    expect(description).toContain("Returns null for an unknown city");

    const properties = spec?.function.parameters.properties as unknown as Record<
      string,
      { minimum?: number; maximum?: number; description?: string }
    >;
    expect(properties.minDiscount?.minimum).toBe(0);
    expect(properties.minDiscount?.maximum).toBe(MAX_DISCOUNT_PCT);
    expect(properties.minDiscount?.description).toContain("valuation metadata");
    expect(properties.limit?.maximum).toBe(25);
    expect(properties.beds?.minimum).toBe(1);
    expect(properties.beds?.maximum).toBe(12);
    expect(spec?.function.parameters.required).toEqual(["city"]);

    expect(TOOL_IMPLS.find_deals({ city: dealCity })).toEqual(findDeals({ city: dealCity }));
    expect(TOOL_IMPLS.find_deals({ city: "atlantis" })).toBeNull();
    expect(
      TOOL_IMPLS.find_deals({
        city: dealCity.toUpperCase(),
        minDiscount: "15",
        minPrice: "400000",
        maxPrice: "900000",
        beds: "3",
        limit: "2",
      }),
    ).toEqual(findDeals({ city: dealCity, minDiscount: 15, minPrice: 400_000, maxPrice: 900_000, beds: 3, limit: 2 }));
  });

  it("documents the optional filters on the snapshot and rank_areas specs", () => {
    for (const name of ["city_snapshot", "rank_areas"]) {
      const spec = TOOL_SPECS.find((entry) => entry.function.name === name);
      const properties = spec?.function.parameters.properties as unknown as Record<
        string,
        { description?: string }
      >;
      for (const key of ["minPrice", "maxPrice", "beds", "bathsMin"]) {
        expect(properties[key]?.description).toBeTruthy();
      }
      expect(spec?.function.parameters.required).toEqual(["city"]);
      expect(spec?.function.description).toContain("filters");
    }

    const rank = TOOL_SPECS.find((entry) => entry.function.name === "rank_areas");
    const rankProperties = rank?.function.parameters.properties as unknown as Record<
      string,
      { enum?: string[]; maximum?: number }
    >;
    const rankDescription = rank?.function.description ?? "";
    expect(rankDescription).toContain("postal areas (FSAs)");
    expect(rankDescription).toContain("at least 5 matching listings");
    expect(rankDescription).toContain("bathroom");
    expect(rankDescription).not.toContain("same bedroom, bathroom, and price filters as search_listings");
    expect(rankDescription).toContain('"totalAreas"');
    expect(rankProperties.metric?.enum).toEqual(["median_price", "count"]);
    expect(rankProperties.order?.enum).toEqual(["asc", "desc"]);
    expect(rankProperties.limit?.maximum).toBe(10);

    const search = TOOL_SPECS.find((entry) => entry.function.name === "search_listings");
    expect(search?.function.parameters.properties).not.toHaveProperty("bathsMin");
  });
});
