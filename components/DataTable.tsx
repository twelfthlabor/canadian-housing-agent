"use client";

import { useEffect, useState } from "react";
import { cityName, money } from "./format";

type Row = {
  city: string;
  fsa: string | null;
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  address?: string;
  url?: string;
  estValue?: number | null;
  discountPct?: number | null;
};

type Mode = "price" | "discount";

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

/** Rows requested from /api/listings; the route caps its own limit at 200. */
const LIMIT = 100;

/** "18" / "18.4" — per-city MdAPE values arrive as ints or one-decimal floats. */
export function mdapeText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export default function DataTable({ cities, city, onCityChange, totalRows, valuation }: { cities: string[]; city: string; onCityChange: (city: string) => void; totalRows: number; valuation?: Partial<ValuationInfo> }) {
  const { minDiscountPct, maxDiscountPct, mdapePct, mdapeByCity, dealMinPrice = 100_000 } = { ...VALUATION_FALLBACK, ...valuation };
  const [data, setData] = useState<{ rows: Row[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("price");

  useEffect(() => {
    let active = true;
    setData(null);
    setFailed(false);
    const url = mode === "discount"
      ? `/api/listings?city=${encodeURIComponent(city)}&limit=${LIMIT}&sort=discount&minDiscount=${minDiscountPct}`
      : `/api/listings?city=${encodeURIComponent(city)}&limit=${LIMIT}`;
    fetch(url)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("request failed"))))
      .then((payload: { total?: number; listings?: unknown }) => {
        if (!active) return;
        if (!Array.isArray(payload?.listings)) throw new Error("malformed payload");
        setData({ rows: payload.listings as Row[], total: typeof payload.total === "number" ? payload.total : payload.listings.length });
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [city, mode]);

  const rows = data?.rows ?? [];
  const discountMode = mode === "discount";
  // Rows are the ground truth once loaded; the map is only a fallback for an empty page.
  const cityHasEstimate = rows.length > 0
    ? rows.some(row => typeof row.estValue === "number")
    : Object.keys(mdapeByCity).length === 0 || typeof mdapeByCity[city] === "number";
  const cityMdape = mdapeByCity[city] ?? mdapePct;
  const sortLine = discountMode
    ? `Sorted by biggest discounts: at least ${minDiscountPct}% below the comparable-listings estimate. Discounts above ${maxDiscountPct}% are outside the model's reliable range and are not shown as deals.`
    : `Sorted by lowest asking price. In Vs estimate, "—" marks rows without an estimate or with a discount above ${maxDiscountPct}%, beyond the model's reliable range.`;

  return <div className="data-view">
    <div className="data-heading">
      <div><p className="micro-label">PUBLIC SOURCE DATA</p><h1>The rows behind the sample.</h1></div>
      <div className="data-controls">
        <label className="data-city">City<select value={city} onChange={event => onCityChange(event.target.value)}>{cities.map(slug => <option key={slug} value={slug}>{cityName(slug)}</option>)}</select></label>
        <label className="data-city">Sort<select value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="price">Lowest price</option><option value="discount">Biggest discounts</option></select></label>
      </div>
    </div>
    <div className="data-meta">
      <span>{failed ? "Could not load the sample rows." : data ? (discountMode ? `Showing ${rows.length} of ${data.total.toLocaleString("en-CA")} listings ${minDiscountPct}–${maxDiscountPct}% below the comparable-listings estimate` : `Showing ${rows.length} of ${data.total.toLocaleString("en-CA")} listings`) : "Loading listings…"}</span>
      <a href="/api/listings?format=csv" download>Download CSV · {totalRows.toLocaleString("en-CA")} rows</a>
    </div>
    {data && !failed && discountMode && rows.length === 0 ? <p className="data-empty">{cityHasEstimate ? `No listings in ${cityName(city)} are at least ${minDiscountPct}% below the comparable-listings estimate (priced ${money(dealMinPrice)}+, discounts above ${maxDiscountPct}% excluded).` : `No valuation estimates are available for ${cityName(city)} (fewer than 30 listings).`}</p> : null}
    <div className="data-scroll">
      <table className="data-table">
        <caption className="sr-only">Sample {cityName(city)} listings, {discountMode ? `sorted by biggest discounts, at least ${minDiscountPct}% below the comparable-listings estimate` : "sorted by asking price"}</caption>
        <thead><tr><th scope="col">Price</th><th scope="col">Est. typical asking</th><th scope="col">Vs estimate</th><th scope="col">Beds</th><th scope="col">Baths</th><th scope="col">Sqft</th><th scope="col">FSA</th><th scope="col">Address</th><th scope="col">Source</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <td className="data-price">{money(row.price)}</td>
          <td className="data-estimate">{typeof row.estValue === "number" ? money(row.estValue) : "—"}</td>
          <td>{typeof row.discountPct === "number" && typeof row.estValue === "number"
            ? row.discountPct > maxDiscountPct
              ? <span title="Discount beyond the model's reliable range">—</span>
              : row.discountPct >= minDiscountPct
                ? <span className="deal-badge" title={`Estimated typical asking price: ${money(row.estValue)}`} aria-label={`${Math.round(row.discountPct)}% below estimated typical asking price of ${money(row.estValue)}${typeof cityMdape === "number" ? `; estimates typically err by about ±${mdapeText(cityMdape)}%` : ""}`}>{Math.round(row.discountPct)}% below est.</span>
                : <span className="estimate-near" title={`Estimated typical asking price: ${money(row.estValue)}`}>{Math.round(row.discountPct)}% vs est.</span>
            : "—"}</td>
          <td>{row.beds ?? "—"}</td>
          <td>{row.baths ?? "—"}</td>
          <td>{row.sqft === null || row.sqft === undefined ? "—" : row.sqft.toLocaleString("en-CA")}</td>
          <td>{row.fsa ?? "—"}</td>
          <td className="data-address">{row.address ?? "—"}</td>
          <td>{row.url?.startsWith("https://") ? <a href={row.url} target="_blank" rel="noopener noreferrer">View listing ↗</a> : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="data-fineprint">{sortLine} {cityHasEstimate && typeof cityMdape === "number" ? `Estimates for ${cityName(city)} typically err by about ±${mdapeText(cityMdape)}%; discounts smaller than that are not meaningful. ` : ""}Estimated value compares asking prices with similar listings’ asking prices; it is not an appraisal.</p>
  </div>;
}
