"use client";

import { useEffect, useMemo, useState } from "react";
import { computeMortgage, maxPriceForIncome, minDownPayment } from "@/lib/mortgage";
import CountUp from "./CountUp";
import Icon from "./Icon";
import MoneyInput from "./MoneyInput";
import { money } from "./format";

const AMORTIZATIONS = [20, 25, 30] as const;

/** Illustrative affordability: the same arithmetic as the mortgage_estimate agent tool. */
export default function MortgageCalculator({ citySlug, cityLabel, defaultPrice }: { citySlug: string; cityLabel: string; defaultPrice: number }) {
  const [priceText, setPriceText] = useState(String(Math.round(defaultPrice / 1000) * 1000));
  const [incomeText, setIncomeText] = useState("120000");
  const [listingsBelow, setListingsBelow] = useState<number | null>(null);
  const [downPct, setDownPct] = useState(20);
  const [ratePct, setRatePct] = useState(4.5);
  const [amortYears, setAmortYears] = useState<(typeof AMORTIZATIONS)[number]>(25);

  const price = Number(priceText);
  const result = useMemo(() => {
    try {
      return { value: computeMortgage({ price, downPct, ratePct, amortYears }), error: null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "Check the inputs." };
    }
  }, [price, downPct, ratePct, amortYears]);

  const income = Number(incomeText);
  const budget = useMemo(() => {
    if (!Number.isFinite(income) || income <= 0) return null;
    try {
      return maxPriceForIncome({ householdIncome: income, downPct, ratePct, amortYears });
    } catch {
      return null;
    }
  }, [income, downPct, ratePct, amortYears]);

  // How many sampled listings in this city a buyer could afford on the budget.
  useEffect(() => {
    if (budget === null) {
      setListingsBelow(0);
      return;
    }
    const controller = new AbortController();
    setListingsBelow(null);
    fetch(`/api/listings?city=${encodeURIComponent(citySlug)}&maxPrice=${budget}&limit=1`, { signal: controller.signal })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("request failed"))))
      .then((payload: { total?: number }) => setListingsBelow(typeof payload.total === "number" ? payload.total : 0))
      .catch(() => { if (!controller.signal.aborted) setListingsBelow(null); });
    return () => controller.abort();
  }, [budget, citySlug]);

  const minDown = price > 0 ? minDownPayment(price) : 0;
  const minDownPct = price > 0 ? Math.ceil((minDown / price) * 1000) / 10 : 0;
  const r = result.value;

  return <div className="mortgage">
    <div className="mortgage-inputs">
      <label className="mortgage-field">
        <span>Purchase price</span>
        <MoneyInput value={priceText} onChange={setPriceText} label="Purchase price" describedBy="mortgage-price-hint" />
        <small id="mortgage-price-hint">Starts at the {cityLabel} median asking price</small>
      </label>
      <label className="mortgage-field">
        <span>Down payment <strong>{downPct}%</strong></span>
        <input type="range" min={5} max={50} step={1} value={downPct} onChange={event => setDownPct(Number(event.target.value))} aria-valuetext={`${downPct} percent down`} />
        <small>At least {minDownPct}% ({money(minDown)}) under federal rules</small>
      </label>
      <label className="mortgage-field">
        <span>Contract rate <strong>{ratePct.toFixed(2)}%</strong></span>
        <input type="range" min={2} max={8} step={0.05} value={ratePct} onChange={event => setRatePct(Number(event.target.value))} aria-valuetext={`${ratePct.toFixed(2)} percent`} />
        <small>An assumption you can change, not a live rate</small>
      </label>
      <label className="mortgage-field">
        <span>Household income <small>before tax, per year</small></span>
        <MoneyInput value={incomeText} onChange={setIncomeText} label="Household income" describedBy="mortgage-income-hint" />
        <small id="mortgage-income-hint">Used for the budget check below. An example figure; replace it with yours.</small>
      </label>
      <div className="mortgage-field">
        <span>Amortization</span>
        <div className="segmented" role="group" aria-label="Amortization in years">
          {AMORTIZATIONS.map(years => <button key={years} aria-pressed={amortYears === years} onClick={() => setAmortYears(years)}>{years} yr</button>)}
        </div>
      </div>
    </div>

    <div className="mortgage-result" aria-live="polite">
      {r ? <>
        <p className="micro-label">ILLUSTRATIVE MONTHLY PAYMENT</p>
        <p className="mortgage-payment"><CountUp value={r.monthlyPayment} format={money} /><span className="mortgage-payment-unit">/ month</span></p>
        <dl className="mortgage-facts">
          <div><dt>Loan</dt><dd><CountUp value={r.insuredLoan} format={money} /></dd></div>
          <div><dt>Down payment</dt><dd>{money(r.downPayment)}</dd></div>
          <div><dt>CMHC premium</dt><dd>{r.insuranceRequired ? money(r.cmhcPremium) : "Not required"}</dd></div>
          <div><dt>Total interest</dt><dd>{money(r.totalInterest)}</dd></div>
        </dl>
        <div className="stress-card">
          <Icon name="shield" />
          <div>
            <strong>Stress test at {r.stressRatePct.toFixed(2)}%</strong>
            <p>Payment <CountUp value={r.stressMonthlyPayment} format={money} />/month. Needs about <strong>{money(r.incomeNeeded)}</strong> household income to stay under the 39% debt-service limit (tax at 1% and heat at $150/month assumed).</p>
          </div>
        </div>
      </> : <p className="mortgage-error" role="alert">{result.error}</p>}
      <div className="budget-card">
        <p className="micro-label">BUDGET CHECK</p>
        {budget === null ? <p>No price fits this income at these terms under the 39% limit.</p> : <>
          <p className="budget-price">Up to <CountUp value={budget} format={money} /></p>
          <p className="budget-listings">{listingsBelow === null ? "Counting sampled listings…" : listingsBelow === 0 ? `No sampled ${cityLabel} listings are at or below this price.` : <><strong><CountUp value={listingsBelow} /></strong> sampled {cityLabel} listings are at or below this price.</>}</p>
        </>}
      </div>
      <p className="mortgage-fineprint">Illustration only. Not a mortgage offer, pre-approval, or financial advice. Lenders set final terms, fees, and rates.</p>
    </div>
  </div>;
}
