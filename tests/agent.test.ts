import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  MAX_LLM_CALLS_PER_TURN,
  MAX_TOOL_ITERATIONS,
  SYSTEM_PROMPT,
  runAgent,
  sseEvent,
} from "../lib/agent";
import type { AgentEvent } from "../lib/agent";
import { BudgetExhaustedError } from "../lib/agent";
import { createMockProvider, ProviderError } from "../lib/providers";
import type { Provider } from "../lib/providers";
import { createGuardState } from "../lib/guards";
import { TOOL_IMPLS, knownCities } from "../lib/tools";
import type { CitySnapshot, FindDealsResult, RankAreasResult } from "../lib/types";
import { POST } from "../app/api/chat/route";

async function collect(
  question: string,
  provider: Provider = createMockProvider(),
  extra: { beforeLlmCall?: () => void } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent({
    messages: [{ role: "user", content: question }],
    provider,
    beforeLlmCall: extra.beforeLlmCall,
  })) {
    events.push(event);
  }
  return events;
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

function toolOf(events: AgentEvent[]): Extract<AgentEvent, { type: "tool" }> | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "tool" }> => event.type === "tool",
  );
}

function toolResultsOf(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "tool_result" }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result",
  );
}

function oneShotProvider(name: string, args: Record<string, unknown>): Provider {
  return {
    name: "one-shot",
    async *stream() {
      yield { type: "tool_call", id: "call_1", name, arguments: JSON.stringify(args) };
    },
  };
}

const cities = knownCities();
const firstCity = cities.find((city) => /ottawa/i.test(city)) ?? cities[0];
const secondCity = cities.find((city) => city !== firstCity) ?? cities[1];

describe("mock-provider agent turns (no network)", () => {
  it("answers a price question with a city_snapshot tool and real numbers", async () => {
    const events = await collect(`What does $800k buy in ${firstCity}?`);

    const tool = toolOf(events);
    expect(tool?.name).toBe("city_snapshot");
    expect(tool?.args.city).toBe(firstCity);

    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "done" });

    const snapshot = TOOL_IMPLS.city_snapshot({ city: firstCity }) as CitySnapshot | null;
    expect(snapshot).not.toBeNull();
    const text = textOf(events);
    expect(text.toLowerCase()).toContain(firstCity);
    expect(text).toContain(Number(snapshot?.count).toLocaleString("en-CA"));
    expect(text).toContain(`$${Math.round(Number(snapshot?.medianPrice)).toLocaleString("en-CA")}`);
  });

  it("compares two mentioned cities in the order they appear", async () => {
    const events = await collect(`Compare ${firstCity} and ${secondCity}`);

    const tool = toolOf(events);
    expect(tool?.name).toBe("compare_cities");
    expect(tool?.args.cities).toEqual([firstCity, secondCity]);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);

    const text = textOf(events);
    expect(text.toLowerCase()).toContain(firstCity);
    expect(text.toLowerCase()).toContain(secondCity);
  });

  it("does not match a city name inside another city name", async () => {
    // Hamilton ends with "milton", so substring matching would pick the wrong city.
    const events = await collect("Compare Hamilton and Kitchener");

    const tool = toolOf(events);
    expect(tool?.name).toBe("compare_cities");
    expect(tool?.args.cities).toEqual(["hamilton", "kitchener"]);
  });

  it("searches with a bed filter when the question has one", async () => {
    const events = await collect(`Cheapest 3-bed houses in ${firstCity}`);

    const tool = toolOf(events);
    expect(tool?.name).toBe("search_listings");
    expect(tool?.args.city).toBe(firstCity);
    expect(tool?.args.beds).toBe(3);
    expect(textOf(events).length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("answers a deal question with find_deals and the top discount", async () => {
    const events = await collect("Find undervalued listings in Brampton");

    const tool = toolOf(events);
    expect(tool?.name).toBe("find_deals");
    expect(tool?.args.city).toBe("brampton");
    expect(events.some((event) => event.type === "tool_result")).toBe(true);

    const data = toolResultsOf(events)[0]?.data as FindDealsResult;
    expect(data.totalMatches).toBeGreaterThan(0);
    expect(toolResultsOf(events)[0]?.summary).toBe(
      `${data.totalMatches.toLocaleString("en-CA")} deals in brampton, top ${Math.round(
        Number(data.listings[0].discountPct),
      )}% below estimate`,
    );
    const text = textOf(events);
    expect(text).toContain("below the comparable-listings estimate");
    expect(text).toContain(`${data.listings[0].discountPct}% below estimate`);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("answers a question with no known city without calling a tool", async () => {
    const events = await collect("Hello there, what can you do?");

    expect(toolOf(events)).toBeUndefined();
    expect(textOf(events)).toContain("Canadian");
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("caps tool iterations and LLM calls per turn", async () => {
    let llmCalls = 0;
    const loopProvider: Provider = {
      name: "loop",
      // eslint-disable-next-line require-yield -- generator contract only
      async *stream() {
        llmCalls += 1;
        yield {
          type: "tool_call" as const,
          id: `call_${llmCalls}`,
          name: "city_snapshot",
          arguments: JSON.stringify({ city: firstCity }),
        };
      },
    };

    const events = await collect("anything", loopProvider);

    expect(llmCalls).toBe(MAX_LLM_CALLS_PER_TURN);
    expect(events.filter((event) => event.type === "tool").length).toBe(MAX_TOOL_ITERATIONS);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("reports budget exhaustion with a stable code and no internal detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = await collect("What does $800k buy in Ottawa?", createMockProvider(), {
      beforeLlmCall: () => {
        throw new BudgetExhaustedError("daily LLM budget reached");
      },
    });

    expect(events).toEqual([
      { type: "error", code: "budget_exhausted", message: expect.any(String) },
    ]);
    expect(JSON.stringify(events)).not.toContain("daily LLM budget reached");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("daily LLM budget reached"));
    spy.mockRestore();
  });

  it("surfaces provider failures as provider_error without leaking details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: Provider = {
      name: "failing",
      async *stream() {
        throw new Error("upstream exploded: key abc123");
      },
    };

    const events = await collect("anything", failing);

    expect(events).toEqual([
      { type: "error", code: "provider_error", message: expect.any(String) },
    ]);
    expect(JSON.stringify(events)).not.toContain("upstream exploded");
    expect(JSON.stringify(events)).not.toContain("abc123");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("upstream exploded"));
    spy.mockRestore();
  });

  it("maps a missing provider key to misconfigured", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unconfigured: Provider = {
      name: "unconfigured",
      async *stream() {
        throw new ProviderError("GROQ_API_KEY is not set", "config");
      },
    };

    const events = await collect("anything", unconfigured);

    expect(events).toEqual([{ type: "error", code: "misconfigured", message: expect.any(String) }]);
    expect(JSON.stringify(events)).not.toContain("GROQ_API_KEY");
    spy.mockRestore();
  });

  it("formats SSE frames as one JSON payload per data line", () => {
    expect(sseEvent({ type: "text", delta: "hi" })).toBe('data: {"type":"text","delta":"hi"}\n\n');
    expect(sseEvent({ type: "done" })).toBe('data: {"type":"done"}\n\n');
  });
});

describe("system prompt contract (no network)", () => {
  it("asks for a missing required detail instead of declining", () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toMatch(/missing[^.]*detail/);
    expect(prompt).toMatch(/do not decline/);
    expect(prompt).toMatch(/ask one brief question/);
  });

  it("documents the offline comparable-listings estimate and the deal tool", () => {
    expect(SYSTEM_PROMPT).toContain("offline estimate of the typical asking price for similar listings");
    expect(SYSTEM_PROMPT).toContain("not an appraisal, a sold price, or a prediction");
    expect(SYSTEM_PROMPT).toContain('"below the comparable-listings estimate"');
    expect(SYSTEM_PROMPT).toContain("Use find_deals for undervalued, bargain, or deal questions");
    expect(SYSTEM_PROMPT).toContain("quote discountPct exactly as the tool returns it");
    // The existing no-predictions/no-advice line stays.
    expect(SYSTEM_PROMPT).toContain("No predictions, no investment, legal, or financial advice.");
  });
});

describe("tool_result structured data (no network)", () => {
  it("attaches the city snapshot object to city_snapshot results", async () => {
    const events = await collect(`What does $800k buy in ${firstCity}?`);
    const result = toolResultsOf(events)[0];
    expect(result?.name).toBe("city_snapshot");
    expect(result?.data).toEqual(TOOL_IMPLS.city_snapshot({ city: firstCity }));
    expect((result?.data as CitySnapshot | null)?.city).toBe(firstCity);
  });

  it("attaches the snapshot array to compare_cities results", async () => {
    const events = await collect(`Compare ${firstCity} and ${secondCity}`);
    const result = toolResultsOf(events)[0];
    expect(result?.name).toBe("compare_cities");
    expect(Array.isArray(result?.data)).toBe(true);
    expect(result?.data).toEqual(TOOL_IMPLS.compare_cities({ cities: [firstCity, secondCity] }));
  });

  it("attaches search results with totalMatches, returned, and listings", async () => {
    const events = await collect(`Cheapest 3-bed houses in ${firstCity}`);
    const result = toolResultsOf(events)[0];
    expect(result?.name).toBe("search_listings");
    const data = result?.data as { totalMatches: number; returned: number; listings: unknown[] };
    expect(Object.keys(data).sort()).toEqual(["listings", "returned", "totalMatches"]);
    expect(data.totalMatches).toBeGreaterThan(0);
    expect(data.listings.length).toBe(data.returned);
    expect(result?.summary).toContain("cheapest $");
  });

  it("passes tool rows through untouched, extra dataset keys included", async () => {
    const fixture = {
      totalMatches: 2,
      returned: 2,
      listings: [
        {
          city: firstCity,
          fsa: "M6P",
          price: 650000,
          beds: 2,
          baths: 1,
          sqft: 700,
          seen: "2026-09-01",
          url: "https://example.test/listing-1",
          address: "1 Test Street",
        },
        {
          city: firstCity,
          fsa: "M6P",
          price: 720000,
          beds: 3,
          baths: 2,
          sqft: 900,
          seen: "2026-09-02",
          url: "https://example.test/listing-2",
          address: "2 Test Street",
        },
      ],
    };
    const spy = vi.spyOn(TOOL_IMPLS, "search_listings").mockReturnValue(fixture);
    const provider: Provider = {
      name: "one-shot",
      async *stream() {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "search_listings",
          arguments: JSON.stringify({ city: firstCity, fsa: "M6P" }),
        };
      },
    };

    try {
      const events = await collect("anything", provider);
      const result = toolResultsOf(events)[0];
      expect(result?.data).toBe(fixture);
      const rows = (result?.data as typeof fixture).listings;
      expect(rows[0].url).toBe("https://example.test/listing-1");
      expect(rows[0].address).toBe("1 Test Street");
      expect(Object.keys(rows[0])).toContain("url");
      expect(result?.summary).toBe("2 matches, cheapest $650,000");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("tool_result summaries for filtered and ranked tools (no network)", () => {
  it("summarizes a filtered city_snapshot over the filtered subset", async () => {
    const all = TOOL_IMPLS.city_snapshot({ city: firstCity }) as CitySnapshot;
    const args = { city: firstCity, maxPrice: all.medianPrice };

    const events = await collect("anything", oneShotProvider("city_snapshot", args));
    const result = toolResultsOf(events)[0];
    const snapshot = TOOL_IMPLS.city_snapshot(args) as CitySnapshot | null;

    expect(result?.name).toBe("city_snapshot");
    expect(result?.data).toEqual(snapshot);
    expect(snapshot?.count).toBeLessThan(all.count);
    expect(result?.summary).toBe(
      `${firstCity}: ${Number(snapshot?.count).toLocaleString("en-CA")} listings, median $${Math.round(
        Number(snapshot?.medianPrice),
      ).toLocaleString("en-CA")}`,
    );
  });

  it("attaches and summarizes rank_areas results", async () => {
    const args = { city: firstCity, metric: "count", limit: 3 };
    const events = await collect("anything", oneShotProvider("rank_areas", args));
    const result = toolResultsOf(events)[0];
    const ranked = TOOL_IMPLS.rank_areas(args) as RankAreasResult | null;

    expect(result?.name).toBe("rank_areas");
    expect(result?.data).toEqual(ranked);
    if (ranked && ranked.areas.length > 0) {
      expect(result?.summary).toContain(`${firstCity}: ${ranked.areas.length} of ${ranked.totalAreas} areas`);
      expect(result?.summary).toContain("listing count (desc)");
    } else if (ranked && ranked.considered > 0) {
      expect(result?.summary).toBe(
        `no area with 5 or more matching listings in ${firstCity} (${ranked.considered.toLocaleString(
          "en-CA",
        )} listings considered)`,
      );
    } else {
      expect(result?.summary).toBe(`no matching listings in ${firstCity}`);
    }
  });

  it("formats rank_areas summaries with metric, area count, prices, and listing counts", async () => {
    const fixture: RankAreasResult = {
      city: firstCity,
      metric: "median_price",
      order: "asc",
      considered: 40,
      areas: [
        { fsa: "M1B", count: 8, medianPrice: 520_000 },
        { fsa: "M1C", count: 6, medianPrice: 560_500 },
        { fsa: "M1E", count: 5, medianPrice: 580_000 },
      ],
      totalAreas: 12,
    };
    const spy = vi.spyOn(TOOL_IMPLS, "rank_areas").mockReturnValue(fixture);
    try {
      const events = await collect("anything", oneShotProvider("rank_areas", { city: firstCity, limit: 3 }));
      const result = toolResultsOf(events)[0];
      expect(result?.data).toBe(fixture);
      expect(result?.summary).toBe(
        `${firstCity}: 3 of 12 areas by median price (asc): M1B $520,000 (8), M1C $560,500 (6), M1E $580,000 (5)`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("labels count rankings and reports empty area lists", async () => {
    const spy = vi.spyOn(TOOL_IMPLS, "rank_areas");
    try {
      spy.mockReturnValue({
        city: firstCity,
        metric: "count",
        order: "desc",
        considered: 9,
        areas: [{ fsa: "M1B", count: 9, medianPrice: 500_000 }],
        totalAreas: 1,
      });
      let events = await collect("anything", oneShotProvider("rank_areas", { city: firstCity }));
      expect(toolResultsOf(events)[0]?.summary).toBe(
        `${firstCity}: 1 of 1 areas by listing count (desc): M1B $500,000 (9)`,
      );

      spy.mockReturnValue({
        city: firstCity,
        metric: "median_price",
        order: "asc",
        considered: 0,
        areas: [],
        totalAreas: 0,
      });
      events = await collect("anything", oneShotProvider("rank_areas", { city: firstCity }));
      expect(toolResultsOf(events)[0]?.summary).toBe(`no matching listings in ${firstCity}`);

      spy.mockReturnValue({
        city: firstCity,
        metric: "median_price",
        order: "asc",
        considered: 9,
        areas: [],
        totalAreas: 0,
      });
      events = await collect("anything", oneShotProvider("rank_areas", { city: firstCity }));
      expect(toolResultsOf(events)[0]?.summary).toBe(
        `no area with 5 or more matching listings in ${firstCity} (9 listings considered)`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("summarizes find_deals results, quoting the top discount", async () => {
    const spy = vi.spyOn(TOOL_IMPLS, "find_deals");
    try {
      spy.mockReturnValue({
        city: "brampton",
        minDiscount: 20,
        considered: 928,
        totalMatches: 1,
        returned: 1,
        listings: [{ discountPct: 22.4 }],
      });
      let events = await collect("anything", oneShotProvider("find_deals", { city: "brampton" }));
      expect(toolResultsOf(events)[0]?.summary).toBe("1 deal in brampton, top 22% below estimate");

      spy.mockReturnValue({
        city: "brampton",
        minDiscount: 20,
        considered: 928,
        totalMatches: 0,
        returned: 0,
        listings: [],
      });
      events = await collect("anything", oneShotProvider("find_deals", { city: "brampton" }));
      expect(toolResultsOf(events)[0]?.summary).toBe(
        "no deals in brampton at or above 20% below estimate (928 listings considered)",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("api/chat route guards (no network)", () => {
  beforeAll(() => {
    vi.stubEnv("MOCK_LLM", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    globalThis.__housingGuardState = createGuardState({
      maxPerMinute: 100,
      maxPerDay: 1_000,
      budgetPerDay: 1_000,
    });
  });

  function postRequest(
    options: { contentType?: string; origin?: string; body?: string } = {},
  ): NextRequest {
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/json",
    };
    if (options.origin) headers.origin = options.origin;
    return new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers,
      body:
        options.body ??
        JSON.stringify({ messages: [{ role: "user", content: "What does 800k buy in Ottawa?" }] }),
    });
  }

  it("rejects a non-JSON content type with 415", async () => {
    const response = await POST(postRequest({ contentType: "text/plain" }));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "unsupported_media_type" });
  });

  it("rejects lookalike media types with 415", async () => {
    for (const contentType of [
      "text/application/json",
      "application/jsonp",
      "application/json-patch+json",
    ]) {
      const response = await POST(postRequest({ contentType }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported_media_type" });
    }
  });

  it("accepts application/json with parameters", async () => {
    const response = await POST(postRequest({ contentType: "application/json; charset=UTF-8" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.text();
  });

  it("rejects a mismatched Origin with 403", async () => {
    const response = await POST(postRequest({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
  });

  it("accepts a same-origin JSON request and streams SSE events", async () => {
    const response = await POST(postRequest({ origin: "http://localhost:3000" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const payload = await response.text();
    expect(payload).toContain('"type":"tool"');
    expect(payload).toContain('"type":"tool_result"');
    expect(payload).toContain('"data":');
    expect(payload).toContain('"type":"done"');
  });

  it("still serves a valid request after rejected ones", async () => {
    await POST(postRequest({ contentType: "text/plain" }));
    await POST(postRequest({ origin: "https://evil.example" }));
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    await response.text();
  });
});
