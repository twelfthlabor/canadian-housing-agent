import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { csvCell, csvDocument, csvRow, parseFilters, parseLimit, parseMinDiscount, queryListings, GET } from "../app/api/listings/route";
import { listings, summary } from "../lib/dataset";
import { DEAL_MIN_PRICE, MAX_DISCOUNT_PCT, defaultMinDiscountPct } from "../lib/tools";
import type { Listing } from "../lib/types";

const listing: Listing = {
  city: "ajax",
  province: "ON",
  fsa: "L1Z",
  price: 495000,
  beds: 3,
  baths: 2,
  sqft: null,
  seen: "2026-09-14",
  address: '18 Dexshire Dr, Ajax, ON "A"',
  url: "https://www.zillow.com/homedetails/x",
  estValue: 500000,
  discountPct: 1.0,
};

describe("parseLimit", () => {
  it("defaults absent, zero, negative and unparsable limits", () => {
    for (const value of [null, "0", "-5", "abc"]) expect(parseLimit(value)).toBe(100);
  });

  it("caps large limits at the 200 maximum", () => {
    expect(parseLimit("250")).toBe(200);
    expect(parseLimit("1000")).toBe(200);
    expect(parseLimit("1e9")).toBe(200);
  });

  it("keeps in-range values and floors fractions", () => {
    expect(parseLimit("100")).toBe(100);
    expect(parseLimit("12.9")).toBe(12);
  });
});

describe("parseMinDiscount", () => {
  it("tracks the valuation metadata default (15 when the block is absent)", () => {
    expect(defaultMinDiscountPct()).toBe(summary.valuation?.params.min_discount_pct ?? 15);
    expect(typeof summary.valuation?.params.min_discount_pct).toBe("number");
    for (const value of [null, "", "abc"]) expect(parseMinDiscount(value)).toBe(defaultMinDiscountPct());
  });

  it("clamps to [0, 60] and keeps in-range fractions", () => {
    expect(parseMinDiscount("-5")).toBe(0);
    expect(parseMinDiscount("0")).toBe(0);
    expect(parseMinDiscount("999")).toBe(MAX_DISCOUNT_PCT);
    expect(parseMinDiscount("60")).toBe(60);
    expect(parseMinDiscount("15.5")).toBe(15.5);
  });
});

describe("csvCell", () => {
  it("leaves plain values unquoted", () => {
    expect(csvCell("toronto")).toBe("toronto");
    expect(csvCell(495000)).toBe("495000");
    expect(csvCell(null)).toBe("");
  });

  it("quotes commas, quotes and line breaks per RFC 4180", () => {
    expect(csvCell("18 Dexshire Dr, Ajax")).toBe('"18 Dexshire Dr, Ajax"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("prefixes formula-looking values with a single quote, then quotes if needed", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(-520.1)).toBe("'-520.1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
  });
});

describe("csvRow / csvDocument", () => {
  it("joins cells with commas and applies per-cell quoting", () => {
    expect(csvRow(listing)).toBe(
      'ajax,ON,L1Z,495000,3,2,,2026-09-14,"18 Dexshire Dr, Ajax, ON ""A""",https://www.zillow.com/homedetails/x,500000,1',
    );
  });

  it("writes null estimates and discounts as empty cells", () => {
    const row = csvRow({ ...listing, estValue: null, discountPct: null });
    expect(row).not.toContain("null");
    expect(row).toMatch(/,,$/);
  });

  it("guards a negative discountPct so the CSV cell is text", () => {
    expect(csvRow({ ...listing, discountPct: -520.1 })).toMatch(/,500000,'-520\.1$/);
  });

  it("joins the header and rows with CRLF and ends with CRLF", () => {
    const document = csvDocument([listing]);
    expect(document.split("\r\n")).toEqual([
      "city,province,fsa,price,beds,baths,sqft,seen,address,url,estValue,discountPct",
      csvRow(listing),
      "",
    ]);
  });

  it("serves CSV for ?format=csv even when city and limit are set", async () => {
    const response = await GET(new NextRequest("http://localhost/api/listings?format=csv&city=toronto&limit=5"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect((await response.text()).split("\r\n")[0]).toBe(
      "city,province,fsa,price,beds,baths,sqft,seen,address,url,estValue,discountPct",
    );
  });
});

/** Independent recomputation of the route's sort=discount rules from the raw dataset. */
function expectedDeals(city: string, minDiscount = defaultMinDiscountPct()): Listing[] {
  return listings
    .filter(
      (row) =>
        row.city === city &&
        row.estValue !== null &&
        row.discountPct !== null &&
        row.price >= DEAL_MIN_PRICE &&
        row.discountPct >= minDiscount &&
        row.discountPct <= MAX_DISCOUNT_PCT,
    )
    .sort(
      (a, b) =>
        Number(b.discountPct) - Number(a.discountPct) ||
        a.price - b.price ||
        (a.address ?? "").localeCompare(b.address ?? ""),
    );
}

const dealCounts = new Map<string, number>();
for (const row of listings) {
  if (row.estValue === null || row.discountPct === null || row.price < DEAL_MIN_PRICE) continue;
  if (row.discountPct < defaultMinDiscountPct() || row.discountPct > MAX_DISCOUNT_PCT) continue;
  dealCounts.set(row.city, (dealCounts.get(row.city) ?? 0) + 1);
}
const dealCity = [...dealCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const nullEstimateCity = [...new Set(listings.map((row) => row.city))].find((city) =>
  listings.some((row) => row.city === city && row.estValue === null),
) as string;

async function getJson(query: string): Promise<{ total: number; returned: number; listings: Listing[] }> {
  const response = await GET(new NextRequest(`http://localhost/api/listings?${query}`));
  expect(response.status).toBe(200);
  return response.json();
}

describe("/api/listings sort=discount", () => {
  it("picks a deterministic data-derived test city", () => {
    expect(dealCounts.get(dealCity)).toBeGreaterThan(0);
    expect(defaultMinDiscountPct()).toBe(summary.valuation?.params.min_discount_pct ?? 15);
  });

  it("sorts by discount descending with deterministic tie-breaks and keeps the JSON shape", async () => {
    const expected = expectedDeals(dealCity);
    expect(expected.length).toBeGreaterThan(0);
    expect(listings.some((row) => row.city === dealCity && (row.discountPct ?? 0) > MAX_DISCOUNT_PCT)).toBe(true);

    const body = await getJson(`city=${dealCity}&sort=discount&limit=25`);
    expect(Object.keys(body).sort()).toEqual(["listings", "nextOffset", "offset", "returned", "total"]);
    expect(body.total).toBe(expected.length);
    expect(body.returned).toBe(Math.min(25, expected.length));
    expect(body.listings).toEqual(expected.slice(0, 25));

    for (const row of body.listings) {
      expect(row.estValue).not.toBeNull();
      expect(row.price).toBeGreaterThanOrEqual(DEAL_MIN_PRICE);
      expect(row.discountPct).toBeGreaterThanOrEqual(defaultMinDiscountPct());
      expect(row.discountPct).toBeLessThanOrEqual(MAX_DISCOUNT_PCT);
      expect(Object.keys(row).sort()).toEqual(Object.keys(expected[0]).sort());
    }
    for (let i = 1; i < body.listings.length; i += 1) {
      const previous = body.listings[i - 1];
      const current = body.listings[i];
      expect(Number(previous.discountPct)).toBeGreaterThanOrEqual(Number(current.discountPct));
      if (previous.discountPct === current.discountPct) {
        expect(previous.price).toBeLessThanOrEqual(current.price);
      }
    }
  });

  it("clamps minDiscount to [0, 60] and never returns estimates above the cap", async () => {
    const zero = await getJson(`city=${dealCity}&sort=discount&minDiscount=0&limit=25`);
    expect(zero.total).toBe(expectedDeals(dealCity, 0).length);
    expect(zero.total).toBeGreaterThanOrEqual((await getJson(`city=${dealCity}&sort=discount&limit=25`)).total);

    const negative = await getJson(`city=${dealCity}&sort=discount&minDiscount=-5&limit=25`);
    expect(negative).toEqual(zero);

    const capped = await getJson(`city=${dealCity}&sort=discount&minDiscount=999&limit=25`);
    expect(capped.total).toBe(expectedDeals(dealCity, MAX_DISCOUNT_PCT).length);
    for (const row of capped.listings) {
      expect(row.discountPct).toBe(MAX_DISCOUNT_PCT);
    }
  });

  it("excludes rows without an estimate and defaults to the metadata threshold", async () => {
    const body = await getJson(`city=${nullEstimateCity}&sort=discount&limit=25`);
    expect(body.total).toBe(expectedDeals(nullEstimateCity).length);
    for (const row of body.listings) {
      expect(row.estValue).not.toBeNull();
      expect(row.discountPct).not.toBeNull();
    }
  });

  it("keeps sort=price (the default) unchanged", async () => {
    const priceSorted = listings.filter((row) => row.city === dealCity).sort((a, b) => a.price - b.price);
    const explicit = await getJson(`city=${dealCity}&sort=price&limit=10`);
    const defaulted = await getJson(`city=${dealCity}&limit=10`);
    expect(explicit).toEqual(defaulted);
    expect(explicit.total).toBe(priceSorted.length);
    expect(explicit.listings).toEqual(priceSorted.slice(0, 10));
  });
});

describe("national listings query", () => {
  const rows: Listing[] = [
    { ...listing, city: "ajax", province: "ON", price: 900_000, beds: 3, seen: "2026-09-10", address: "2 A St", fsa: "L1Z", estValue: 1_000_000, discountPct: 10 },
    { ...listing, city: "calgary", province: "AB", price: 400_000, beds: 2, seen: "2026-09-12", address: "9 Crescent Rd", fsa: "T2A", estValue: 300_000, discountPct: -33 },
    { ...listing, city: "toronto", province: "ON", price: 1_500_000, beds: 4, seen: "2026-09-14", address: "5 Bay St", fsa: "M5J", estValue: 1_200_000, discountPct: 25 },
    { ...listing, city: "toronto", province: "ON", price: 700_000, beds: 2, seen: "2026-09-01", address: "7 Queen St", fsa: "M5V", estValue: null, discountPct: null },
  ];
  const run = (query: string) => queryListings(rows, parseFilters(new URLSearchParams(query)));

  it("searches across all cities when no city is given", () => {
    const result = run("");
    expect(result.total).toBe(4);
    expect(result.listings.map(row => row.price)).toEqual([400_000, 700_000, 900_000, 1_500_000]);
  });

  it("filters by province, price range, beds and FSA", () => {
    expect(run("province=on").total).toBe(3);
    expect(run("minPrice=600000&maxPrice=1000000").total).toBe(2);
    expect(run("beds=2").total).toBe(2);
    expect(run("fsa=m5j").listings[0].address).toBe("5 Bay St");
  });

  it("ignores invalid filter values instead of erroring", () => {
    expect(run("province=ONTARIO").total).toBe(4);
    expect(run("beds=2.5").total).toBe(4);
    expect(run("minPrice=abc").total).toBe(4);
  });

  it("matches free text against address, city and FSA", () => {
    expect(run("q=crescent").total).toBe(1);
    expect(run("q=TORONTO").total).toBe(2);
    expect(run("q=m5v").total).toBe(1);
  });

  it("sorts newest first, high to low, and by discount", () => {
    expect(run("sort=newest").listings[0].seen).toBe("2026-09-14");
    expect(run("sort=price_desc").listings[0].price).toBe(1_500_000);
    const deals = run("sort=discount&minDiscount=5");
    expect(deals.total).toBe(2);
    expect(deals.listings.map(row => row.discountPct)).toEqual([25, 10]);
  });

  it("pages with offset and reports nextOffset through the route", async () => {
    const page = queryListings(rows, parseFilters(new URLSearchParams("limit=2&offset=1")));
    expect(page.total).toBe(4);
    expect(page.listings.map(row => row.price)).toEqual([700_000, 900_000]);

    const response = await GET(new NextRequest("http://localhost/api/listings?limit=2&offset=0&city=toronto"));
    const body = await response.json();
    expect(body.offset).toBe(0);
    expect(body.returned).toBe(body.listings.length);
    expect(body.nextOffset === null || body.nextOffset === body.returned).toBe(true);
  });
});
