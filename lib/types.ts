export type Listing = {
  city: string;
  province: string;
  fsa: string | null;
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  seen: string;
  address?: string;
  url?: string;
  /** Offline estimate of the typical asking price for comparable listings; null when the city is too small. */
  estValue: number | null;
  /** Percent below estValue (positive = asking below); null exactly when estValue is null. */
  discountPct: number | null;
};

export type CitySnapshot = {
  city: string;
  count: number;
  medianPrice: number;
  q1Price: number;
  q3Price: number;
  medianByBeds: Record<string, number | null>;
  shareUnder1M: number;
  medianSqft: number | null;
  updated: string;
};

/** Entry as stored in market_summary.json (the city name is the key there). */
export type CitySummary = Omit<CitySnapshot, "city">;

/** Offline valuation block written by the pipeline; optional so older data files still load. */
export type ValuationMeta = {
  method: string;
  params: {
    shrink_k: number;
    min_cell: number;
    min_city_rows: number;
    folds: number;
    sqft_min_samples: number;
    sqft_min_coverage: number;
    min_discount_pct: number;
    max_discount_pct: number;
    deal_min_price: number;
  };
  coverage_pct: number;
  oof_mdape_pct: number;
  oof_bias_pct: number;
  oof_mdape_pct_top_cities: Record<string, number>;
  oof_mdape_pct_by_city?: Record<string, number>;
  cities_estimated: number;
};

export type MarketSummary = {
  generated_at: string;
  source: string;
  totals: { rows: number; cities: number; provinces: number };
  cities: Record<string, CitySummary>;
  valuation?: ValuationMeta;
};

export type SearchQuery = {
  city: string;
  province?: string;
  fsa?: string;
  minPrice?: number;
  maxPrice?: number;
  beds?: number;
  sort?: "price_asc" | "price_desc";
  limit?: number;
};

export type SnapshotQuery = {
  city: string;
  province?: string;
  fsa?: string;
  minPrice?: number;
  maxPrice?: number;
  beds?: number;
  bathsMin?: number;
};

export type RankMetric = "median_price" | "count";

export type RankAreasQuery = {
  city: string;
  metric?: RankMetric;
  order?: "asc" | "desc";
  beds?: number;
  minPrice?: number;
  maxPrice?: number;
  bathsMin?: number;
  limit?: number;
};

export type AreaRank = {
  fsa: string;
  count: number;
  medianPrice: number;
};

export type RankAreasResult = {
  city: string;
  metric: RankMetric;
  order: "asc" | "desc";
  considered: number;
  areas: AreaRank[];
  totalAreas: number;
};

export type SearchResult = {
  totalMatches: number;
  returned: number;
  listings: Listing[];
};

export type FindDealsQuery = {
  city: string;
  minDiscount?: number;
  minPrice?: number;
  maxPrice?: number;
  beds?: number;
  limit?: number;
};

export type FindDealsResult = {
  city: string;
  /** Effective minimum discount applied (clamped to [0, 60]). */
  minDiscount: number;
  /** Scoped listings with a usable estimate and a price at or above the deal minimum. */
  considered: number;
  /** Considered listings whose discountPct falls within [minDiscount, 60]. */
  totalMatches: number;
  returned: number;
  listings: Listing[];
};
