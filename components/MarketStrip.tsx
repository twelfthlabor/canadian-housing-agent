import summaryJson from "../data/market_summary.json";
import type { MarketSummary } from "../lib/types";
import Icon from "./Icon";

const summary = summaryJson as MarketSummary;

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default function MarketStrip() {
  const total = summary.totals?.rows;
  const cities = summary.totals?.cities;
  const generated = formatDate(summary.generated_at);

  const items = [
    {
      label: "sample listings",
      value: typeof total === "number" ? total.toLocaleString("en-CA") : "n/a",
      title: "Listings in the research sample",
    },
    {
      label: "Canadian cities",
      value: typeof cities === "number" ? cities.toLocaleString("en-CA") : "n/a",
      title: "Cities covered",
    },
    {
      label: "sample built (UTC)",
      value: generated ?? "n/a",
      title: "When the sample summary was generated",
    },
  ];

  return (
    <section className="market-strip" aria-label="Dataset summary">
      {items.map((item) => (
        <div className="strip-item" key={item.label} title={item.title}>
          <span className="strip-value">{item.value}</span>
          <span className="strip-label">{item.label}</span>
        </div>
      ))}
      <div className="strip-source"><Icon name="database" /><span>Public listing sample<span className="source-detail">Asking prices in CAD</span></span></div>
    </section>
  );
}
