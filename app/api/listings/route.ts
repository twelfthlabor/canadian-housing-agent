import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { listings } from "@/lib/dataset";
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

/** RFC 4180 field, with a leading quote so spreadsheet formulas stay text. */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_HEADER = "city,province,fsa,price,beds,baths,sqft,seen,address,url";

export const csvRow = (row: Listing): string =>
  [row.city, row.province, row.fsa, row.price, row.beds, row.baths, row.sqft, row.seen, row.address ?? "", row.url ?? ""]
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
  const matches = listings.filter(row => row.city === city).sort((a, b) => a.price - b.price);
  const page = matches.slice(0, limit);

  return NextResponse.json(
    { total: matches.length, returned: page.length, listings: page },
    { headers: { "cache-control": CACHE_CONTROL } },
  );
}
