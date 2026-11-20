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

export function checkGrounding(input: {
  answer: string;
  toolResults: unknown[];
  messages: string[];
}): GroundingResult {
  const grounded: number[] = [];
  for (const result of input.toolResults) collectGroundTruth(result, grounded);
  for (const message of input.messages) collectGroundTruth(message, grounded);
  const addressNumbers: number[] = [];
  collectAddressNumbers(input.toolResults, addressNumbers);

  // Listing URLs carry ids and slugs with digits; they are links, not figures.
  const figures = checkedFigures(input.answer.replace(/https?:\/\/\S+/g, " "));
  const ungrounded = figures
    .filter((n) => !isGrounded(n, grounded))
    .filter((n) => !(n.kind === "plain" && addressNumbers.includes(n.value)))
    .map((n) => n.raw);
  return { checked: figures.length, ungrounded };
}
