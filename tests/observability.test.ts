import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "../app/api/chat/route";
import { createGuardState } from "../lib/guards";
import { logEvent } from "../lib/observability";
import * as providers from "../lib/providers";

type LogSpy = { mock: { calls: unknown[][] } };
type LoggedEvent = Record<string, unknown>;

function loggedEvents(spy: LogSpy): LoggedEvent[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as LoggedEvent);
}

function request(messages = [{ role: "user", content: "How many listings are in Ottawa?" }]) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

const SEARCH_QUESTION = [
  { role: "user", content: "How many 3 bedroom listings are in Ottawa?" },
];

describe("logEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one single-line JSON object with a timestamp and the event fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ event: "chat_turn", durationMs: 42, cached: false, tools: ["search_listings"] });

    expect(spy).toHaveBeenCalledTimes(1);
    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("\n");
    const parsed = JSON.parse(raw) as LoggedEvent;
    expect(Object.keys(parsed)).toEqual(["ts", "event", "durationMs", "cached", "tools"]);
    expect(parsed.event).toBe("chat_turn");
    expect(parsed.durationMs).toBe(42);
    expect(parsed.cached).toBe(false);
    expect(parsed.tools).toEqual(["search_listings"]);
    expect(new Date(String(parsed.ts)).toISOString()).toBe(parsed.ts);
  });

  it("strips content-like keys instead of logging their values", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({
      event: "chat_turn",
      durationMs: 7,
      message: "cheapest house in Ottawa",
      messages: [{ role: "user", content: "cheapest house in Ottawa" }],
      content: "cheapest house in Ottawa",
      answer: "cheapest house in Ottawa",
      text: "cheapest house in Ottawa",
      key: "sk-live-abcdef",
      token: "secret-token",
      ip: "203.0.113.9",
      ipAddress: "203.0.113.9",
      userMessage: "cheapest house in Ottawa",
      question: "cheapest house in Ottawa",
      prompt: "cheapest house in Ottawa",
      query: "cheapest house in Ottawa",
      reply: "cheapest house in Ottawa",
      completion: "cheapest house in Ottawa",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const raw = String(spy.mock.calls[0][0]);
    const parsed = JSON.parse(raw) as LoggedEvent;
    expect(Object.keys(parsed).sort()).toEqual(["durationMs", "event", "ts"]);
    expect(raw).not.toMatch(/Ottawa|sk-live|secret-token|203\.0\.113\.9/);
  });

  it("never throws, even on values that cannot be serialized", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: Record<string, unknown> & { event: string } = { event: "chat_turn" };
    circular.self = circular;

    expect(() => logEvent(circular)).not.toThrow();
    expect(() => logEvent(undefined as never)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("/api/chat observability", () => {
  let logSpy: LogSpy;

  beforeEach(() => {
    vi.stubEnv("MOCK_LLM", "1");
    globalThis.__housingGuardState = createGuardState({ maxPerMinute: 100 });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs exactly one chat_turn per successful turn with the tool names used", async () => {
    await (await POST(request(SEARCH_QUESTION))).text();

    const turns = loggedEvents(logSpy).filter((entry) => entry.event === "chat_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBeTypeOf("number");
    expect(turns[0].cached).toBe(false);
    expect(turns[0].tools).toEqual(["search_listings"]);
    expect(turns[0].errorCode).toBeUndefined();
    expect(turns[0].figuresUngrounded).toBe(0);
    expect(turns[0].figuresChecked).toBeTypeOf("number");
    expect(Object.keys(turns[0]).sort()).toEqual([
      "cached",
      "durationMs",
      "event",
      "figuresChecked",
      "figuresUngrounded",
      "tools",
      "ts",
    ]);
  });

  it("flags a cache-hit repeat as cached and keeps the replayed tool names", async () => {
    await (await POST(request(SEARCH_QUESTION))).text();
    await (await POST(request(SEARCH_QUESTION))).text();

    const turns = loggedEvents(logSpy).filter((entry) => entry.event === "chat_turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ cached: false, tools: ["search_listings"] });
    expect(turns[1]).toMatchObject({ cached: true, tools: ["search_listings"] });
  });

  it("records the terminal error code on a failed turn without the error detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(providers, "getProvider").mockReturnValue({
      name: "broken",
      async *stream() {
        yield { type: "text", delta: "The median is " };
        throw new Error("connection interrupted");
      },
    });

    await (await POST(request(SEARCH_QUESTION))).text();

    const turns = loggedEvents(logSpy).filter((entry) => entry.event === "chat_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ cached: false, errorCode: "provider_error" });
    expect(JSON.stringify(turns[0])).not.toContain("connection interrupted");
  });

  it("logs the pre-stream budget_exhausted 503 as one chat_turn with the terminal error code", async () => {
    globalThis.__housingGuardState = createGuardState({ maxPerMinute: 100, budgetPerDay: 0 });

    const response = await POST(request(SEARCH_QUESTION));
    expect(response.status).toBe(503);
    await response.text();

    const turns = loggedEvents(logSpy).filter((entry) => entry.event === "chat_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBeTypeOf("number");
    expect(turns[0]).toMatchObject({ cached: false, tools: [], errorCode: "budget_exhausted" });
  });

  it("emits a rate_limited event with only the stable reason on the 6th rapid request", async () => {
    globalThis.__housingGuardState = createGuardState();

    for (let i = 0; i < 5; i += 1) {
      const response = await POST(request());
      expect(response.status).toBe(200);
      await response.text();
    }
    const blocked = await POST(request());
    expect(blocked.status).toBe(429);
    await blocked.text();

    const events = loggedEvents(logSpy);
    const limited = events.filter((entry) => entry.event === "rate_limited");
    expect(limited).toHaveLength(1);
    expect(Object.keys(limited[0]).sort()).toEqual(["event", "reason", "ts"]);
    expect(limited[0].reason).toBe("rate_limited");
    expect(events.filter((entry) => entry.event === "chat_turn")).toHaveLength(5);
  });
});
