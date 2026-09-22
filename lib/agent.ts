/**
 * Tool-calling agent loop. Emits typed events that the API route forwards as
 * SSE. Hard caps: 3 tool iterations and 4 LLM calls per turn.
 */

import { TOOL_IMPLS, TOOL_SPECS } from "./tools";
import { ProviderError } from "./providers";
import type { ChatMessage, Provider, ToolSpec } from "./providers";

export const MAX_LLM_CALLS_PER_TURN = 4;
export const MAX_TOOL_ITERATIONS = 3;

export const SYSTEM_PROMPT = [
  "You are the demo assistant for a research sample of Canadian for-sale real estate listings.",
  "Rules:",
  "- ALWAYS call a tool for any price, count, ranking, or statistic. Never invent numbers.",
  "- Quote numbers as the tools return them. Do not derive new figures (averages, quartile percentages); if asked for something the tools do not compute, report the closest figure they do (for example the median) and name it.",
  "- If the tools do not return the data, say plainly that the sample does not cover it.",
  "- The sample has asking prices only: no sold prices, transaction history, or MLS numbers. Never ask for those.",
  "- Listing results include an address and source URL; include the full address and source URL when you mention a specific listing.",
  "- If a question you can answer is missing a detail the tools need (for example the city), do not decline or guess: ask one brief question for it first, then continue once you have it.",
  "- When you decline a request, name the specific limitation in one line; never answer with only a generic \"I can't help with that\".",
  "- No predictions, no investment, legal, or financial advice.",
  "- Keep answers short and plain. No markdown tables.",
  "- Use at most three tool calls per turn.",
].join("\n");

export type AgentErrorCode =
  | "provider_error"
  | "misconfigured"
  | "rate_limited"
  | "budget_exhausted";

export type AgentErrorEvent = { type: "error"; code: AgentErrorCode; message: string };

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string; data?: unknown }
  | { type: "cached" }
  | { type: "done" }
  | AgentErrorEvent;

/** Client-facing text is always generic; real details go to server logs only. */
export const GENERIC_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  provider_error: "The answer service is temporarily unavailable. Please try again in a moment.",
  misconfigured: "This demo is not configured with an LLM provider right now.",
  rate_limited: "Too many requests. Please try again shortly.",
  budget_exhausted: "The demo has reached its daily LLM budget. Please try again tomorrow.",
};

export type AgentInputMessage = { role: "user" | "assistant"; content: string };

export type RunAgentOptions = {
  messages: AgentInputMessage[];
  provider: Provider;
  /** Called before each LLM call; throw to stop the turn (budget, etc.). */
  beforeLlmCall?: () => void;
  maxLlmCalls?: number;
  maxToolIterations?: number;
  signal?: AbortSignal;
};

export class BudgetExhaustedError extends Error {
  constructor(message = "daily LLM budget reached") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** One SSE frame: a single `data:` line plus a blank line. */
export function sseEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const toolSpecs = TOOL_SPECS as unknown as ToolSpec[];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown): AgentErrorCode {
  if (error instanceof BudgetExhaustedError) return "budget_exhausted";
  if (error instanceof ProviderError && error.code === "config") return "misconfigured";
  return "provider_error";
}

/** Log the real detail server-side, return only the stable code and generic text. */
export function errorEvent(code: AgentErrorCode, detail?: unknown): AgentErrorEvent {
  if (detail !== undefined) {
    console.error(`[agent] ${code}: ${messageOf(detail)}`);
  }
  return { type: "error", code, message: GENERIC_ERROR_MESSAGES[code] };
}

export function errorEventFrom(error: unknown): AgentErrorEvent {
  return errorEvent(classifyError(error), error);
}

function formatMoney(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "unknown";
  return `$${Math.round(n).toLocaleString("en-CA")}`;
}

function executeTool(name: string, args: Record<string, unknown>): unknown {
  const impl = (TOOL_IMPLS as Record<string, (input: Record<string, unknown>) => unknown>)[name];
  if (typeof impl !== "function") return { error: `unknown tool: ${name}` };
  try {
    return impl(args);
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function summarizeResult(name: string, result: unknown): string {
  if (name === "compare_cities") {
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    if (rows.length === 0) return "no data";
    return rows.map((row) => `${row.city}: ${formatMoney(row.medianPrice)}`).join(" vs ");
  }
  if (!result || typeof result !== "object") {
    return JSON.stringify(result).slice(0, 120);
  }
  const record = result as Record<string, unknown>;
  if (name === "search_listings") {
    const total = Number(record.totalMatches ?? 0);
    const listings = Array.isArray(record.listings)
      ? (record.listings as Array<Record<string, unknown>>)
      : [];
    if (total === 0) return "no matches";
    const cheapest = [...listings].sort(
      (a, b) => Number(a.price ?? Infinity) - Number(b.price ?? Infinity),
    )[0];
    return cheapest
      ? `${total.toLocaleString("en-CA")} matches, cheapest ${formatMoney(cheapest.price)}`
      : `${total.toLocaleString("en-CA")} matches`;
  }
  if (name === "city_snapshot" && typeof record.city === "string") {
    return `${record.city}: ${Number(record.count ?? 0).toLocaleString("en-CA")} listings, median ${formatMoney(
      record.medianPrice,
    )}`;
  }
  if (name === "rank_areas" && typeof record.city === "string") {
    const areas = Array.isArray(record.areas) ? (record.areas as Array<Record<string, unknown>>) : [];
    if (areas.length === 0) {
      const considered = Number(record.considered ?? 0);
      return considered === 0
        ? `no matching listings in ${record.city}`
        : `no area with 5 or more matching listings in ${record.city} (${considered.toLocaleString(
            "en-CA",
          )} listings considered)`;
    }
    const label = record.metric === "count" ? "listing count" : "median price";
    const listed = areas
      .map(
        (area) =>
          `${String(area.fsa ?? "")} ${formatMoney(area.medianPrice)} (${Number(area.count ?? 0).toLocaleString(
            "en-CA",
          )})`,
      )
      .join(", ");
    return `${record.city}: ${areas.length} of ${Number(record.totalAreas ?? 0)} areas by ${label} (${
      record.order
    }): ${listed}`;
  }
  return JSON.stringify(result).slice(0, 120);
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const maxLlmCalls = options.maxLlmCalls ?? MAX_LLM_CALLS_PER_TURN;
  const maxToolIterations = options.maxToolIterations ?? MAX_TOOL_ITERATIONS;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...options.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content })),
  ];

  let llmCalls = 0;
  let toolIterations = 0;

  while (llmCalls < maxLlmCalls) {
    try {
      options.beforeLlmCall?.();
    } catch (error) {
      yield errorEventFrom(error);
      return;
    }
    llmCalls += 1;

    let text = "";
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    try {
      for await (const event of options.provider.stream(messages, toolSpecs, options.signal)) {
        if (event.type === "text") {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        } else {
          calls.push({ id: event.id, name: event.name, arguments: event.arguments });
        }
      }
    } catch (error) {
      yield errorEventFrom(error);
      return;
    }

    if (calls.length === 0) {
      if (!text.trim()) {
        yield {
          type: "text",
          delta: "I could not produce an answer for that. Try rephrasing the question.",
        };
      }
      yield { type: "done" };
      return;
    }

    const remaining = maxToolIterations - toolIterations;
    const runnable = calls.slice(0, Math.max(0, remaining));
    if (runnable.length === 0) {
      if (!text.trim()) {
        yield {
          type: "text",
          delta: "I reached the tool limit for this turn. Ask a follow-up to narrow the question.",
        };
      }
      yield { type: "done" };
      return;
    }

    messages.push({
      role: "assistant",
      content: text,
      tool_calls: runnable.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });

    for (const call of runnable) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }

      yield { type: "tool", name: call.name, args };
      const result = executeTool(call.name, args);
      yield {
        type: "tool_result",
        name: call.name,
        summary: summarizeResult(call.name, result),
        data: result,
      };
      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: call.id,
        name: call.name,
      });
      toolIterations += 1;
    }
  }

  yield {
    type: "text",
    delta: "I reached the tool limit for this turn. Ask a follow-up to narrow the question.",
  };
  yield { type: "done" };
}
