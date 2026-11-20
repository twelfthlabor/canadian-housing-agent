import { describe, expect, it } from "vitest";
import { checkGrounding, checkedFigures, isGrounded } from "../lib/grounding";

// Shape of the live find_deals result captured for "Find me deals in Hamilton" (2026-11-20).
const hamiltonDeals = {
  city: "hamilton",
  minDiscount: 20,
  considered: 1804,
  totalMatches: 425,
  returned: 1,
  listings: [
    {
      city: "hamilton",
      province: "ON",
      fsa: "L8E",
      price: 439900,
      beds: 3,
      baths: 2,
      sqft: 1200,
      address: "88 Creanona Blvd, Hamilton, ON L8E 5T2",
      url: "https://www.zillow.com/homedetails/88-Creanona-Blvd-Hamilton-ON-L8E-5T2/1_zpid/",
      estValue: 1097000,
      discountPct: 59.9,
    },
  ],
};

describe("checkGrounding", () => {
  it("accepts the captured Hamilton deals answer, street number and postal code included", () => {
    const answer =
      "Here are listings asking well below the comparable-listings estimate:\n" +
      "- **88 Creanona Blvd**, Hamilton, ON L8E 5T2 – $439,900 (59.9% below estimate) – est. value $1,097,000. " +
      "425 listings qualify out of 1,804 considered.";
    const result = checkGrounding({ answer, toolResults: [hamiltonDeals], messages: ["Find me deals in Hamilton"] });
    expect(result.ungrounded).toEqual([]);
    expect(result.checked).toBeGreaterThanOrEqual(5);
  });

  it("accepts a mortgage answer that repeats the user's own inputs", () => {
    const toolResult = { price: 600000, downPayment: 60000, ratePct: 4.5, monthlyPayment: 2994, cmhcPremium: 16740, stressRatePct: 6.5 };
    const answer =
      "On a $600,000 home with 10% down ($60,000) at 4.5%, the payment is about $2,994 a month including a $16,740 CMHC premium; you would need to qualify at 6.5%.";
    const result = checkGrounding({
      answer,
      toolResults: [toolResult],
      messages: ["What's the monthly payment on a $600,000 home with 10% down at 4.5%?"],
    });
    expect(result.ungrounded).toEqual([]);
  });

  it("flags a figure that no tool returned", () => {
    const answer = "The median asking price in Ottawa is $850,000 across 1,910 listings.";
    const result = checkGrounding({ answer, toolResults: [{ city: "ottawa", count: 1910, medianPrice: 748000 }], messages: ["Ottawa median?"] });
    expect(result.ungrounded).toEqual(["$850,000"]);
  });

  it("flags an unreturned count but not years, bed counts or postal digits", () => {
    const answer = "In 2026 the sample has 3-bed homes in M6P; about 2,400 of them sit under $1m.";
    const result = checkGrounding({ answer, toolResults: [{ count: 1842, shareUnder1M: 0.52 }], messages: ["Toronto?"] });
    expect(result.ungrounded).toEqual(["2,400"]);
  });

  it("grounds a share quoted as a percentage", () => {
    const result = checkGrounding({ answer: "52% ask under $1M.", toolResults: [{ shareUnder1M: 0.52 }], messages: [] });
    expect(result.ungrounded).toEqual([]);
  });

  it("treats figures from earlier turns as grounded", () => {
    const result = checkGrounding({
      answer: "Compared with Toronto's $999,000, Ottawa's median is $748,000.",
      toolResults: [{ city: "ottawa", medianPrice: 748000 }],
      messages: ["Toronto median?", "Toronto's median asking price is $999,000.", "and in Ottawa?"],
    });
    expect(result.ungrounded).toEqual([]);
  });

  it("ignores digits inside listing URLs", () => {
    const answer = "See https://www.zillow.com/homedetails/2481-Lefeuvre-Rd-Abbotsford-BC-V4X-1E3/465422226_zpid/ for $11,000,000.";
    const result = checkGrounding({ answer, toolResults: [{ price: 11000000 }], messages: [] });
    expect(result).toEqual({ checked: 1, ungrounded: [] });
  });

  it("does not let address digits ground a price", () => {
    const result = checkGrounding({ answer: "It asks $2,481.", toolResults: [{ address: "2481 Lefeuvre Rd, Abbotsford, BC", price: 11000000 }], messages: [] });
    expect(result.ungrounded).toEqual(["$2,481"]);
  });
});

describe("checkedFigures", () => {
  it("skips bare years but checks comma-grouped counts in the same range", () => {
    expect(checkedFigures("In 2026 there were 1,910 listings.").map((n) => n.raw)).toEqual(["1,910"]);
  });
});

describe("isGrounded", () => {
  it("allows rounding to the precision the answer quotes", () => {
    expect(isGrounded({ value: 1_300_000, kind: "money", raw: "$1.3 million" }, [1_325_000])).toBe(true);
    expect(isGrounded({ value: 1_400_000, kind: "money", raw: "$1.4 million" }, [1_325_000])).toBe(false);
    expect(isGrounded({ value: 999_000, kind: "money", raw: "$999k" }, [999_000])).toBe(true);
    expect(isGrounded({ value: 60, kind: "percent", raw: "60%" }, [59.9])).toBe(true);
  });
});
