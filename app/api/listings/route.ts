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

  const city = params.get("city") ?? "";
  const limit = parseLimit(params.get("limit"));
  const sort = params.get("sort") === "discount" ? "discount" : "price";
  const minDiscount = parseMinDiscount(params.get("minDiscount"));
  const cityRows = listings.filter(row => row.city === city);

  const matches = sort === "discount"
    ? cityRows
        .filter(
          row =>
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
        )
    : cityRows.sort((a, b) => a.price - b.price);

  const page = matches.slice(0, limit);

  return NextResponse.json(
    { total: matches.length, returned: page.length, listings: page },
    { headers: { "cache-control": CACHE_CONTROL } },
  );
}
