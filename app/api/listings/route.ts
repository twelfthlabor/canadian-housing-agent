import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { listings } from "@/lib/dataset";
import { DEAL_MIN_PRICE, MAX_DISCOUNT_PCT, defaultMinDiscountPct } from "@/lib/tools";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

/** Positive integer limits up to MAX_LIMIT; absent, zero, negative or unparsable values get the default. */
export function parseLimit(value: string | null): number {
  const requested = Number(value);
  return requested >= 1 ? Math.min(MAX_LIMIT, Math.floor(requested)) : DEFAULT_LIMIT;
}

/** Deal threshold from the valuation metadata, clamped to [0, MAX_DISCOUNT_PCT]. */
export function parseMinDiscount(value: string | null): number {
  const fallback = Math.min(MAX_DISCOUNT_PCT, Math.max(0, defaultMinDiscountPct()));
  if (value === null || value.trim() === "") return fallback;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(MAX_DISCOUNT_PCT, Math.max(0, requested));
}

/** RFC 4180 field, with a leading quote so spreadsheet formulas stay text. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_HEADER = "city,province,fsa,price,beds,baths,sqft,seen,address,url,estValue,discountPct";

export const csvRow = (row: Listing): string =>
  [
    row.city,
    row.province,
    row.fsa,
    row.price,
    row.beds,
    row.baths,
    row.sqft,
    row.seen,
    row.address ?? "",
    row.url ?? "",
    row.estValue ?? null,
    row.discountPct ?? null,
  ]
    .map(csvCell)
    .join(",");

/** Full document from rows; kept pure so tests can pin the header and CRLF framing. */
export function csvDocument(rows: Listing[]): string {
  return [CSV_HEADER, ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

/** The full sample is ~3 MB of static data: serialize on first CSV request, once per server process. */
let csvCache: string | null = null;

function csvBody(): string {
  return (csvCache ??= csvDocument(listings));
}

export const SORTS = ["price_asc", "price_desc", "newest", "discount"] as const;
export type ListingSort = (typeof SORTS)[number];

export type ListingFilters = {
  city?: string;
  province?: string;
  fsa?: string;
  beds?: number;
  minPrice?: number;
  maxPrice?: number;
  q?: string;
  sort: ListingSort;
  minDiscount: number;
  offset: number;
  limit: number;
};

const finite = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Parses and validates query parameters; unknown or invalid values fall back to defaults. */
export function parseFilters(params: URLSearchParams): ListingFilters {
  const sortParam = params.get("sort");
  const sort: ListingSort = (SORTS as readonly string[]).includes(sortParam ?? "")
    ? (sortParam as ListingSort)
    : "price_asc";
  const offsetValue = finite(params.get("offset"));
  const bedsValue = finite(params.get("beds"));
  const city = (params.get("city") ?? "").trim().toLowerCase();
  const province = (params.get("province") ?? "").trim().toUpperCase();
  const fsa = (params.get("fsa") ?? "").trim().toUpperCase();
  const q = (params.get("q") ?? "").trim().slice(0, 80);
  return {
    city: city || undefined,
    province: /^[A-Z]{2}$/.test(province) ? province : undefined,
    fsa: /^[A-Z]\d[A-Z]$/.test(fsa.slice(0, 3)) ? fsa.slice(0, 3) : undefined,
    beds: bedsValue !== undefined && Number.isInteger(bedsValue) && bedsValue >= 0 && bedsValue <= 12 ? bedsValue : undefined,
    minPrice: finite(params.get("minPrice")),
    maxPrice: finite(params.get("maxPrice")),
    q: q || undefined,
    sort,
    minDiscount: parseMinDiscount(params.get("minDiscount")),
    offset: offsetValue !== undefined && offsetValue >= 0 ? Math.floor(offsetValue) : 0,
    limit: parseLimit(params.get("limit")),
  };
}

/** Pure filter + sort + page over the dataset; the route is a thin wrapper around this. */
export function queryListings(rows: Listing[], filters: ListingFilters): { total: number; listings: Listing[] } {
  const needle = filters.q?.toLowerCase();
  const matching = rows.filter(row => {
    if (filters.city && row.city !== filters.city) return false;
    if (filters.province && row.province !== filters.province) return false;
    if (filters.fsa && row.fsa !== filters.fsa) return false;
    if (filters.beds !== undefined && row.beds !== filters.beds) return false;
    if (filters.minPrice !== undefined && row.price < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && row.price > filters.maxPrice) return false;
    if (needle && !`${row.address ?? ""} ${row.city} ${row.fsa ?? ""}`.toLowerCase().includes(needle)) return false;
    if (filters.sort === "discount") {
      return (
        row.estValue !== null &&
        row.discountPct !== null &&
        row.price >= DEAL_MIN_PRICE &&
        row.discountPct >= filters.minDiscount &&
        row.discountPct <= MAX_DISCOUNT_PCT
      );
    }
    return true;
  });

  const byAddress = (a: Listing, b: Listing) => (a.address ?? "").localeCompare(b.address ?? "");
  const comparators: Record<ListingSort, (a: Listing, b: Listing) => number> = {
    price_asc: (a, b) => a.price - b.price || byAddress(a, b),
    price_desc: (a, b) => b.price - a.price || byAddress(a, b),
    newest: (a, b) => b.seen.localeCompare(a.seen) || a.price - b.price || byAddress(a, b),
    discount: (a, b) => Number(b.discountPct) - Number(a.discountPct) || a.price - b.price || byAddress(a, b),
  };

  const sorted = matching.slice().sort(comparators[filters.sort]);
  return { total: sorted.length, listings: sorted.slice(filters.offset, filters.offset + filters.limit) };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  if (params.get("format") === "csv") {
    return new Response(csvBody(), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="listings.csv"',
        "cache-control": CACHE_CONTROL,
      },
    });
  }

  const filters = parseFilters(params);
  const { total, listings: page } = queryListings(listings, filters);
  const nextOffset = filters.offset + page.length < total ? filters.offset + page.length : null;

  return NextResponse.json(
    { total, returned: page.length, offset: filters.offset, nextOffset, listings: page },
    { headers: { "cache-control": CACHE_CONTROL } },
  );
}
