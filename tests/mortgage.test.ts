import { describe, expect, it } from "vitest";
import {
  CMHC_MAX_PRICE,
  MortgageError,
  cmhcPremiumRate,
  computeMortgage,
  maxPriceForIncome,
  minDownPayment,
  monthlyPayment,
  monthlyRate,
  stressRatePct,
} from "../lib/mortgage";
import { TOOL_IMPLS, TOOL_SPECS } from "../lib/tools";

describe("minDownPayment", () => {
  it("applies the 5% / 10% / 20% tiers", () => {
    expect(minDownPayment(400_000)).toBe(20_000);
    expect(minDownPayment(500_000)).toBe(25_000);
    expect(minDownPayment(800_000)).toBe(55_000);
    expect(minDownPayment(1_200_000)).toBe(115_000);
  });
});

describe("cmhcPremiumRate", () => {
  it("uses the loan-to-value bands and none at 20% or more", () => {
    expect(cmhcPremiumRate(5)).toBe(0.04);
    expect(cmhcPremiumRate(10)).toBe(0.031);
    expect(cmhcPremiumRate(15)).toBe(0.028);
    expect(cmhcPremiumRate(20)).toBe(0);
  });
});

describe("monthlyRate and monthlyPayment", () => {
  it("converts semi-annual compounding to an effective monthly rate", () => {
    expect(monthlyRate(0)).toBe(0);
    // (1 + 0.045/2)^(1/6) - 1 is the monthly rate for a 4.5% semi-annual mortgage.
    expect(monthlyRate(4.5)).toBeCloseTo(Math.pow(1.0225, 1 / 6) - 1, 12);
  });

  it("amortizes principal to zero and handles a zero rate", () => {
    const payment = monthlyPayment(300_000, 5, 25);
    const r = monthlyRate(5);
    let balance = 300_000;
    for (let i = 0; i < 300; i += 1) balance = balance * (1 + r) - payment;
    expect(Math.abs(balance)).toBeLessThan(0.01);
    expect(monthlyPayment(120_000, 0, 10)).toBe(1_000);
    expect(monthlyPayment(0, 4, 25)).toBe(0);
  });
});

describe("stressRatePct", () => {
  it("uses the greater of contract plus 2 and 5.25", () => {
    expect(stressRatePct(2)).toBe(5.25);
    expect(stressRatePct(4)).toBe(6);
    expect(stressRatePct(4.5)).toBe(6.5);
  });
});

describe("computeMortgage", () => {
  it("adds a CMHC premium to the loan under 20% down", () => {
    const result = computeMortgage({ price: 850_000, downPct: 10, ratePct: 4.5, amortYears: 25 });
    expect(result.downPayment).toBe(85_000);
    expect(result.loan).toBe(765_000);
    expect(result.insuranceRequired).toBe(true);
    expect(result.cmhcPremium).toBe(23_715);
    expect(result.insuredLoan).toBe(788_715);
    expect(result.stressRatePct).toBe(6.5);
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it("charges no premium at 20% down and reports no insurance", () => {
    const result = computeMortgage({ price: 1_200_000, downPct: 20, ratePct: 4.5, amortYears: 25 });
    expect(result.insuranceRequired).toBe(false);
    expect(result.cmhcPremium).toBe(0);
    expect(result.insuredLoan).toBe(result.loan);
  });

  it("rejects down payments below the federal minimum", () => {
    expect(() => computeMortgage({ price: 500_000, downPct: 4, ratePct: 4.5, amortYears: 25 })).toThrow(MortgageError);
  });

  it("rejects insured purchases above the CMHC price cap", () => {
    expect(() => computeMortgage({ price: CMHC_MAX_PRICE + 100_000, downPct: 10, ratePct: 4.5, amortYears: 25 })).toThrow(
      /CMHC insurance is not available/,
    );
  });

  it("validates ranges", () => {
    expect(() => computeMortgage({ price: 0, downPct: 20, ratePct: 4, amortYears: 25 })).toThrow(MortgageError);
    expect(() => computeMortgage({ price: 500_000, downPct: 20, ratePct: 16, amortYears: 25 })).toThrow(MortgageError);
    expect(() => computeMortgage({ price: 500_000, downPct: 20, ratePct: 4, amortYears: 40 })).toThrow(MortgageError);
    expect(() => computeMortgage({ price: 500_000, downPct: 20, ratePct: 4, amortYears: 25.5 })).toThrow(MortgageError);
  });

  it("estimates the income needed under the 39% GDS limit", () => {
    const result = computeMortgage({ price: 600_000, downPct: 20, ratePct: 4.5, amortYears: 25 });
    const housing = result.stressMonthlyPayment + (600_000 * 0.01) / 12 + 150;
    expect(result.incomeNeeded).toBe(Math.round((housing * 12) / 0.39));
  });
});

describe("mortgage_estimate tool", () => {
  it("is registered in the tool schema with required inputs", () => {
    const spec = TOOL_SPECS.find(tool => tool.function.name === "mortgage_estimate");
    expect(spec?.function.parameters.required).toEqual(["downPct", "ratePct"]);
  });

  it("returns the calculation for valid args and an error object otherwise", () => {
    const ok = TOOL_IMPLS.mortgage_estimate({ price: "850000", downPct: 10, ratePct: 4.5 }) as { monthlyPayment: number };
    expect(ok.monthlyPayment).toBeGreaterThan(4_000);
    const bad = TOOL_IMPLS.mortgage_estimate({ price: 500_000, downPct: 1, ratePct: 4.5 }) as { error: string };
    expect(bad.error).toMatch(/at least/);
    const budget = TOOL_IMPLS.mortgage_estimate({ householdIncome: 150_000, downPct: 20, ratePct: 4.5 }) as { maxAffordablePrice: number; monthlyPayment?: number };
    expect(budget.maxAffordablePrice).toBeGreaterThan(500_000);
    expect(budget.monthlyPayment).toBeUndefined();
    expect(TOOL_IMPLS.mortgage_estimate({ downPct: 20, ratePct: 4.5 })).toEqual({ error: "Give a price, a householdIncome, or both." });
    const invalid = TOOL_IMPLS.mortgage_estimate({ householdIncome: 150_000, downPct: 1, ratePct: 4.5 }) as { error: string };
    expect(invalid.error).toMatch(/at least/);
  });
});

describe("mock provider routing for mortgage questions", () => {
  it("parses prices written as k, m, or full numbers", async () => {
    const { parsePriceText } = await import("../lib/providers");
    expect(parsePriceText("what is the payment on $850k at 10% down")).toBe(850_000);
    expect(parsePriceText("a 1.2m home")).toBe(1_200_000);
    expect(parsePriceText("price 750,000")).toBe(750_000);
    expect(parsePriceText("no number here")).toBeNull();
  });

  it("routes payment questions to mortgage_estimate and asks when no price is given", async () => {
    const { mockToolCallFor } = await import("../lib/providers");
    const call = mockToolCallFor("monthly payment on $850k with 10% down at 4.2% rate");
    expect(call?.name).toBe("mortgage_estimate");
    expect(call?.args).toEqual({ price: 850_000, downPct: 10, ratePct: 4.2, amortYears: 25 });
    expect(mockToolCallFor("what would my mortgage payment be?")).toBeNull();
  });
});

describe("mortgage answers use the insured loan", () => {
  it("rejects implausibly low prices", () => {
    expect(() => computeMortgage({ price: 100, downPct: 20, ratePct: 4.5, amortYears: 25 })).toThrow(/at least/);
  });

  it("says the payment includes the CMHC premium", async () => {
    const { mockAnswerFromToolResult } = await import("../lib/providers");
    const result = computeMortgage({ price: 850_000, downPct: 10, ratePct: 4.5, amortYears: 25 });
    const answer = mockAnswerFromToolResult({ role: "tool", name: "mortgage_estimate", content: JSON.stringify(result) });
    expect(answer).toContain("$788,715 mortgage");
    expect(answer).toContain("$23,715 CMHC premium");
    expect(answer).toContain(`$${Math.round(result.monthlyPayment).toLocaleString("en-CA")}`);
  });
});

describe("maxPriceForIncome", () => {
  const base = { downPct: 20, ratePct: 4.5, amortYears: 25 };

  it("returns a price whose income need fits, and not one $1k higher", () => {
    const max = maxPriceForIncome({ ...base, householdIncome: 150_000 });
    expect(max).not.toBeNull();
    expect(computeMortgage({ ...base, price: max as number }).incomeNeeded).toBeLessThanOrEqual(150_000);
    expect(computeMortgage({ ...base, price: (max as number) + 2_000 }).incomeNeeded).toBeGreaterThan(150_000);
  });

  it("grows with income and shrinks with a higher rate", () => {
    const low = maxPriceForIncome({ ...base, householdIncome: 90_000 }) as number;
    const high = maxPriceForIncome({ ...base, householdIncome: 200_000 }) as number;
    const pricier = maxPriceForIncome({ ...base, ratePct: 6.5, householdIncome: 200_000 }) as number;
    expect(high).toBeGreaterThan(low);
    expect(pricier).toBeLessThan(high);
  });

  it("returns null when even the minimum price does not fit", () => {
    expect(maxPriceForIncome({ ...base, householdIncome: 5_000 })).toBeNull();
  });

  it("rejects a non-positive income", () => {
    expect(() => maxPriceForIncome({ ...base, householdIncome: 0 })).toThrow(MortgageError);
  });
});
