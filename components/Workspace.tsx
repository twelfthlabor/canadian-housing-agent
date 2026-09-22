"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CitySummary, MarketSummary } from "@/lib/types";
import Chat from "./Chat";
import DataTable from "./DataTable";
import Icon from "./Icon";
import MapCanvas from "./MapCanvas";
import { cityName, compactMoney, money } from "./format";

const featured = ["toronto", "ottawa", "hamilton", "kitchener", "london", "mississauga", "barrie", "windsor"];

const DEFAULT_CEILING = 2_000_000;
const CEILING_MIN = 300_000;
const CEILING_STEP = 50_000;
const SORTS = ["featured", "name", "low", "high"] as const;
type Sort = (typeof SORTS)[number];

type Params = { get(name: string): string | null };

/** URL params are hints: anything unknown falls back to the default state. */
function paramCity(params: Params, cities: string[]): string {
  const value = params.get("city");
  return value && cities.includes(value) ? value : "toronto";
}

function paramCeiling(params: Params): number {
  const value = Number(params.get("max"));
  if (!Number.isFinite(value) || value < CEILING_MIN || value > DEFAULT_CEILING) return DEFAULT_CEILING;
  // Snap to the slider's step so the restored URL matches a selectable value.
  return CEILING_MIN + Math.round((value - CEILING_MIN) / CEILING_STEP) * CEILING_STEP;
}

function paramSort(params: Params): Sort {
  const value = params.get("sort") ?? "";
  return (SORTS as readonly string[]).includes(value) ? (value as Sort) : "featured";
}

function paramPair(params: Params, cities: string[]): [string, string] {
  const [first, second] = (params.get("compare") ?? "").split(",");
  if (first && second && first !== second && cities.includes(first) && cities.includes(second)) return [first, second];
  if (first && cities.includes(first)) return [first, first === "ottawa" ? "toronto" : "ottawa"];
  return ["toronto", "ottawa"];
}

type Props = { summary: MarketSummary; offline: boolean };

export default function Workspace({ summary, offline }: Props) {
  const cities = Object.keys(summary.cities);
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState(() => paramCity(searchParams, cities));
  const [view, setView] = useState<"explore" | "compare" | "data">(() => (searchParams.get("view") === "data" ? "data" : "explore"));
  const [mobileView, setMobileView] = useState<"map" | "list">(() => (searchParams.get("tab") === "cities" ? "list" : "map"));
  const [query, setQuery] = useState("");
  const [ceiling, setCeiling] = useState(() => paramCeiling(searchParams));
  const [sort, setSort] = useState<Sort>(() => paramSort(searchParams));
  const [pair, setPair] = useState<[string, string]>(() => paramPair(searchParams, cities));
  const [detailView, setDetailView] = useState<"overview" | "beds">("overview");
  const [draft, setDraft] = useState<{ text: string; id: number } | null>(null);
  const agentDialog = useRef<HTMLDialogElement>(null);
  const aboutDialog = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const snap = summary.cities[selected];
  const activeFilter = ceiling < 2_000_000 || Boolean(query);

  const visible = useMemo(() => cities.filter(city => cityName(city).toLowerCase().includes(query.toLowerCase().trim()) && (ceiling === 2_000_000 || summary.cities[city].medianPrice <= ceiling)).sort((a, b) => {
    if (sort === "low") return summary.cities[a].medianPrice - summary.cities[b].medianPrice;
    if (sort === "high") return summary.cities[b].medianPrice - summary.cities[a].medianPrice;
    if (sort === "name") return cityName(a).localeCompare(cityName(b));
    const rank = (city: string) => featured.includes(city) ? featured.indexOf(city) : 100;
    return rank(a) - rank(b) || cityName(a).localeCompare(cityName(b));
  }), [cities, query, ceiling, sort, summary.cities]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.key !== "/" || agentDialog.current?.open || aboutDialog.current?.open) return;
      if (event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable)) return;
      event.preventDefault();
      setMobileView("list");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  // Shareable atlas state: mirror the five selections into the URL without
  // navigating, so a copied link reopens the same view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const set = (key: string, value: string | null) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    };
    set("city", selected === "toronto" ? null : selected);
    set("compare", pair[0] === "toronto" && pair[1] === "ottawa" ? null : `${pair[0]},${pair[1]}`);
    set("sort", sort === "featured" ? null : sort);
    set("max", ceiling === DEFAULT_CEILING ? null : String(ceiling));
    set("tab", mobileView === "map" ? null : "cities");
    set("view", view === "data" ? "data" : null);
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [selected, pair, sort, ceiling, mobileView, view]);

  function selectCity(city: string) {
    setSelected(city);
    setView("explore");
    setMobileView("map");
  }

  function ask(text?: string) {
    agentDialog.current?.showModal();
    if (text) setDraft(current => ({ text, id: (current?.id ?? 0) + 1 }));
    else requestAnimationFrame(() => agentDialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
  }

  function compareCity(city: string) {
    setPair([selected, city === selected ? (selected === "ottawa" ? "toronto" : "ottawa") : city]);
    setView("compare");
    setMobileView("map");
  }

  const built = new Date(summary.generated_at).toLocaleDateString("en-CA", { day: "numeric", month: "short", timeZone: "UTC" });

  return <div className="atlas-app">
    <header className="atlas-header">
      <a className="wordmark" href="/" aria-label="Canada Housing Agent home"><span className="atlas-symbol" aria-hidden="true"><i /><i /><i /></span>canada<span className="wordmark-label">HOUSING ATLAS</span></a>
      <nav className="workspace-nav" aria-label="Workspace view">
        <button aria-pressed={view === "explore"} onClick={() => { setView("explore"); setMobileView("map"); }}><Icon name="map" />Explore</button>
        <button aria-pressed={view === "compare"} onClick={() => { setView("compare"); setMobileView("map"); }}><Icon name="compare" />Compare<span className="nav-count">2</span></button>
        <button aria-pressed={view === "data"} onClick={() => { setView("data"); setMobileView("map"); }}><Icon name="database" />Data</button>
      </nav>
      <div className="header-actions"><button className="about-button" aria-label="About this dataset" onClick={() => aboutDialog.current?.showModal()}><Icon name="info" /></button><button className="agent-trigger" aria-label="Ask the agent" onClick={() => ask()}><span className="agent-orb" aria-hidden="true" />Ask the agent<Icon name="arrow" /></button></div>
    </header>

    <main id="atlas-main" tabIndex={-1} className={`atlas-workspace mobile-${mobileView} view-${view}`}>
      <aside className="city-index" aria-label="City explorer">
        <div className="index-heading"><div><p className="micro-label">YOUR STARTING POINT</p><h2>Find a place.</h2></div><span className="index-count">{cities.length}</span></div>
        <div className="city-search"><Icon name="search" /><input ref={searchRef} id="city-search" aria-label="Search Canadian cities" placeholder="Search cities" value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></div>
        <details className="filter-disclosure"><summary><Icon name="filter" />Median price ceiling<span>{ceiling === 2_000_000 ? "Any price" : compactMoney(ceiling)}<Icon name="chevron" /></span></summary><div className="filter-content"><label htmlFor="ceiling">Show cities with a median up to <strong>{ceiling === 2_000_000 ? "any price" : money(ceiling)}</strong></label><input id="ceiling" type="range" min="300000" max="2000000" step="50000" value={ceiling} onChange={event => setCeiling(Number(event.target.value))} /><div><span>$300k</span><span>Any price</span></div><p>Filters city medians, not individual listings.</p></div></details>
        <div className="index-toolbar"><span aria-live="polite">{visible.length} {visible.length === 1 ? "city" : "cities"}</span><label className="sr-only" htmlFor="sort">Sort cities</label><select id="sort" value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="featured">Featured first</option><option value="name">City A–Z</option><option value="low">Lowest median</option><option value="high">Highest median</option></select></div>
        <div className="city-list">
          {visible.length === 0 ? <div className="no-cities"><h3>No cities match.</h3><p>Try another name or a higher median price.</p><button onClick={() => { setQuery(""); setCeiling(2_000_000); }}>Clear filters</button></div> : visible.map(city => <div key={city} className={`city-row${selected === city ? " selected" : ""}`}>
            <button className="city-row-main" aria-pressed={selected === city} onClick={() => selectCity(city)}><span className="row-dot" /><span className="row-city"><strong>{cityName(city)}</strong><span>{summary.cities[city].count.toLocaleString("en-CA")} sampled listings</span></span><span className="row-price">{compactMoney(summary.cities[city].medianPrice)}<small>median</small></span></button>
            <button className="row-compare" onClick={() => compareCity(city)} aria-label={`Compare ${cityName(city)}`} title={`Compare ${cityName(city)}`}><Icon name="compare" /></button>
          </div>)}
        </div>
        <div className="index-footer"><span className="sample-dot" /><span><strong>{summary.totals.rows.toLocaleString("en-CA")} listings</strong> in the sample<small>Built {built} · Asking prices in CAD</small></span><button className="index-about" aria-label="About this dataset" onClick={() => aboutDialog.current?.showModal()}><Icon name="info" /></button>{activeFilter ? <button onClick={() => { setQuery(""); setCeiling(2_000_000); }} aria-label="Clear city filters"><Icon name="close" /></button> : null}</div>
      </aside>

      <section className="atlas-main" aria-label={view === "explore" ? "Canada housing map" : view === "compare" ? "City comparison" : "Source data"}>
        {view === "explore" ? <MapCanvas cities={summary.cities} visible={visible} selected={selected} compared={pair} onSelect={selectCity}>
          {visible.includes(selected) ? <section className="city-tray" aria-label={`${cityName(selected)} city details`}>
            <div className="tray-heading"><span className="micro-label"><span className="selection-dot" />SELECTED CITY</span><span className="tray-tabs" role="group" aria-label="City details view"><button aria-pressed={detailView === "overview"} onClick={() => setDetailView("overview")} aria-label="City overview"><Icon name="list" /></button><button aria-pressed={detailView === "beds"} onClick={() => setDetailView("beds")} aria-label="Bedroom prices"><Icon name="chart" /></button></span></div>
            <h2>{cityName(selected)}</h2>
            {detailView === "overview" ? <div className="tray-content" key={`${selected}-overview`}><p className="tray-price">{money(snap.medianPrice)}<span>median asking price</span></p><div className="tray-stats"><span><strong>{snap.count.toLocaleString("en-CA")}</strong>sampled listings</span><span><strong>{Math.round(snap.shareUnder1M * 100)}%</strong>asking under $1m</span></div></div> : <div className="tray-content tray-bedrooms" key={`${selected}-beds`}><p>Median asking price by bedroom count</p>{Object.entries(snap.medianByBeds).map(([bed, price]) => <div key={bed}><span>{bed} bed</span><span className="mini-track"><i style={{ width: `${price === null ? 0 : price / Math.max(...Object.values(snap.medianByBeds).map(value => value ?? 0)) * 100}%` }} /></span><strong>{price === null ? "No data" : compactMoney(price)}</strong></div>)}</div>}
            <div className="tray-actions"><button onClick={() => compareCity(selected)}><Icon name="compare" />Compare</button><button onClick={() => ask(`Give me a market snapshot of ${cityName(selected)}`)}>Ask about this city<Icon name="arrow" /></button></div>
          </section> : <div className="map-filter-message"><strong>{visible.length ? "Choose a city to explore." : "No cities match your filters."}</strong><span>Select a visible map marker or clear your search.</span><button onClick={() => { setQuery(""); setCeiling(2_000_000); }}>Clear filters</button></div>}
        </MapCanvas> : view === "compare" ? <Comparison cities={summary.cities} pair={pair} setPair={setPair} onAsk={() => ask(`Compare ${cityName(pair[0])} and ${cityName(pair[1])}`)} /> : <DataTable cities={cities} city={selected} onCityChange={setSelected} totalRows={summary.totals.rows} />}
      </section>
      <div className="mobile-view-switch" role="group" aria-label="Mobile explorer view"><button aria-pressed={mobileView === "map" && view !== "data"} onClick={() => { if (view === "data") setView("explore"); setMobileView("map"); }}><Icon name="map" />{view === "compare" ? "Comparison" : "Map"}</button><button aria-pressed={mobileView === "list"} onClick={() => setMobileView("list")}><Icon name="list" />Cities</button><button aria-pressed={view === "data" && mobileView === "map"} onClick={() => { setView("data"); setMobileView("map"); }}><Icon name="database" />Data</button></div>
    </main>

    <dialog className="agent-dialog" ref={agentDialog} aria-label="Housing research assistant" onClick={event => { if (event.target === event.currentTarget) agentDialog.current?.close(); }}>
      <div className="dialog-top"><span><span className="agent-orb" />Housing research</span><button aria-label="Close agent" onClick={() => agentDialog.current?.close()}><Icon name="close" /></button></div>
      <Chat offline={offline} draft={draft} />
    </dialog>
    <dialog className="about-dialog" ref={aboutDialog} aria-labelledby="about-title" onClick={event => { if (event.target === event.currentTarget) aboutDialog.current?.close(); }}>
      <div className="dialog-top"><span>About the atlas</span><button aria-label="Close dataset information" onClick={() => aboutDialog.current?.close()}><Icon name="close" /></button></div>
      <div className="about-content"><p className="micro-label">CANADA HOUSING AGENT</p><h2 id="about-title">A sample of what’s asking.</h2><p>Explore {summary.totals.rows.toLocaleString("en-CA")} for-sale listings across {cities.length} Canadian cities. This is a research sample of public for-sale listing data. Prices are asking prices in Canadian dollars, not sale prices or valuations.</p><dl><div><dt>Sample built</dt><dd>{new Date(summary.generated_at).toLocaleDateString("en-CA", { dateStyle: "long", timeZone: "UTC" })} UTC</dd></div><div><dt>Source</dt><dd>Zillow research sample</dd></div><div><dt>Coverage</dt><dd>Varies by city. This is not the entire market.</dd></div></dl><p>Each card links to the source listing. Map points locate cities, not properties. The agent’s numbers come from searches and statistics over this sample.</p>{offline ? <p className="about-offline">Offline demo: answers are scripted. Budget filters and follow-up reasoning require the live model.</p> : null}<p className="about-legal">Not affiliated with Zillow, REALTOR.ca, or any brokerage. Not financial or investment advice. Geography: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a> and <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> (CC BY).</p></div>
    </dialog>
  </div>;
}

function Comparison({ cities, pair, setPair, onAsk }: { cities: Record<string, CitySummary>; pair: [string, string]; setPair: (value: [string, string]) => void; onAsk: () => void }) {
  const [first, second] = pair.map(city => cities[city]);
  const difference = Math.abs(first.medianPrice - second.medianPrice);
  const lower = first.medianPrice <= second.medianPrice ? pair[0] : pair[1];
  const beds = ["1", "2", "3", "4", "5+"];
  const max = Math.max(1, ...pair.flatMap(city => beds.map(bed => cities[city].medianByBeds[bed] ?? 0)));

  return <div className="comparison-view">
    <div className="comparison-heading"><div><p className="micro-label">SIDE BY SIDE</p><h1>Two places.<br /><span>A different picture.</span></h1></div><Icon name="compare" /></div>
    <div className="comparison-selectors">{pair.map((city, index) => <div key={index}><label htmlFor={`compare-${index}`}><span className={`compare-dot dot-${index}`} />City {index + 1}</label><select id={`compare-${index}`} value={city} onChange={event => setPair(index === 0 ? [event.target.value, pair[1]] : [pair[0], event.target.value])}>{Object.keys(cities).sort().map(slug => <option key={slug} value={slug} disabled={slug === pair[1 - index]}>{cityName(slug)}</option>)}</select><div className="comparison-price">{money(cities[city].medianPrice)}</div><p>Median asking price · {cities[city].count.toLocaleString("en-CA")} listings</p></div>)}</div>
    <div className="comparison-insight"><Icon name="compare" /><p>{difference ? <><strong>{money(difference)} lower</strong> median asking price in {cityName(lower)}.</> : "These cities have the same median asking price in this sample."}</p></div>
    <div className="comparison-chart"><div className="comparison-chart-heading"><h2>What changes with another bedroom?</h2><span>MEDIAN ASKING PRICE · CAD</span></div><div className="comparison-legend">{pair.map((city, index) => <span key={city}><i className={`compare-dot dot-${index}`} />{cityName(city)}</span>)}</div>{beds.map(bed => <div className="comparison-bed-row" key={bed}><span>{bed}<small>{bed === "1" ? "bedroom" : "bedrooms"}</small></span><div>{pair.map((city, index) => { const price = cities[city].medianByBeds[bed]; return <div className="comparison-bar-line" key={city}><div className="comparison-bar-track"><span className={`bar-${index}`} style={{ width: `${price === null || price === undefined ? 0 : price / max * 100}%` }} /></div><strong>{price === null || price === undefined ? "No data" : money(price)}</strong></div>; })}</div></div>)}</div>
    <div className="comparison-footer"><p>All sampled property types. Different mixes of listings can affect city medians.</p><button className="agent-trigger" onClick={onAsk}>Ask about this comparison<Icon name="arrow" /></button></div>
  </div>;
}
