/**
 * LLM providers for the demo. Groq via plain fetch (no SDK) with an SSE
 * parser, an optional tiny Gemini fallback, and a deterministic offline mock
 * so the app and tests run with no API key and no network.
 */

import { knownCities } from "./tools";
import type { CitySnapshot, Listing } from "./types";

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const CALL_TIMEOUT_MS = 20_000;
// Demo answers are 1-4 sentences; 512 output tokens is generous without risking the free-tier quota.
const MAX_OUTPUT_TOKENS = 512;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
};

export type ToolSpec = {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
};

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string };

export interface Provider {
  readonly name: string;
  stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent>;
}

export type ProviderErrorCode = "timeout" | "network" | "http" | "config";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(message: string, code: ProviderErrorCode, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasGroqKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/** MOCK_LLM=1 forces the mock; unset MOCK_LLM with no key in dev also mocks. */
export function mockMode(): boolean {
  const flag = process.env.MOCK_LLM?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  if (!hasGroqKey() && process.env.NODE_ENV !== "production") return true;
  return false;
}

/** Real failure details stay in server logs; clients only get stable codes. */
function providerLog(provider: string, message: string): void {
  console.error(`[provider:${provider}] ${message}`);
}

export function getProvider(): Provider {
  if (mockMode()) return createMockProvider();
  const groq = createGroqProvider();
  if (process.env.GEMINI_API_KEY?.trim()) {
    return createFallbackProvider(groq, createGeminiProvider());
  }
  return groq;
}

/* -------------------------------------------------------------------------
 * Mock provider
 * ---------------------------------------------------------------------- */

const mockCities = () => knownCities().slice();

function plainCity(city: string): string {
  return city.toLowerCase().replace(/[.-]/g, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cityPattern(city: string): RegExp {
  return new RegExp(`\\b${escapeRegex(plainCity(city))}\\b`);
}

export function matchedCities(question: string): string[] {
  const normalized = question
    .toLowerCase()
    .replace(/[.-]/g, " ")
    .replace(/\s+/g, " ");
  return mockCities()
    .map((city) => ({ city, at: normalized.search(cityPattern(city)) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.city);
}

/** Deterministic tool choice for a user question, per the demo rules. */
export function mockToolCallFor(
  question: string,
): { id: string; name: string; args: Record<string, unknown> } | null {
  const q = question.toLowerCase();
  const cities = matchedCities(question);

  if (q.includes("compare") && cities.length >= 2) {
    return { id: "mock_compare", name: "compare_cities", args: { cities: [cities[0], cities[1]] } };
  }

  const beds = q.match(/\b(\d{1,2})\s*[- ]?\s*(?:bed|beds|bedroom|bedrooms|bd|br)\b/);
  if (cities.length >= 1 && beds) {
    return {
      id: "mock_search",
      name: "search_listings",
      args: { city: cities[0], beds: Number(beds[1]), limit: 5 },
    };
  }

  if (cities.length >= 1) {
    return { id: "mock_snapshot", name: "city_snapshot", args: { city: cities[0] } };
  }

  return null;
}

function formatMoney(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "an unknown price";
  return `$${Math.round(n).toLocaleString("en-CA")}`;
}

/** "st-catharines" -> "St-Catharines" for readable mock answers. */
function displayCity(city: unknown): string {
  if (typeof city !== "string" || !city) return "the sample";
  return city
    .split(/([-\s])/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}

/** Scripted answer that embeds numbers from the real tool result. */
export function mockAnswerFromToolResult(message: ChatMessage): string {
  let data: unknown = null;
  try {
    data = JSON.parse(message.content);
  } catch {
    data = null;
  }

  if (message.name === "search_listings") {
    const result = data as {
      totalMatches?: number;
      listings?: Array<Partial<Listing>>;
    } | null;
    const total = Number(result?.totalMatches ?? 0);
    const listings = result?.listings ?? [];
    const cheapest = [...listings].sort(
      (a, b) => Number(a.price ?? Infinity) - Number(b.price ?? Infinity),
    )[0];
    if (!total || !cheapest) {
      return "No listings in the sample matched that search. Try a higher price or a different city.";
    }
    const where = cheapest.address ? `, ${cheapest.address}` : "";
    const source = cheapest.url ? ` (${cheapest.url})` : "";
    return `The sample has ${total.toLocaleString("en-CA")} matching listings. The cheapest is a ${
      cheapest.beds ?? "?"
    }-bed in ${displayCity(cheapest.city)} at ${formatMoney(cheapest.price)}${where}${source}.`;
  }

  if (message.name === "city_snapshot") {
    const snapshot = data as CitySnapshot | null;
    if (!snapshot || typeof snapshot.city !== "string") {
      return "I do not have a snapshot for that city in the sample.";
    }
    const share = Number(snapshot.shareUnder1M);
    const shareText = Number.isFinite(share)
      ? ` About ${Math.round(share * 100)} percent of them ask under $1M.`
      : "";
    return `${displayCity(snapshot.city)} has ${Number(snapshot.count ?? 0).toLocaleString(
      "en-CA",
    )} listings in the sample, with a median asking price of ${formatMoney(
      snapshot.medianPrice,
    )}.${shareText}`;
  }

  if (message.name === "compare_cities") {
    const rows = Array.isArray(data) ? (data as CitySnapshot[]) : [];
    if (rows.length === 0) return "I could not find both cities in the sample.";
    const parts = rows.map(
      (row) =>
        `${displayCity(row.city)}: median ${formatMoney(row.medianPrice)} across ${Number(
          row.count ?? 0,
        ).toLocaleString("en-CA")} listings`,
    );
    return `${parts.join(". ")}.`;
  }

  return "Here is what the sample shows for that question.";
}

export function createMockProvider(): Provider {
  return {
    name: "mock",
    async *stream(messages: ChatMessage[]): AsyncGenerator<ProviderEvent> {
      const last = messages[messages.length - 1];
      if (last?.role === "tool") {
        yield { type: "text", delta: mockAnswerFromToolResult(last) };
        return;
      }

      const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const call = mockToolCallFor(question);
      if (!call) {
        yield {
          type: "text",
          delta:
            "I can only cover the Canadian cities in the listing sample. Ask about a city, for example Toronto or Vancouver, or ask me to compare two cities.",
        };
        return;
      }
      yield {
        type: "tool_call",
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      };
    },
  };
}

/* -------------------------------------------------------------------------
 * Groq (OpenAI-compatible chat completions, streamed)
 * ---------------------------------------------------------------------- */

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls?.length) {
    out.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return out;
}

type GroqToolCallAccumulator = { id: string; name: string; arguments: string };

export function createGroqProvider(
  options: { apiKey?: string; model?: string; url?: string; timeoutMs?: number } = {},
): Provider {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY ?? "";
  const model = options.model ?? (process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL);
  const url = options.url ?? GROQ_URL;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  return {
    name: "groq",
    async *stream(messages, tools, signal): AsyncGenerator<ProviderEvent> {
      if (!apiKey) throw new ProviderError("GROQ_API_KEY is not set", "config");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const body: Record<string, unknown> = {
          model,
          messages: messages.map(toOpenAiMessage),
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        };
        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = "auto";
        }

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted && !signal?.aborted) {
            providerLog("groq", `timed out after ${timeoutMs}ms`);
            throw new ProviderError(`Groq timed out after ${timeoutMs}ms`, "timeout");
          }
          providerLog("groq", `request failed: ${messageOf(error)}`);
          throw new ProviderError(`Groq request failed: ${messageOf(error)}`, "network");
        }

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          providerLog("groq", `HTTP ${response.status}: ${detail.slice(0, 500)}`);
          throw new ProviderError(
            `Groq returned ${response.status}: ${detail.slice(0, 300)}`,
            "http",
            response.status,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const toolCalls = new Map<number, GroqToolCallAccumulator>();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");

              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;

              let chunk: {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
              };
              try {
                chunk = JSON.parse(payload);
              } catch {
                continue;
              }

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;
              if (typeof delta.content === "string" && delta.content.length > 0) {
                yield { type: "text", delta: delta.content };
              }
              for (const partial of delta.tool_calls ?? []) {
                const index = partial.index ?? 0;
                const entry = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
                if (partial.id) entry.id = partial.id;
                if (partial.function?.name) entry.name += partial.function.name;
                if (partial.function?.arguments) entry.arguments += partial.function.arguments;
                toolCalls.set(index, entry);
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted && !signal?.aborted) {
            providerLog("groq", `stream timed out after ${timeoutMs}ms`);
            throw new ProviderError(`Groq timed out after ${timeoutMs}ms`, "timeout");
          }
          providerLog("groq", `stream failed: ${messageOf(error)}`);
          throw new ProviderError(`Groq stream failed: ${messageOf(error)}`, "network");
        }

        for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          if (!call.name) continue;
          yield {
            type: "tool_call",
            id: call.id || `call_${index}`,
            name: call.name,
            arguments: call.arguments || "{}",
          };
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/* -------------------------------------------------------------------------
 * Gemini (minimal non-streaming fallback)
 * ---------------------------------------------------------------------- */

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

function toGeminiContents(messages: ChatMessage[], systemText: string) {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls ?? []) {
        parts.push({ functionCall: { name: call.name, args: asObject(safeParse(call.arguments)) } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.name ?? "",
            response: asObject(safeParse(message.content)),
          },
        },
      ],
    });
  }
  return { contents, systemInstruction: { parts: [{ text: systemText }] } };
}

export function createGeminiProvider(
  options: { apiKey?: string; model?: string; timeoutMs?: number } = {},
): Provider {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = options.model ?? (process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  return {
    name: "gemini",
    async *stream(messages, tools, signal): AsyncGenerator<ProviderEvent> {
      if (!apiKey) throw new ProviderError("GEMINI_API_KEY is not set", "config");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const systemText = messages.find((m) => m.role === "system")?.content ?? "";
        const body: Record<string, unknown> = {
          ...toGeminiContents(messages, systemText),
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        };
        if (tools.length > 0) {
          body.tools = [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
              })),
            },
          ];
        }

        let response: Response;
        try {
          response = await fetch(`${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted && !signal?.aborted) {
            providerLog("gemini", `timed out after ${timeoutMs}ms`);
            throw new ProviderError(`Gemini timed out after ${timeoutMs}ms`, "timeout");
          }
          providerLog("gemini", `request failed: ${messageOf(error)}`);
          throw new ProviderError(`Gemini request failed: ${messageOf(error)}`, "network");
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          providerLog("gemini", `HTTP ${response.status}: ${detail.slice(0, 500)}`);
          throw new ProviderError(
            `Gemini returned ${response.status}: ${detail.slice(0, 300)}`,
            "http",
            response.status,
          );
        }

        const payload = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                functionCall?: { name?: string; args?: unknown };
              }>;
            };
          }>;
        };
        const parts = payload.candidates?.[0]?.content?.parts ?? [];
        let toolIndex = 0;
        for (const part of parts) {
          if (typeof part.text === "string" && part.text.length > 0) {
            yield { type: "text", delta: part.text };
          }
          if (part.functionCall?.name) {
            yield {
              type: "tool_call",
              id: `gemini_${toolIndex}`,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            };
            toolIndex += 1;
          }
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Try the primary once; only fall back if it failed before emitting anything. */
export function createFallbackProvider(primary: Provider, fallback: Provider): Provider {
  return {
    name: `${primary.name}+${fallback.name}`,
    async *stream(messages, tools, signal): AsyncGenerator<ProviderEvent> {
      let emitted = false;
      try {
        for await (const event of primary.stream(messages, tools, signal)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (emitted) throw error;
      }
      yield* fallback.stream(messages, tools, signal);
    },
  };
}
