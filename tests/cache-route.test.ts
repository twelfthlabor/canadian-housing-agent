import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { createGuardState } from "../lib/guards";
import * as providers from "../lib/providers";

function request(messages = [{ role: "user", content: "How many listings are in Ottawa?" }]) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

type Frame = { type: string; [key: string]: unknown };

function frames(raw: string): Frame[] {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Frame);
}

describe("completed, standalone answer caching", () => {
  beforeEach(() => {
    vi.stubEnv("MOCK_LLM", "1");
    globalThis.__housingGuardState = createGuardState({ maxPerMinute: 100 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reuses a completed standalone answer without another LLM call", async () => {
    await (await POST(request())).text();
    const used = globalThis.__housingGuardState!.budget.used;
    expect(await (await POST(request())).text()).toContain('"type":"cached"');
    expect(globalThis.__housingGuardState!.budget.used).toBe(used);
  });

  it("replays stored tool and tool_result events around a cached search answer", async () => {
    const search = [{ role: "user", content: "How many 3 bedroom listings are in Ottawa?" }];
    const first = frames(await (await POST(request(search))).text());
    const firstToolResult = first.find((frame) => frame.type === "tool_result");
    expect(firstToolResult).toBeDefined();

    const replay = frames(await (await POST(request(search))).text());
    const types = replay.map((frame) => frame.type);
    expect(types[0]).toBe("cached");
    expect(types.at(-1)).toBe("done");
    const tool = replay.find((frame) => frame.type === "tool");
    expect(tool).toMatchObject({ name: "search_listings" });
    const toolResult = replay.find((frame) => frame.type === "tool_result");
    expect(toolResult?.data).toEqual(firstToolResult?.data);
    expect(types.indexOf("tool")).toBeLessThan(types.indexOf("tool_result"));
    expect(types.indexOf("tool_result")).toBeLessThan(types.indexOf("text"));
    const text = replay.find((frame) => frame.type === "text");
    expect(text?.delta).toContain("matching listings");
  });

  it("sends the same grounding result live and on a cache replay, after the text", async () => {
    const search = [{ role: "user", content: "How many 3 bedroom listings are in Ottawa?" }];
    const first = frames(await (await POST(request(search))).text());
    const replay = frames(await (await POST(request(search))).text());
    const live = first.find((frame) => frame.type === "grounding");
    expect(live).toBeDefined();
    expect(live?.ungrounded).toEqual([]);
    expect(replay.find((frame) => frame.type === "grounding")).toEqual(live);
    const types = replay.map((frame) => frame.type);
    expect(types.indexOf("text")).toBeLessThan(types.indexOf("grounding"));
    expect(types.indexOf("grounding")).toBeLessThan(types.indexOf("done"));
  });

  it("does not reuse or store answers from conversations with history", async () => {
    const conversation = [
      { role: "user", content: "Tell me about Ottawa." },
      { role: "assistant", content: "Ottawa has a listing sample." },
      { role: "user", content: "What about 3 bedrooms?" },
    ];
    await (await POST(request(conversation))).text();
    expect(globalThis.__housingGuardState!.cache.size).toBe(0);
    expect(await (await POST(request(conversation))).text()).not.toContain('"type":"cached"');
  });

  it("bypasses a standalone cache hit when the same words have conversation context", async () => {
    await (await POST(request())).text();
    const response = await POST(request([
      { role: "user", content: "Only include homes with 3 bedrooms." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "How many listings are in Ottawa?" },
    ]));
    expect(await response.text()).not.toContain('"type":"cached"');
  });

  it("does not cache partial text after a provider failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(providers, "getProvider").mockReturnValue({
      name: "broken",
      async *stream() {
        yield { type: "text", delta: "The median is " };
        throw new Error("connection interrupted");
      },
    });
    const response = await POST(request());
    expect(await response.text()).toContain('"type":"error"');
    expect(globalThis.__housingGuardState!.cache.size).toBe(0);
  });

  it("serves cached answers even when the LLM budget is exhausted", async () => {
    await (await POST(request())).text();
    globalThis.__housingGuardState!.budgetPerDay = 0;
    const hit = await POST(request());
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain('"type":"cached"');
    const miss = await POST(request([{ role: "user", content: "Tell me about Toronto." }]));
    expect(miss.status).toBe(503);
  });

  it("still rate limits cached requests", async () => {
    globalThis.__housingGuardState!.maxPerMinute = 1;
    await (await POST(request())).text();
    expect((await POST(request())).status).toBe(429);
  });
});
