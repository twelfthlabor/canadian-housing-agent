import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { csvCell, csvDocument, csvRow, parseLimit, GET } from "../app/api/listings/route";
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
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
  });
});

describe("csvRow / csvDocument", () => {
  it("joins cells with commas and applies per-cell quoting", () => {
    expect(csvRow(listing)).toBe(
      'ajax,ON,L1Z,495000,3,2,,2026-09-14,"18 Dexshire Dr, Ajax, ON ""A""",https://www.zillow.com/homedetails/x',
    );
  });

  it("joins the header and rows with CRLF and ends with CRLF", () => {
    const document = csvDocument([listing]);
    expect(document.split("\r\n")).toEqual([
      "city,province,fsa,price,beds,baths,sqft,seen,address,url",
      csvRow(listing),
      "",
    ]);
  });

  it("serves CSV for ?format=csv even when city and limit are set", async () => {
    const response = await GET(new NextRequest("http://localhost/api/listings?format=csv&city=toronto&limit=5"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect((await response.text()).split("\r\n")[0]).toBe("city,province,fsa,price,beds,baths,sqft,seen,address,url");
  });
});
