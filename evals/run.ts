/**
 * Golden eval harness for the Canadian Housing Agent.
 *
 * Entry point: `runAgent()` from lib/agent.ts — the same async generator the
 * SSE route (app/api/chat/route.ts) consumes. The harness feeds it a provider
 * from lib/providers.ts and scores the emitted typed `AgentEvent`s, so it
 * exercises the real prompt, provider and tool loop without duplicating it
 * and without needing a Next request context.
 *
 * Cases are single-turn (`question`) or multi-turn (`turns`, 2-3 user turns).
 * Multi-turn cases call runAgent() once per user turn, appending each
 * assistant reply to the history before the next turn; only the final turn's
 * tool events and answer are scored, the first turn must use at least one
 * tool, and every turn's answer and tool names are recorded in the report.
 * `expect` may name one tool or `anyOf` alternatives; the case passes when any
 * alternative matches with the same arg rules.
 *
 * Modes:
 *   MOCK_LLM=1 npm run evals            # plumbing-only, no network, exit 0
 *   npm run evals                       # live, needs GROQ_API_KEY
 *   npm run evals -- --category numeric --limit 3
 *
 * Live mode is sequential with EVAL_DELAY_MS (default 2500ms) between cases to
 * respect free-tier rate limits. Live exit code is 1 unless
 *   tool_accuracy >= 0.9, numeric_accuracy >= 0.95, refusal_accuracy === 1.0.
 *
 * Scoring rules are documented in the `_doc` line of evals/cases.jsonl.
 * Numeric expectations are computed at runtime by calling lib/tools functions;
 * no dataset number is hardcoded.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runAgent } from "../lib/agent";
import type { AgentInputMessage } from "../lib/agent";
import { createMockProvider, getProvider } from "../lib/providers";
import type { Provider } from "../lib/providers";
import { TOOL_IMPLS, citySnapshot, searchListings } from "../lib/tools";
import type { CitySnapshot } from "../lib/types";

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

type Category = "tool_choice" | "numeric" | "scope_refusal";
type Unit = "cad" | "percent" | "count" | "sqft";

type NumericSource =
  | { kind: "snapshot_median"; city: string }
  | { kind: "snapshot_count"; city: string }
  | { kind: "snapshot_share_percent"; city: string }
  | { kind: "snapshot_median_sqft"; city: string }
  | { kind: "snapshot_median_by_beds"; city: string; beds: string }
  | { kind: "search_total"; city: string; beds?: number }
  | { kind: "cheapest_price"; city: string; beds?: number }
  | { kind: "priciest_price"; city: string };

type Check =
  | { type: "numeric"; source: NumericSource; unit?: Unit }
  | { type: "refusal"; patterns: string[]; forbid?: string[] };

/** One accepted tool call for `expect.anyOf`. */
type Expectation = { tool: string; args?: Record<string, unknown> };

type Expect = {
  tool?: string | null;
  args?: Record<string, unknown>;
  no_tool?: boolean;
  /** Alternatives: the case passes when any entry matches, same arg semantics as `tool`+`args`. */
  anyOf?: Expectation[];
};

type EvalCase = {
  id: string;
  category: Category;
  /** Single-turn case. Exactly one of question/turns is required. */
  question?: string;
  /** Multi-turn case: 2-3 user turns, scored on the final turn only. */
  turns?: string[];
  expect: Expect;
  checks: Check[];
  /** Recognition subject for the structural refusal check (scope_refusal cases). */
  limitation?: string;
  rationale?: string;
};

type ToolEvent = { name: string; args: Record<string, unknown> };

type TurnOutcome = {
  answer: string;
  toolEvents: ToolEvent[];
  error?: string;
};

type RunOutcome = TurnOutcome & {
  grounded: number[];
  /** Per-turn outcomes in order; set for multi-turn cases, absent for single-turn. */
  turns?: TurnOutcome[];
};

/** One row per user turn in a multi-turn case report. */
type TurnReport = { answer: string; tools: string[]; error?: string };

type CaseReport = {
  id: string;
  category: Category;
  passed: boolean;
  detail: string;
  /** 1 for single-turn cases; 2-3 for multi-turn cases. */
  turnCount: number;
  answer: string;
  tool_events: ToolEvent[];
  /** Multi-turn cases only: answer, tool names and error for each user turn. */
  turns?: TurnReport[];
};

const CATEGORIES: Category[] = ["tool_choice", "numeric", "scope_refusal"];
const THRESHOLDS: Record<string, number> = {
  tool_accuracy: 0.9,
  numeric_accuracy: 0.95,
  refusal_accuracy: 1.0,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(here, "report.json");
const CASES_PATH = path.join(here, "cases.jsonl");

/* -------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------- */

type Flags = { limit?: number; category?: Category; mock: boolean; help: boolean };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { mock: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--mock") {
      flags.mock = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit expects a positive integer, got "${raw ?? ""}"`);
      flags.limit = n;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit expects a positive integer, got "${arg}"`);
      flags.limit = n;
      continue;
    }
    if (arg === "--category") {
      const raw = argv[++i];
      if (!CATEGORIES.includes(raw as Category)) {
        throw new Error(`--category expects one of ${CATEGORIES.join(", ")}, got "${raw ?? ""}"`);
      }
      flags.category = raw as Category;
      continue;
    }
    if (arg.startsWith("--category=")) {
      const raw = arg.slice("--category=".length);
      if (!CATEGORIES.includes(raw as Category)) {
        throw new Error(`--category expects one of ${CATEGORIES.join(", ")}, got "${raw}"`);
      }
      flags.category = raw as Category;
      continue;
    }
    throw new Error(`unknown flag "${arg}" (see --help)`);
  }
  return flags;
}

function usage(): void {
  console.log(`Golden eval harness for the Canadian Housing Agent.

  MOCK_LLM=1 npm run evals                     plumbing-only, no network, exit 0
  npm run evals                                live, needs GROQ_API_KEY
  npm run evals -- --category numeric          run one category
  npm run evals -- --limit 5                   run the first N cases
  npm run evals -- --mock                      force the mock provider

Env:
  GROQ_API_KEY     required for live mode
  MOCK_LLM=1       use the deterministic mock provider
  EVAL_DELAY_MS    delay between live cases (default 2500)

Output: evals/report.json`);
}

/* -------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------- */

/** The user turns of a case: question becomes a one-turn run. */
export function caseTurns(c: EvalCase): string[] {
  if (c.turns) return c.turns;
  return c.question ? [c.question] : [];
}

/** Parse one JSONL line. Null for blank lines and the `_doc` header; throws on invalid cases. */
export function parseCaseLine(line: string, where: string): EvalCase | null {
  if (!line.trim()) return null;
  const parsed = JSON.parse(line) as Partial<EvalCase> & { _doc?: unknown };
  if (parsed._doc) return null;
  if (!parsed.id || !parsed.category || !parsed.expect) {
    throw new Error(`${where}: missing required fields`);
  }
  if (parsed.question !== undefined && parsed.turns !== undefined) {
    throw new Error(`${where}: use either question or turns, not both`);
  }
  if (parsed.question !== undefined) {
    if (typeof parsed.question !== "string" || parsed.question.trim() === "") {
      throw new Error(`${where}: question must be a non-empty string`);
    }
  } else if (parsed.turns !== undefined) {
    if (!Array.isArray(parsed.turns) || parsed.turns.length < 2 || parsed.turns.length > 3) {
      throw new Error(`${where}: turns must be an array of 2-3 user turns`);
    }
    if (parsed.turns.some((turn) => typeof turn !== "string" || turn.trim() === "")) {
      throw new Error(`${where}: turns must be non-empty strings`);
    }
  } else {
    throw new Error(`${where}: exactly one of question or turns is required`);
  }
  if (!CATEGORIES.includes(parsed.category)) {
    throw new Error(`${where}: unknown category "${parsed.category}"`);
  }
  const expect = parsed.expect as Expect;
  if (expect.anyOf !== undefined) {
    if (expect.tool !== undefined || expect.no_tool !== undefined) {
      throw new Error(`${where}: expect.anyOf cannot be combined with expect.tool or expect.no_tool`);
    }
    if (!Array.isArray(expect.anyOf) || expect.anyOf.length === 0) {
      throw new Error(`${where}: expect.anyOf must be a non-empty array`);
    }
    for (const alternative of expect.anyOf) {
      if (!alternative || typeof alternative.tool !== "string") {
        throw new Error(`${where}: every expect.anyOf entry needs a string tool`);
      }
      if (
        alternative.args !== undefined &&
        (typeof alternative.args !== "object" || alternative.args === null || Array.isArray(alternative.args))
      ) {
        throw new Error(`${where}: expect.anyOf args must be an object`);
      }
    }
  } else if (typeof expect.tool !== "string" && expect.tool !== null) {
    throw new Error(`${where}: expect.tool must be a string or null`);
  }
  if (parsed.category === "scope_refusal" && typeof parsed.limitation !== "string") {
    throw new Error(`${where}: scope_refusal case needs a limitation regex`);
  }
  return parsed as EvalCase;
}

export function loadCases(): EvalCase[] {
  const lines = readFileSync(CASES_PATH, "utf8").split("\n");
  const cases: EvalCase[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseCaseLine(line, `evals/cases.jsonl line ${index + 1}`);
    if (parsed) cases.push(parsed);
  }
  return cases;
}

/* -------------------------------------------------------------------------
 * Numeric ground truth (resolved at runtime through lib/tools)
 * ---------------------------------------------------------------------- */

type Resolved = { value: number; unit: Unit; label: string };

function requireSnapshot(city: string, what: string): CitySnapshot {
  const snapshot = citySnapshot(city);
  if (!snapshot) throw new Error(`${what}: unknown city "${city}"`);
  return snapshot;
}

function resolveExpected(source: NumericSource): Resolved {
  switch (source.kind) {
    case "snapshot_median": {
      const s = requireSnapshot(source.city, source.kind);
      return { value: s.medianPrice, unit: "cad", label: `${source.city} medianPrice` };
    }
    case "snapshot_count": {
      const s = requireSnapshot(source.city, source.kind);
      return { value: s.count, unit: "count", label: `${source.city} count` };
    }
    case "snapshot_share_percent": {
      const s = requireSnapshot(source.city, source.kind);
      return { value: s.shareUnder1M * 100, unit: "percent", label: `${source.city} shareUnder1M` };
    }
    case "snapshot_median_sqft": {
      const s = requireSnapshot(source.city, source.kind);
      if (s.medianSqft === null) throw new Error(`${source.kind}: ${source.city} medianSqft is null`);
      return { value: s.medianSqft, unit: "sqft", label: `${source.city} medianSqft` };
    }
    case "snapshot_median_by_beds": {
      const s = requireSnapshot(source.city, source.kind);
      const value = s.medianByBeds[source.beds];
      if (value === null || value === undefined) {
        throw new Error(`${source.kind}: ${source.city} has no median for ${source.beds} beds`);
      }
      return { value, unit: "cad", label: `${source.city} medianByBeds[${source.beds}]` };
    }
    case "search_total": {
      const result = searchListings({ city: source.city, beds: source.beds });
      return { value: result.totalMatches, unit: "count", label: `${source.city} search totalMatches` };
    }
    case "cheapest_price": {
      const result = searchListings({ city: source.city, beds: source.beds, limit: 1 });
      const first = result.listings[0];
      if (!first) throw new Error(`${source.kind}: no listings matched in ${source.city}`);
      return { value: first.price, unit: "cad", label: `${source.city} cheapest price` };
    }
    case "priciest_price": {
      const result = searchListings({ city: source.city, sort: "price_desc", limit: 1 });
      const first = result.listings[0];
      if (!first) throw new Error(`${source.kind}: no listings matched in ${source.city}`);
      return { value: first.price, unit: "cad", label: `${source.city} priciest price` };
    }
  }
}

/* -------------------------------------------------------------------------
 * Answer number extraction and matching
 * ---------------------------------------------------------------------- */

type Extracted = { value: number; kind: "money" | "percent" | "plain"; raw: string };

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

function extractNumbers(text: string): Extracted[] {
  const out: Extracted[] = [];
  // One pass keeps a currency amount from also becoming a plain count.
  const pattern = /(?<![\w.])(?:(\$|CAD)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(billion|million|thousand|bn|k|m)\b)?(?:\s*(%|percent\b|per cent\b|CAD\b))?/gi;
  for (const match of text.matchAll(pattern)) {
    const value = parseNumberString(match[2]) * suffixMultiplier(match[3]);
    if (!Number.isFinite(value)) continue;
    const kind = match[4] && match[4].toLowerCase() !== "cad"
      ? "percent"
      : match[1] || match[3] || match[4] ? "money" : "plain";
    out.push({ value, kind, raw: match[0] });
  }
  return out;
}

/** Counts exact; percent within 1 percentage point; prices/sqft within 1% relative. */
function numericMatches(expected: number, unit: Unit, nums: Extracted[]): boolean {
  if (unit === "count") {
    return nums.some((n) => n.kind === "plain" && Number.isInteger(n.value) && Math.abs(n.value - expected) < 1e-9);
  }
  if (unit === "percent") {
    const tolerance = Math.max(Math.abs(expected) * 0.01, 1);
    return nums.some((n) => n.kind === "percent" && Math.abs(n.value - expected) <= tolerance);
  }
  const tolerance = Math.abs(expected) * 0.01;
  return nums.some((n) => n.kind !== "percent" && Math.abs(n.value - expected) <= tolerance);
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

function isGrounded(value: number, grounded: number[]): boolean {
  return grounded.some((g) => {
    const tolerance = Math.max(Math.abs(value) * 0.01, Math.abs(g) * 0.01, 0.01);
    return Math.abs(g - value) <= tolerance;
  });
}

/* -------------------------------------------------------------------------
 * Checks
 * ---------------------------------------------------------------------- */

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[._\u2010\u2011-]+/g, " ")
    .replace(/\s+/g, " ");
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    // Match TOOL_IMPLS coercion: "800k" and "$800,000" are not valid bounds.
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function argValueMatches(expected: unknown, actual: unknown, key: string): boolean {
  if (typeof expected === "string") return normalizeText(actual) === normalizeText(expected);
  if (typeof expected === "number") {
    const got = asFiniteNumber(actual);
    if (got === undefined) return false;
    return key === "minPrice" || key === "maxPrice"
      ? Math.abs(got - expected) <= Math.abs(expected) * 0.01
      : got === expected;
  }
  if (Array.isArray(expected)) {
    const actualList = Array.isArray(actual) ? actual : actual === undefined || actual === null ? [] : [actual];
    const want = expected.map(normalizeText).sort();
    const got = actualList.map(normalizeText).sort();
    return want.length === got.length && want.every((value, i) => value === got[i]);
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export function expectedArgsFailure(
  args: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const got = actual ?? {};
  for (const [key, expected] of Object.entries(args)) {
    if (!(key in got)) return `missing arg ${key}=${JSON.stringify(expected)}`;
    if (!argValueMatches(expected, got[key], key)) {
      return `arg ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got[key])}`;
    }
  }
  return null;
}

type RefusalResult = { failures: string[]; matched?: string; structural?: boolean };

/** Shared decline-marker family for the structural refusal check. */
const DECLINE_MARKER_SOURCE =
  "\\b(can't|cannot|can not|unable|not able|won't|will not|does not|doesn't|do not|don't|no|only)\\b";

/**
 * Structural decline: a decline marker and the case's limitation subject within
 * 100 characters of each other, in either order. Complements the phrase patterns
 * so a correct decline with new wording does not need a new regex per run.
 */
function structuralDecline(haystack: string, limitation: string): boolean {
  const spans = (regex: RegExp): Array<[number, number]> =>
    [...haystack.matchAll(regex)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const markers = spans(new RegExp(DECLINE_MARKER_SOURCE, "gi"));
  const subjects = spans(new RegExp(limitation, "gi"));
  for (const [markerStart, markerEnd] of markers) {
    for (const [subjectStart, subjectEnd] of subjects) {
      const gap =
        markerStart >= subjectEnd
          ? markerStart - subjectEnd
          : subjectStart >= markerEnd
            ? subjectStart - markerEnd
            : 0; // overlapping counts as adjacent
      if (gap <= 100) return true;
    }
  }
  return false;
}

function evaluateRefusal(
  check: Extract<Check, { type: "refusal" }>,
  answer: string,
  grounded: number[],
  limitation?: string,
): RefusalResult {
  const failures: string[] = [];
  // Fold typographic apostrophes to ASCII and treat hyphens as spaces so phrase
  // patterns match "sold price", "sold-price" and "sold\u2011price" alike.
  const haystack = answer.replace(/[\u2018\u2019]/g, "'").replace(/[\u2010\u2011-]/g, " ");
  const patterns = check.patterns.map((pattern) => new RegExp(pattern, "i"));
  const matched = patterns.find((pattern) => pattern.test(haystack));
  const structural = !matched && Boolean(limitation) && structuralDecline(haystack, limitation as string);
  if (!matched && !structural) failures.push("no refusal phrase matched");

  for (const raw of check.forbid ?? []) {
    if (new RegExp(raw, "i").test(haystack)) failures.push(`forbidden phrase /${raw}/`);
  }

  const ungrounded = extractNumbers(answer).filter((n) => {
    if (n.kind !== "plain") return !isGrounded(n.value, grounded);
    // Plain integers >= 10k read as prices; years 1900-2100 never do.
    const priceLike = Number.isInteger(n.value) && n.value >= 10_000 && !(n.value >= 1900 && n.value <= 2100);
    return priceLike && !isGrounded(n.value, grounded);
  });
  for (const number of ungrounded.slice(0, 3)) failures.push(`ungrounded number "${number.raw.trim()}"`);

  return { failures, matched: matched?.source, structural };
}

async function collectTurn(messages: AgentInputMessage[], provider: Provider): Promise<RunOutcome> {
  const toolEvents: RunOutcome["toolEvents"] = [];
  const grounded: number[] = [];
  let answer = "";
  let error: string | undefined;

  try {
    for await (const event of runAgent({ messages, provider })) {
      if (event.type === "text") answer += event.delta;
      else if (event.type === "tool") {
        toolEvents.push({ name: event.name, args: event.args });
        const impl = TOOL_IMPLS[event.name];
        if (typeof impl === "function") {
          try {
            collectGroundTruth(impl(event.args), grounded);
          } catch {
            // Ground truth unavailable for this call; other events still count.
          }
        }
      } else if (event.type === "tool_result") {
        collectGroundTruth(event.summary, grounded);
      } else if (event.type === "error") {
        error = event.message;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { answer: answer.trim(), toolEvents, grounded, error };
}

/**
 * Run one case. Single-turn cases pass exactly one user message. Multi-turn
 * cases run sequentially, appending each assistant reply to the history before
 * the next user turn; only the final turn's outcome is scored, and every
 * earlier turn's outcome is kept for the report.
 */
export async function runAgentCase(c: EvalCase, provider: Provider): Promise<RunOutcome> {
  const turns = caseTurns(c);
  if (turns.length === 1) {
    return collectTurn([{ role: "user", content: turns[0] }], provider);
  }

  const history: AgentInputMessage[] = [];
  const turnOutcomes: TurnOutcome[] = [];
  let outcome: RunOutcome | undefined;
  for (const turn of turns) {
    history.push({ role: "user", content: turn });
    outcome = await collectTurn(history, provider);
    turnOutcomes.push({ answer: outcome.answer, toolEvents: outcome.toolEvents, error: outcome.error });
    if (outcome.answer) history.push({ role: "assistant", content: outcome.answer });
  }
  return { ...(outcome as RunOutcome), turns: turnOutcomes };
}

function formatValue(value: number, unit: Unit): string {
  if (unit === "percent") return `${Math.round(value * 100) / 100}%`;
  if (unit === "count") return String(value);
  if (unit === "sqft") return `${value.toLocaleString("en-CA")} sqft`;
  return `$${Math.round(value).toLocaleString("en-CA")}`;
}

/** Match one expectation against the turn's tool events. Any call with the tool name may satisfy it. */
function matchExpectation(expectation: Expectation, toolEvents: ToolEvent[]): { note?: string; failure?: string } {
  if (toolEvents.length === 0) return { failure: `tool: expected ${expectation.tool}, no tool called` };
  const named = toolEvents.filter((event) => event.name === expectation.tool);
  if (named.length === 0) {
    return { failure: `tool: expected ${expectation.tool}, got ${toolEvents.map((event) => event.name).join(", ")}` };
  }
  const passing = named.find((event) => expectedArgsFailure(expectation.args, event.args) === null);
  if (passing) {
    const args = JSON.stringify(passing.args);
    return { note: `tool ${passing.name}${args !== "{}" ? ` ${args.slice(0, 100)}` : ""}` };
  }
  return {
    failure: `tool args: ${expectedArgsFailure(expectation.args, named[0].args) ?? "no call satisfied expect.args"}`,
  };
}

export function evaluateCaseOutcome(c: EvalCase, outcome: RunOutcome): { passed: boolean; detail: string } {
  const failures: string[] = [];
  const notes: string[] = [];

  if (outcome.error) failures.push(`error: ${outcome.error}`);
  if (!outcome.answer) failures.push("empty answer");
  // A multi-turn run whose first answer was ungrounded is not evidence of thread handling.
  if (outcome.turns && outcome.turns.length > 0 && outcome.turns[0].toolEvents.length === 0) {
    failures.push("first turn used no tool");
  }

  if (outcome.answer) {
    if (c.category === "tool_choice") {
      // A tool-limit/budget notice is the loop giving up, not an answer.
      if (/\b(tool limit|budget exhausted|reached the tool)\b/i.test(outcome.answer)) {
        failures.push("hollow turn: tool-limit or budget notice instead of an answer");
      }
      if (c.expect.no_tool) {
        if (outcome.toolEvents.length > 0) failures.push(`no_tool expected, got ${outcome.toolEvents[0].name}`);
        else notes.push("no tool (as expected)");
      } else {
        const alternatives: Expectation[] = c.expect.anyOf?.length
          ? c.expect.anyOf
          : c.expect.tool
            ? [{ tool: c.expect.tool, args: c.expect.args }]
            : [];
        if (alternatives.length > 0) {
          const results = alternatives.map((alternative) => matchExpectation(alternative, outcome.toolEvents));
          const passing = results.find((result) => result.note);
          if (passing?.note) notes.push(passing.note);
          else if (alternatives.length === 1) failures.push(results[0].failure ?? "tool expectation failed");
          else {
            const reasons = results.map((result) => result.failure).filter((reason): reason is string => Boolean(reason));
            failures.push(`tool: no alternative matched (${reasons.join("; ")})`);
          }
        }
      }
    }

    for (const check of c.checks) {
      if (check.type === "numeric") {
        let resolved: Resolved;
        try {
          resolved = resolveExpected(check.source);
        } catch (err) {
          failures.push(`ground truth: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (outcome.toolEvents.length === 0 || !isGrounded(resolved.value, outcome.grounded)) {
          failures.push(`numeric: ${resolved.label} was not grounded in a tool result`);
        }
        const unit = check.unit ?? resolved.unit;
        const ok = numericMatches(resolved.value, unit, extractNumbers(outcome.answer));
        if (ok) notes.push(`matched ${formatValue(resolved.value, unit)} (${resolved.label})`);
        else failures.push(`numeric: expected ${formatValue(resolved.value, unit)} (${resolved.label}) not found`);
      } else if (check.type === "refusal") {
        const result = evaluateRefusal(check, outcome.answer, outcome.grounded, c.limitation);
        failures.push(...result.failures);
        if (result.failures.length === 0) {
          notes.push(
            result.matched
              ? `refused (pattern: ${result.matched})`
              : "refused (structural: decline marker + limitation subject)",
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    return { passed: false, detail: failures.slice(0, 3).join("; ").slice(0, 300) };
  }
  return { passed: true, detail: notes.join("; ").slice(0, 300) || "ok" };
}

/* -------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------- */

/** One report row for one case; multi-turn cases carry the per-turn answers and tool names. */
export function buildCaseReport(c: EvalCase, outcome: RunOutcome): CaseReport {
  const { passed, detail } = evaluateCaseOutcome(c, outcome);
  const row: CaseReport = {
    id: c.id,
    category: c.category,
    passed,
    detail,
    turnCount: caseTurns(c).length,
    answer: outcome.answer,
    tool_events: outcome.toolEvents,
  };
  if (outcome.turns) {
    row.turns = outcome.turns.map((turn) => ({
      answer: turn.answer,
      tools: turn.toolEvents.map((event) => event.name),
      ...(turn.error ? { error: turn.error } : {}),
    }));
  }
  return row;
}

type EvalReport = {
  complete_suite: boolean;
  quality_gate_passed: boolean;
  mode: "mock" | "live";
  plumbing_only: boolean;
  provider: string;
  started_at: string;
  finished_at: string;
  totals: {
    cases: number;
    passed: number;
    failed: number;
    pass_rate: number;
    by_category: Record<string, { cases: number; passed: number }>;
  };
  scores: { tool_accuracy: number | null; numeric_accuracy: number | null; refusal_accuracy: number | null };
  cases: CaseReport[];
};

function scoreOf(cases: CaseReport[], category: Category): number | null {
  const rows = cases.filter((row) => row.category === category);
  if (rows.length === 0) return null;
  return rows.filter((row) => row.passed).length / rows.length;
}

/**
 * Build the report from the cases scored so far. Used for both the incremental
 * writes during a run and the final write, so the file shape never changes.
 * `completeSuite` is true only when the full suite was selected and the run
 * reached the end; partial or in-progress reports cannot pass the gate.
 */
export function buildReport(
  cases: CaseReport[],
  options: { isMock: boolean; providerName: string; startedAt: Date; completeSuite: boolean },
): EvalReport {
  const scores = {
    tool_accuracy: scoreOf(cases, "tool_choice"),
    numeric_accuracy: scoreOf(cases, "numeric"),
    refusal_accuracy: scoreOf(cases, "scope_refusal"),
  };
  const passed = cases.filter((row) => row.passed).length;
  const totals = {
    cases: cases.length,
    passed,
    failed: cases.length - passed,
    pass_rate: cases.length ? passed / cases.length : 0,
    by_category: Object.fromEntries(
      CATEGORIES.map((category) => {
        const rows = cases.filter((row) => row.category === category);
        return [category, { cases: rows.length, passed: rows.filter((row) => row.passed).length }];
      }),
    ),
  };

  return {
    complete_suite: options.completeSuite,
    quality_gate_passed: qualityGatePassed(scores, options.isMock, options.completeSuite),
    mode: options.isMock ? "mock" : "live",
    plumbing_only: options.isMock,
    provider: options.providerName,
    started_at: options.startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    totals,
    scores,
    cases,
  };
}

/** Atomic write: a hard kill mid-write leaves the previous report, never a truncated one. */
function writeReport(report: EvalReport): void {
  const tmp = `${REPORT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, REPORT_PATH);
}

export function qualityGatePassed(
  scores: { tool_accuracy: number | null; numeric_accuracy: number | null; refusal_accuracy: number | null },
  isMock: boolean,
  completeSuite: boolean,
): boolean {
  return !isMock && completeSuite && Object.entries(THRESHOLDS).every(([key, minimum]) => {
    const score = scores[key as keyof typeof scores];
    return score !== null && score >= minimum;
  });
}

function printTable(cases: CaseReport[]): void {
  const idWidth = Math.max(2, ...cases.map((row) => row.id.length));
  const categoryWidth = Math.max(8, ...cases.map((row) => row.category.length));
  console.log(`${"id".padEnd(idWidth)}  ${"category".padEnd(categoryWidth)}  result  reason`);
  console.log(`${"-".repeat(idWidth)}  ${"-".repeat(categoryWidth)}  ------  ------`);
  for (const row of cases) {
    console.log(
      `${row.id.padEnd(idWidth)}  ${row.category.padEnd(categoryWidth)}  ${(row.passed ? "PASS" : "FAIL").padEnd(6)}  ${row.detail}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envDelayMs(): number {
  const raw = process.env.EVAL_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return 2500;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 2500;
}

/* -------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------- */

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    usage();
    return 0;
  }

  const allCases = loadCases();
  let selected = allCases;
  if (flags.category) selected = selected.filter((c) => c.category === flags.category);
  if (flags.limit !== undefined) selected = selected.slice(0, flags.limit);
  if (selected.length === 0) {
    console.error("no cases selected");
    return 1;
  }

  const isMock = flags.mock || /^(1|true|yes)$/i.test(process.env.MOCK_LLM?.trim() ?? "");
  if (!isMock && !process.env.GROQ_API_KEY?.trim()) {
    console.error("Live evals need GROQ_API_KEY, and it is not set.");
    console.error("");
    console.error("Run the plumbing-only harness instead (no key, no network):");
    console.error("  MOCK_LLM=1 npm run evals");
    return 1;
  }

  const provider = isMock ? createMockProvider() : getProvider();
  const delayMs = isMock ? 0 : envDelayMs();
  const startedAt = new Date();

  if (isMock) {
    console.log(`Canadian Housing Agent evals — mode: mock (plumbing-only, no network)`);
  } else {
    console.log(
      `Canadian Housing Agent evals — mode: live provider=${provider.name}, sequential, ${delayMs}ms between cases`,
    );
  }
  console.log(
    `cases: ${selected.length}/${allCases.length}${flags.category ? ` category=${flags.category}` : ""}${
      flags.limit !== undefined ? ` limit=${flags.limit}` : ""
    }\n`,
  );

  const fullSuite = selected.length === allCases.length;
  const reportMeta = (completeSuite: boolean) => ({
    isMock,
    providerName: provider.name,
    startedAt,
    completeSuite,
  });

  const reportCases: CaseReport[] = [];
  for (const [index, evalCase] of selected.entries()) {
    const outcome = await runAgentCase(evalCase, provider);
    const row = buildCaseReport(evalCase, outcome);
    reportCases.push(row);
    // Persist after every case so an aborted run (quota, crash) keeps partial results.
    // Intermediate reports never claim a complete suite, so they cannot pass the gate.
    writeReport(buildReport(reportCases, reportMeta(false)));
    if (!isMock) {
      console.log(`[${index + 1}/${selected.length}] ${evalCase.id} ${row.passed ? "PASS" : "FAIL"} ${row.detail}`);
    }
    if (!isMock && index < selected.length - 1) await sleep(delayMs);
  }

  printTable(reportCases);

  const report = buildReport(reportCases, reportMeta(fullSuite));
  writeReport(report);
  const { scores, totals } = report;

  const formatScore = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
  console.log(
    `\nscores: tool_accuracy=${formatScore(scores.tool_accuracy)} numeric_accuracy=${formatScore(
      scores.numeric_accuracy,
    )} refusal_accuracy=${formatScore(scores.refusal_accuracy)}`,
  );
  console.log(`totals: ${totals.passed}/${totals.cases} passed`);
  console.log(`report: ${REPORT_PATH}`);

  if (isMock) {
    console.log("\nmock mode: plumbing-only — scores are not a quality signal; live scoring needs GROQ_API_KEY.");
    return 0;
  }

  const thresholdFailures: string[] = [];
  for (const [key, minimum] of Object.entries(THRESHOLDS)) {
    const value = scores[key as keyof typeof scores];
    if (value !== null && value < minimum) thresholdFailures.push(`${key}=${value.toFixed(2)} < ${minimum}`);
  }
  if (thresholdFailures.length > 0) {
    console.error(`\nthresholds failed: ${thresholdFailures.join(", ")}`);
    return 1;
  }
  console.log(report.complete_suite
    ? "\nFull-suite thresholds passed (automated checks; review answers before release)."
    : "\nSelected-case thresholds passed. Partial run: full quality gate is still pending.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
