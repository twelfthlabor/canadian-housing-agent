import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFallbackProvider,
  createGeminiProvider,
  createGroqProvider,
  createMockProvider,
  mockToolCallFor,
} from "../lib/providers";
import type { ChatMessage, Provider, ProviderEvent } from "../lib/providers";

async function collect(provider: Provider) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream([{ role: "user", content: "Hello" }], [])) {
    events.push(event);
  }
  return events;
}

async function collectFrom(provider: Provider, messages: ChatMessage[]) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(messages, [])) {
    events.push(event);
  }
  return events;
}

function textOf(events: ProviderEvent[]): string {
  return events.map((event) => (event.type === "text" ? event.delta : "")).join("");
}

function searchResultMessage(payload: unknown): ChatMessage {
  return { role: "tool", name: "search_listings", content: JSON.stringify(payload) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mock provider", () => {
  it("includes the cheapest listing's address and source URL in a search answer", async () => {
    const events = await collectFrom(createMockProvider(), [
      { role: "user", content: "Cheapest 2-bedroom in Kitchener?" },
      searchResultMessage({
        totalMatches: 2,
        returned: 2,
        listings: [
          { city: "kitchener", price: 512_000, beds: 3, address: "9 Second St", url: "https://example.test/second" },
          { city: "kitchener", price: 401_000, beds: 2, address: "1 First St", url: "https://example.test/first" },
        ],
      }),
    ]);
    const text = textOf(events);
    expect(text).toContain("1 First St");
    expect(text).toContain("https://example.test/first");
    expect(text).not.toContain("9 Second St");
    expect(text).not.toContain("https://example.test/second");
  });

  it("omits address and URL when the tool result carries none", async () => {
    const events = await collectFrom(createMockProvider(), [
      { role: "user", content: "Cheapest 2-bedroom in Kitchener?" },
      searchResultMessage({
        totalMatches: 1,
        returned: 1,
        listings: [{ city: "kitchener", price: 401_000, beds: 2 }],
      }),
    ]);
    const text = textOf(events);
    expect(text).toContain("$401,000");
    expect(text).not.toMatch(/undefined|null/);
  });

  it("answers off-sample questions without calling the sample sanitized", async () => {
    const text = textOf(await collect(createMockProvider()));
    expect(text).toContain("Canadian");
    expect(text.toLowerCase()).not.toContain("sanitized");
  });
});

describe("mock deal handling", () => {
  it("chooses find_deals for deal keywords and parses an explicit threshold", () => {
    expect(mockToolCallFor("Find undervalued listings in Brampton")).toMatchObject({
      name: "find_deals",
      args: { city: "brampton" },
    });
    expect(mockToolCallFor("What is the largest discount among Calgary's current deal listings?")).toMatchObject({
      name: "find_deals",
      args: { city: "calgary" },
    });
    expect(
      mockToolCallFor("How many listings in Brampton are at least 15% below the comparable-listings estimate?"),
    ).toMatchObject({ name: "find_deals", args: { city: "brampton", minDiscount: 15 } });
    // A bed-filtered cheapest question stays a listing search.
    expect(mockToolCallFor("Cheapest 3-bed houses in Ottawa")).toMatchObject({ name: "search_listings" });
  });

  it("keeps cheap(est) and generic below questions off find_deals", () => {
    // Pre-existing mock choice for these phrasings: no bed filter -> city_snapshot.
    expect(mockToolCallFor("What's the cheapest house in Windsor?")).toMatchObject({
      name: "city_snapshot",
      args: { city: "windsor" },
    });
    expect(mockToolCallFor("Show me listings in Guelph below $700,000")).toMatchObject({
      name: "city_snapshot",
      args: { city: "guelph" },
    });
  });

  it("quotes the top discount from a find_deals result", async () => {
    const events = await collectFrom(createMockProvider(), [
      { role: "user", content: "Find undervalued listings in Brampton" },
      {
        role: "tool",
        name: "find_deals",
        content: JSON.stringify({
          city: "brampton",
          minDiscount: 20,
          considered: 928,
          totalMatches: 2,
          returned: 2,
          listings: [
            {
              city: "brampton",
              beds: 3,
              price: 469950,
              address: "900 Central Park Dr #36",
              url: "https://example.test/a",
              estValue: 923000,
              discountPct: 49.1,
            },
            {
              city: "brampton",
              beds: 2,
              price: 399900,
              address: "157 Fleetwood Cres",
              url: "https://example.test/b",
              estValue: 732000,
              discountPct: 45.4,
            },
          ],
        }),
      },
    ]);
    const text = textOf(events);
    expect(text).toContain("2 listings in Brampton at least 20% below the comparable-listings estimate");
    expect(text).toContain("49.1% below estimate");
    expect(text).toContain("900 Central Park Dr #36");
    expect(text).toContain("https://example.test/a");
    expect(text).not.toContain("45.4");
  });

  it("answers an empty find_deals result without inventing numbers", async () => {
    const events = await collectFrom(createMockProvider(), [
      { role: "user", content: "Any deals in Brampton?" },
      {
        role: "tool",
        name: "find_deals",
        content: JSON.stringify({
          city: "brampton",
          minDiscount: 20,
          considered: 4,
          totalMatches: 0,
          returned: 0,
          listings: [],
        }),
      },
    ]);
    expect(textOf(events)).toBe(
      "No Brampton listings in the sample are more than 20% below the comparable-listings estimate (4 listings considered).",
    );
  });
});

describe("provider configuration and fallback", () => {
  it("uses the supported Gemini default when the override is empty", async () => {
    vi.stubEnv("GEMINI_MODEL", " ");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(createGeminiProvider({ apiKey: "test-key" }))).toEqual([
      { type: "text", delta: "Hello" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("/gemini-2.5-flash-lite:generateContent");
  });

  it("uses the Groq default when the override is empty", async () => {
    vi.stubEnv("GROQ_MODEL", " ");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
    ));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(createGroqProvider({ apiKey: "test-key" }))).toEqual([
      { type: "text", delta: "Hello" },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("openai/gpt-oss-120b");
  });

  it("caps Groq output tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
    ));
    vi.stubGlobal("fetch", fetchMock);
    await collect(createGroqProvider({ apiKey: "test-key" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(512);
  });

  it("caps Gemini output tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    await collect(createGeminiProvider({ apiKey: "test-key" }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig?.maxOutputTokens).toBe(512);
  });

  it("falls back after an initial failure, but never after partial output", async () => {
    let fallbackCalls = 0;
    const fallback: Provider = { name: "fallback", async *stream() {
      fallbackCalls += 1;
      yield { type: "text", delta: "Recovered" };
    } };
    const failed: Provider = { name: "failed", async *stream() { throw new Error("offline"); } };
    expect(await collect(createFallbackProvider(failed, fallback))).toEqual([
      { type: "text", delta: "Recovered" },
    ]);
    const partial: Provider = { name: "partial", async *stream() {
      yield { type: "text", delta: "Partial" };
      throw new Error("interrupted");
    } };
    await expect(collect(createFallbackProvider(partial, fallback))).rejects.toThrow("interrupted");
    expect(fallbackCalls).toBe(1);
  });
});
