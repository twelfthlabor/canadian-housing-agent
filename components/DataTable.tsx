"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import type { Listing } from "@/lib/types";
import CountUp from "./CountUp";
import Icon from "./Icon";
import MoneyInput from "./MoneyInput";
import { PROVINCES, cityName, money } from "./format";

type Sort = "price_asc" | "price_desc" | "newest" | "discount";

const SORT_LABELS: Record<Sort, string> = {
  price_asc: "Lowest price",
  price_desc: "Highest price",
  newest: "Newest sightings",
  discount: "Biggest discounts",
};

/** Valuation metadata the components need; callers may pass a partial. */
export type ValuationInfo = {
  minDiscountPct: number;
  maxDiscountPct: number;
  mdapePct: number | null;
  mdapeByCity: Record<string, number>;
  /** Deal price floor, for the discount-window copy; optional so callers can omit it. */
  dealMinPrice?: number;
};

export const VALUATION_FALLBACK: ValuationInfo = { minDiscountPct: 15, maxDiscountPct: 60, mdapePct: null, mdapeByCity: {}, dealMinPrice: 100_000 };

/** Rows per request; the API caps its own limit at 200. */
const PAGE_SIZE = 60;

type Filters = {
  scope: string;
  province: string;
  beds: string;
  minPrice: string;
  maxPrice: string;
  q: string;
  sort: Sort;
};

type Page = { key: string; rows: Listing[]; total: number; nextOffset: number | null };

type ApiPage = { total?: number; nextOffset?: number | null; listings?: unknown };

/** "18" / "18.4" — per-city MdAPE values arrive as ints or one-decimal floats. */
export function mdapeText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Query string for one page; the same filters always produce the same key. */
export function listingsQuery(filters: Filters, offset: number, minDiscountPct: number): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort: filters.sort });
  if (filters.scope) params.set("city", filters.scope);
  if (filters.province) params.set("province", filters.province);
  if (filters.beds) params.set("beds", filters.beds);
  if (filters.minPrice) params.set("minPrice", filters.minPrice);
  if (filters.maxPrice) params.set("maxPrice", filters.maxPrice);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.sort === "discount") params.set("minDiscount", String(minDiscountPct));
  return params.toString();
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<ApiPage> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("request failed");
  const payload = (await response.json()) as ApiPage;
  if (!Array.isArray(payload?.listings)) throw new Error("malformed payload");
  return payload;
}

/** URL keys for the explorer; prefixed so they never collide with the atlas's own city and sort params. */
const URL_KEYS: Record<keyof Omit<Filters, "scope">, string> = { province: "dprov", beds: "dbeds", minPrice: "dmin", maxPrice: "dmax", q: "dq", sort: "dsort" };

/** Filters from the URL; anything unrecognised falls back to the default. */
export function filtersFromParams(params: { get(name: string): string | null }, city: string): Filters {
  const digits = (value: string | null) => (value ?? "").replace(/\D/g, "").slice(0, 9);
  const province = params.get(URL_KEYS.province) ?? "";
  const beds = params.get(URL_KEYS.beds) ?? "";
  const sort = params.get(URL_KEYS.sort) ?? "";
  return {
    scope: params.get("dscope") === "all" ? "" : city,
    province: PROVINCES.some(item => item.code === province) ? province : "",
    beds: ["1", "2", "3", "4", "5"].includes(beds) ? beds : "",
    minPrice: digits(params.get(URL_KEYS.minPrice)),
    maxPrice: digits(params.get(URL_KEYS.maxPrice)),
    q: (params.get(URL_KEYS.q) ?? "").slice(0, 80),
    sort: (Object.keys(SORT_LABELS) as Sort[]).includes(sort as Sort) ? (sort as Sort) : "price_asc",
  };
}

export default function DataTable({ cities, city, onCityChange, totalRows, valuation }: { cities: string[]; city: string; onCityChange: (city: string) => void; totalRows: number; valuation?: Partial<ValuationInfo> }) {
  const { minDiscountPct, maxDiscountPct, mdapePct, mdapeByCity, dealMinPrice = 100_000 } = { ...VALUATION_FALLBACK, ...valuation };
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(searchParams, city));
  const debouncedMin = useDebounced(filters.minPrice);
  const debouncedMax = useDebounced(filters.maxPrice);
  const debouncedQ = useDebounced(filters.q);
  const debounced = { ...filters, minPrice: debouncedMin, maxPrice: debouncedMax, q: debouncedQ };
  const queryKey = listingsQuery(debounced, 0, minDiscountPct);
  const [page, setPage] = useState<Page | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [moreBusy, setMoreBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Keep the explorer in step with map and index selections; the first render keeps URL scope.
  const previousCity = useRef(city);
  useEffect(() => {
    if (previousCity.current === city) return;
    previousCity.current = city;
    setFilters(current => (current.scope === city ? current : { ...current, scope: city }));
  }, [city]);

  // Mirror the explorer state into the URL so a filtered view can be shared or reloaded.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const set = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
    set("dscope", filters.scope === "" ? "all" : "");
    set(URL_KEYS.province, filters.province);
    set(URL_KEYS.beds, filters.beds);
    set(URL_KEYS.minPrice, filters.minPrice);
    set(URL_KEYS.maxPrice, filters.maxPrice);
    set(URL_KEYS.q, filters.q.trim());
    set(URL_KEYS.sort, filters.sort === "price_asc" ? "" : filters.sort);
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    fetchPage(`/api/listings?${queryKey}`, controller.signal)
      .then(payload => {
        setPage({ key: queryKey, rows: payload.listings as Listing[], total: payload.total ?? 0, nextOffset: payload.nextOffset ?? null });
        setStatus("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [queryKey, attempt]);

  function loadMore() {
    if (!page?.nextOffset || moreBusy) return;
    const key = page.key;
    setMoreBusy(true);
    fetchPage(`/api/listings?${listingsQuery(debounced, page.nextOffset, minDiscountPct)}`)
      .then(payload => {
        setPage(current => current && current.key === key
          ? { key, rows: [...current.rows, ...(payload.listings as Listing[])], total: payload.total ?? current.total, nextOffset: payload.nextOffset ?? null }
          : current);
      })
      .catch(() => setStatus("error"))
      .finally(() => setMoreBusy(false));
  }

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters(current => ({ ...current, [key]: value }));
  }

  function chooseScope(value: string) {
    update("scope", value);
    if (value) onCityChange(value);
  }

  function clearFilters() {
    setFilters(current => ({ ...current, province: "", beds: "", minPrice: "", maxPrice: "", q: "" }));
  }

  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const discountMode = filters.sort === "discount";
  const filtersActive = Boolean(filters.province || filters.beds || filters.minPrice || filters.maxPrice || filters.q.trim());
  const scopeLabel = filters.scope ? cityName(filters.scope) : "all cities";
  const provinceName = PROVINCES.find(item => item.code === filters.province)?.name ?? filters.province;
  const cityInProvinceConflict = Boolean(filters.scope && filters.province) && status === "ready" && rows.length === 0 && total === 0;
  const rowMdape = (row: Listing) => mdapeByCity[row.city] ?? mdapePct;
  const singleCityMdape = filters.scope ? mdapeByCity[filters.scope] : undefined;
  const sortLine = discountMode
    ? `Sorted by biggest discounts: at least ${minDiscountPct}% below the comparable-listings estimate. Discounts above ${maxDiscountPct}% are outside the model's reliable range and are not shown as deals.`
    : `Sorted by ${SORT_LABELS[filters.sort].toLowerCase()}. In Vs estimate, "—" marks rows without an estimate or with a discount above ${maxDiscountPct}%, beyond the model's reliable range.`;

  return <div className="data-view">
    <div className="data-heading">
      <div>
        <p className="micro-label">PUBLIC SOURCE DATA</p>
        <h1>The rows behind the sample.</h1>
      </div>
      <a className="data-download" href="/api/listings?format=csv" download><Icon name="database" />Download CSV · {totalRows.toLocaleString("en-CA")} rows</a>
    </div>

    <form className="data-filters" role="search" aria-label="Filter listings" onSubmit={event => event.preventDefault()}>
      <label className="filter-field filter-search"><span>Search</span><input type="search" placeholder="Address, city or FSA" value={filters.q} onChange={event => update("q", event.target.value)} /></label>
      <label className="filter-field"><span>City</span><select value={filters.scope} onChange={event => chooseScope(event.target.value)}><option value="">All cities</option>{cities.map(slug => <option key={slug} value={slug}>{cityName(slug)}</option>)}</select></label>
      <label className="filter-field"><span>Province</span><select value={filters.province} onChange={event => update("province", event.target.value)}><option value="">Any</option>{PROVINCES.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
      <label className="filter-field"><span>Beds</span><select value={filters.beds} onChange={event => update("beds", event.target.value)}><option value="">Any</option>{[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
      <label className="filter-field filter-price"><span>Min price</span><MoneyInput value={filters.minPrice} onChange={value => update("minPrice", value)} label="Minimum price" placeholder="Any" /></label>
      <label className="filter-field filter-price"><span>Max price</span><MoneyInput value={filters.maxPrice} onChange={value => update("maxPrice", value)} label="Maximum price" placeholder="Any" /></label>
      <label className="filter-field"><span>Sort</span><select value={filters.sort} onChange={event => update("sort", event.target.value as Sort)}>{(Object.keys(SORT_LABELS) as Sort[]).map(key => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}</select></label>
    </form>

    <div className="data-meta" aria-live="polite">
      <span>
        {status === "error" ? "Could not load the sample rows." : status === "loading" && !page ? "Loading listings…" : <>Showing <strong><CountUp value={rows.length} /></strong> of <strong><CountUp value={total} /></strong> listings in {scopeLabel}{filtersActive ? ", filtered" : ""}</>}
      </span>
      {status === "error" ? <button className="data-retry" onClick={() => setAttempt(count => count + 1)}><Icon name="refresh" />Try again</button> : null}
    </div>

    {status === "ready" && rows.length === 0 ? <div className="data-empty-state">
      <Icon name="search" />
      <div>
        <strong>{discountMode ? "No deals match these filters." : "No listings match these filters."}</strong>
        <p>{cityInProvinceConflict
          ? `${cityName(filters.scope)} has no listings in ${provinceName}. Choose “All cities” to search the whole province.`
          : discountMode && !filters.scope && !filters.province && !filters.minPrice && !filters.maxPrice ? `No listings are at least ${minDiscountPct}% below the comparable-listings estimate (priced ${money(dealMinPrice)}+, discounts above ${maxDiscountPct}% excluded).` : "Try widening the price range or removing a filter."}</p>
        {cityInProvinceConflict ? <button onClick={() => update("scope", "")}>Show all cities</button> : filtersActive ? <button onClick={clearFilters}>Clear filters</button> : null}
      </div>
    </div> : null}

    <div className={`data-scroll${status === "loading" && page ? " is-refreshing" : ""}`} aria-busy={status === "loading"}>
      <table className="data-table">
        <caption className="sr-only">Listings in {scopeLabel}, {SORT_LABELS[filters.sort].toLowerCase()}</caption>
        <thead><tr><th scope="col">Price</th><th scope="col">Est. typical asking</th><th scope="col">Vs estimate</th><th scope="col">City</th><th scope="col">Beds</th><th scope="col">Baths</th><th scope="col">Sqft</th><th scope="col">FSA</th><th scope="col">Address</th><th scope="col">Source</th></tr></thead>
        <tbody>
          {status === "loading" && !page ? Array.from({ length: 8 }, (_, index) => <tr key={`skeleton-${index}`} className="skeleton-row" aria-hidden="true">{Array.from({ length: 10 }, (__, cell) => <td key={cell}><span className="skeleton-bar" style={{ width: `${40 + ((index * 7 + cell * 13) % 50)}%` }} /></td>)}</tr>) : null}
          {rows.map((row, index) => <tr key={`${row.city}-${row.address ?? ""}-${row.price}-${index}`} className="row-enter" style={{ "--i": Math.min(index, 12) } as CSSProperties}>
            <td className="data-price">{money(row.price)}</td>
            <td className="data-estimate">{typeof row.estValue === "number" ? money(row.estValue) : "—"}</td>
            <td>{typeof row.discountPct === "number" && typeof row.estValue === "number"
              ? row.discountPct > maxDiscountPct
                ? <span title="Discount beyond the model's reliable range">—</span>
                : row.discountPct >= minDiscountPct
                  ? <span className="deal-badge" title={`Estimated typical asking price: ${money(row.estValue)}`} aria-label={`${Math.round(row.discountPct)}% below estimated typical asking price of ${money(row.estValue)}${typeof rowMdape(row) === "number" ? `; estimates typically err by about ±${mdapeText(rowMdape(row) as number)}%` : ""}`}>{Math.round(row.discountPct)}% below est.</span>
                  : <span className="estimate-near" title={`Estimated typical asking price: ${money(row.estValue)}`}>{Math.round(row.discountPct)}% vs est.</span>
              : "—"}</td>
            <td>{cityName(row.city)}</td>
            <td>{row.beds ?? "—"}</td>
            <td>{row.baths ?? "—"}</td>
            <td>{row.sqft === null || row.sqft === undefined ? "—" : row.sqft.toLocaleString("en-CA")}</td>
            <td>{row.fsa ?? "—"}</td>
            <td className="data-address">{row.address ?? "—"}</td>
            <td>{row.url?.startsWith("https://") ? <a href={row.url} target="_blank" rel="noopener noreferrer">View listing ↗</a> : "—"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>

    {page?.nextOffset ? <div className="data-more">
      <button onClick={loadMore} disabled={moreBusy}>{moreBusy ? "Loading…" : `Load ${Math.min(PAGE_SIZE, total - rows.length)} more`}</button>
      <span>{(total - rows.length).toLocaleString("en-CA")} remaining</span>
    </div> : null}

    <p className="data-fineprint">{sortLine} {typeof singleCityMdape === "number" && filters.scope ? `Estimates for ${cityName(filters.scope)} typically err by about ±${mdapeText(singleCityMdape)}%; discounts smaller than that are not meaningful. ` : ""}Estimated value compares asking prices with similar listings’ asking prices; it is not an appraisal.</p>
  </div>;
}
