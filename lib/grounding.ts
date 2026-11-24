/**
 * Runtime check that the figures in an answer trace back to this turn's tool
 * results or to the conversation itself. The agent runs it on every final
 * answer; the eval harness reuses the same extraction and matching.
 */

export type Extracted = { value: number; kind: "money" | "percent" | "plain"; raw: string };

export type GroundingResult = { checked: number; ungrounded: string[] };

function parseNumberString(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function suffixMultiplier(suffix?: string): number {
  switch (suffix?.toLowerCase()) {
    case "k":
    case "thousand":
      return 1e3;
    case "m":
    case "million":
      return 1e6;
    case "bn":
    case "billion":
      return 1e9;
    default:
      return 1;
  }
}

const NUMBER_PATTERN =
  /(?<![\w.])(?:(\$|CAD)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(billion|million|thousand|bn|k|m)\b)?(?:\s*(%|percent\b|per cent\b|CAD\b))?/gi;

export function extractNumbers(text: string): Extracted[] {
  const out: Extracted[] = [];
  // One pass keeps a currency amount from also becoming a plain count.
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const value = parseNumberString(match[2]) * suffixMultiplier(match[3]);
    if (!Number.isFinite(value)) continue;
    const kind = match[4] && match[4].toLowerCase() !== "cad"
      ? "percent"
      : match[1] || match[3] || match[4] ? "money" : "plain";
    out.push({ value, kind, raw: match[0].trim() });
  }
  return out;
}

export function collectGroundTruth(value: unknown, into: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.push(value);
    if (value > 0 && value <= 1) into.push(value * 100); // shares quoted as percentages
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) into.push(parseNumberString(m[0]));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGroundTruth(item, into);
    return;
  }
  if (value && typeof value === "object") {
    // shareUnder1M is defined against the $1M threshold; treat that threshold as grounded.
    const record = value as Record<string, unknown>;
    if (typeof record.shareUnder1M === "number" && Number.isFinite(record.shareUnder1M)) {
      into.push(1_000_000);
    }
    for (const [key, item] of Object.entries(record)) {
      // Postal digits, street numbers and zpid strings are not price evidence.
      if (key === "address" || key === "url") continue;
      collectGroundTruth(item, into);
    }
  }
}

/** Street numbers and postal digits from listing addresses: they may appear as plain numbers only. */
function collectAddressNumbers(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAddressNumbers(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "address" && typeof item === "string") {
        for (const m of item.matchAll(/\d+/g)) into.push(Number(m[0]));
      } else {
        collectAddressNumbers(item, into);
      }
    }
  }
}

/** Half a unit of the last digit the answer quotes: "$1.3 million" covers 1.25M-1.35M. */
function quotedPrecision(raw: string, value: number): number {
  const match = /(\d[\d,]*)(?:\.(\d+))?\s*(billion|million|thousand|bn|k|m)?/i.exec(raw);
  if (!match) return 0;
  const decimals = match[2]?.length ?? 0;
  return value === 0 ? 0 : (suffixMultiplier(match[3]) * 10 ** -decimals) / 2;
}

export function isGrounded(number: Extracted, grounded: number[]): boolean {
  const precision = quotedPrecision(number.raw, number.value);
  return grounded.some((g) => {
    const tolerance = Math.max(Math.abs(number.value) * 0.01, Math.abs(g) * 0.01, precision, 0.01);
    return Math.abs(g - number.value) <= tolerance;
  });
}

/** Figures worth checking: money, percentages and plain counts of 100 or more that are not years. */
export function checkedFigures(text: string): Extracted[] {
  return extractNumbers(text).filter((n) => {
    if (n.kind !== "plain") return true;
    // A year is a bare four-digit number; "1,910 listings" is a count.
    const year = /^\d{4}$/.test(n.raw) && n.value >= 1900 && n.value <= 2100;
    return Number.isInteger(n.value) && n.value >= 100 && !year;
  });
}

type ListingRef = { street: string; truth: number[] };

/** Street part of an address, lower-cased, without unit numbers or punctuation: "11 pirie dr". */
function streetKey(text: string): string {
  return text.toLowerCase().replace(/#\s*\w+|\bunit\s+\w+/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Each listing in the tool results with the numbers that belong to it alone. */
function collectListings(value: unknown, into: ListingRef[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectListings(item, into);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.address === "string") {
      const street = streetKey(record.address.split(",")[0]);
      const truth: number[] = [];
      collectGroundTruth(record, truth);
      if (street) into.push({ street, truth });
      return;
    }
    for (const item of Object.values(record)) collectListings(item, into);
  }
}

/** Numbers outside any listing: counts, thresholds and city statistics shared by the whole answer. */
function collectShared(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectShared(item, into);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.address === "string") return;
    for (const [key, item] of Object.entries(record)) {
      if (item && typeof item === "object") collectShared(item, into);
      else collectGroundTruth({ [key]: item }, into);
    }
  } else {
    collectGroundTruth(value, into);
  }
}

// Sentence breaks, except after street and estimate abbreviations ("Dr.", "est.").
const SENTENCE_BREAK = /(?<!\b(?:St|Dr|Rd|Ave|Blvd|Cres|Ct|Pl|Ln|Hwy|est|Est|approx|vs|No))(?<=[.!?])\s+(?=[A-Z0-9*])/;

export function checkGrounding(input: {
  answer: string;
  toolResults: unknown[];
  messages: string[];
}): GroundingResult {
  const shared: number[] = [];
  for (const result of input.toolResults) collectShared(result, shared);
  for (const message of input.messages) collectGroundTruth(message, shared);
  const listings: ListingRef[] = [];
  collectListings(input.toolResults, listings);
  const everything = [...shared, ...listings.flatMap((listing) => listing.truth)];
  const addressNumbers: number[] = [];
  collectAddressNumbers(input.toolResults, addressNumbers);

  let checked = 0;
  const ungrounded: string[] = [];
  // Listing URLs carry ids and slugs with digits; they are links, not figures.
  const text = input.answer.replace(/https?:\/\/\S+/g, " ");
  for (const segment of text.split("\n").flatMap((line) => line.split(SENTENCE_BREAK))) {
    // A segment that names a listing may only quote that listing's figures plus shared totals.
    const key = ` ${streetKey(segment)} `;
    const named = listings.filter((listing) => key.includes(` ${listing.street} `));
    const truth = named.length > 0 ? [...shared, ...named.flatMap((listing) => listing.truth)] : everything;
    const figures = checkedFigures(segment);
    checked += figures.length;
    for (const n of figures) {
      if (isGrounded(n, truth)) continue;
      if (n.kind === "plain" && addressNumbers.includes(n.value)) continue;
      ungrounded.push(n.raw);
    }
  }
  return { checked, ungrounded };
}
