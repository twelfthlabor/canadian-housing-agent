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

export type MarketSummary = {
  generated_at: string;
  source: string;
  totals: { rows: number; cities: number; provinces: number };
  cities: Record<string, CitySummary>;
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
