/**
 * Illustrative Canadian mortgage arithmetic: minimum down payment, CMHC premium,
 * semi-annual-compounding monthly payment, and the OSFI stress-test qualifying rate.
 * Pure and deterministic; it is not a mortgage offer and does not fetch live rates.
 */

export const STRESS_TEST_FLOOR_PCT = 5.25;
export const STRESS_TEST_BUFFER_PCT = 2;
/** Gross debt service ceiling used for the income estimate. */
export const GDS_LIMIT = 0.39;
/** Insured mortgages are not available for homes priced above this (2024 federal rules). */
export const CMHC_MAX_PRICE = 1_500_000;
/** Below this the calculator is not useful and the input is most likely a typo. */
export const MIN_PRICE = 50_000;
/** Assumed annual property tax as a share of price, and monthly heating, for the income estimate. */
export const PROPERTY_TAX_RATE = 0.01;
export const HEAT_MONTHLY = 150;

export type MortgageInput = {
  price: number;
  downPct: number;
  ratePct: number;
  amortYears: number;
};

export type MortgageResult = {
  price: number;
  downPayment: number;
  loan: number;
  minDownPayment: number;
  /** Premium is added to the loan when the buyer puts down less than 20%. */
  cmhcPremium: number;
  insuredLoan: number;
  insuranceRequired: boolean;
  monthlyPayment: number;
  totalInterest: number;
  stressRatePct: number;
  stressMonthlyPayment: number;
  /** Annual household income needed to keep the stressed housing costs under the 39% GDS limit. */
  incomeNeeded: number;
};

/** Minimum down payment rules: 5% to $500k, 10% from $500k to $1m, 20% above $1m. */
export function minDownPayment(price: number): number {
  const first = Math.min(price, 500_000) * 0.05;
  const second = Math.max(0, Math.min(price, 1_000_000) - 500_000) * 0.1;
  const third = Math.max(0, price - 1_000_000) * 0.2;
  return first + second + third;
}

/** CMHC premium rate on the loan, by loan-to-value band (insured mortgages only). */
export function cmhcPremiumRate(downPct: number): number {
  if (downPct >= 20) return 0;
  if (downPct >= 15) return 0.028;
  if (downPct >= 10) return 0.031;
  return 0.04;
}

/** Canadian fixed mortgages compound semi-annually; convert to an effective monthly rate. */
export function monthlyRate(annualPct: number): number {
  return Math.pow(1 + annualPct / 200, 1 / 6) - 1;
}

export function monthlyPayment(principal: number, annualPct: number, amortYears: number): number {
  const months = amortYears * 12;
  if (principal <= 0) return 0;
  const rate = monthlyRate(annualPct);
  if (rate === 0) return principal / months;
  return (principal * rate) / (1 - Math.pow(1 + rate, -months));
}

export function stressRatePct(contractPct: number): number {
  return Math.max(contractPct + STRESS_TEST_BUFFER_PCT, STRESS_TEST_FLOOR_PCT);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export class MortgageError extends Error {}

/** Throws MortgageError for inputs outside the model's supported range. */
export function computeMortgage(input: MortgageInput): MortgageResult {
  const { price, downPct, ratePct, amortYears } = input;
  if (!Number.isFinite(price) || price < MIN_PRICE) throw new MortgageError(`price must be at least ${money(MIN_PRICE)}`);
  if (!Number.isFinite(downPct) || downPct < 0 || downPct > 100) throw new MortgageError("downPct must be between 0 and 100");
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 15) throw new MortgageError("ratePct must be between 0 and 15");
  if (!Number.isInteger(amortYears) || amortYears < 5 || amortYears > 30) throw new MortgageError("amortYears must be a whole number from 5 to 30");

  const downPayment = price * (downPct / 100);
  const minDown = minDownPayment(price);
  if (price > CMHC_MAX_PRICE && downPct < 20) {
    throw new MortgageError(`CMHC insurance is not available above ${money(CMHC_MAX_PRICE)}, so a ${money(price)} home needs 20% down`);
  }
  if (downPayment < minDown) {
    throw new MortgageError(`a ${money(price)} home needs at least ${money(minDown)} down under Canadian rules`);
  }

  const baseLoan = price - downPayment;
  const insuranceRequired = downPct < 20;
  const cmhcPremium = insuranceRequired ? baseLoan * cmhcPremiumRate(downPct) : 0;
  const insuredLoan = baseLoan + cmhcPremium;
  const payment = monthlyPayment(insuredLoan, ratePct, amortYears);
  const stressRate = stressRatePct(ratePct);
  const stressPayment = monthlyPayment(insuredLoan, stressRate, amortYears);
  const housingCostsMonthly = stressPayment + (price * PROPERTY_TAX_RATE) / 12 + HEAT_MONTHLY;

  return {
    price,
    downPayment: round2(downPayment),
    loan: round2(baseLoan),
    minDownPayment: round2(minDown),
    cmhcPremium: round2(cmhcPremium),
    insuredLoan: round2(insuredLoan),
    insuranceRequired,
    monthlyPayment: round2(payment),
    totalInterest: round2(payment * amortYears * 12 - insuredLoan),
    stressRatePct: round2(stressRate),
    stressMonthlyPayment: round2(stressPayment),
    incomeNeeded: Math.round((housingCostsMonthly * 12) / GDS_LIMIT),
  };
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-CA")}`;
}

export type BudgetInput = Omit<MortgageInput, "price"> & { householdIncome: number };

/**
 * Highest purchase price whose stressed housing costs fit the 39% GDS limit for this income.
 * Income needed rises with price, so a bisection over price finds the boundary; null when even
 * the smallest supported price does not fit or the down-payment rules fail there.
 */
export function maxPriceForIncome(input: BudgetInput): number | null {
  const { householdIncome, ...rest } = input;
  if (!Number.isFinite(householdIncome) || householdIncome <= 0) throw new MortgageError("householdIncome must be a positive number");
  const fits = (price: number): boolean => {
    try {
      return computeMortgage({ ...rest, price }).incomeNeeded <= householdIncome;
    } catch {
      return false;
    }
  };
  let low = MIN_PRICE;
  if (!fits(low)) return null;
  let high = 5_000_000;
  if (fits(high)) return high;
  while (high - low > 1_000) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return Math.floor(low / 1_000) * 1_000;
}
