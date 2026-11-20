/**
 * Deal rules shared by find_deals, the listings route and the UI. No data
 * imports, so client components can use it without bundling the dataset.
 */

/** Price floor for deal listings. */
export const DEAL_MIN_PRICE = 100_000;

/** Discounts above this usually mean a different property type or a data error, not a deal. */
export const MAX_DISCOUNT_PCT = 50;

/** A discount is only called a deal when it clears this many times the city's typical estimate error. */
export const NOISE_MULTIPLE = 2;

/**
 * Smallest discount worth calling a deal in a city: the base threshold, or twice the
 * city's out-of-fold MdAPE when that is higher. Can exceed MAX_DISCOUNT_PCT, which
 * means the estimate is too noisy in that city to call any deal.
 */
export function dealFloorPct(baseMinPct: number, typicalErrorPct: number | null | undefined): number {
  if (typeof typicalErrorPct !== "number" || !Number.isFinite(typicalErrorPct)) return baseMinPct;
  return Math.max(baseMinPct, Math.ceil(NOISE_MULTIPLE * typicalErrorPct));
}
