import { afterEach, describe, expect, it, vi } from "vitest";

import { __setClientFactory, traceChatTurn } from "../lib/langfuse";

const CONTENT_LIKE_KEY = /message|content|answer|text|key|token|ip|question|prompt|query|reply|completion/i;

type TraceCall = { name: string; metadata: Record<string, unknown> };
type SpanCall = {
  name: string;
  startTime?: Date;
  endTime?: Date;
  metadata: Record<string, unknown>;
};

// First dynamic import/construct fails, later ones succeed, so the retry test
// can observe that a rejected load is not memoized forever.
const langfuseMock = vi.hoisted(() => ({
  attempts: 0,
  traces: [] as TraceCall[],
  spans: [] as SpanCall[],
  flushes: 0,
}));

vi.mock("langfuse", () => ({
  Langfuse: class {
    constructor() {
      langfuseMock.attempts += 1;
      if (langfuseMock.attempts === 1) throw new Error("construct failed");
    }
    trace(body: TraceCall) {
      langfuseMock.traces.push(body);
      return {
        span(spanBody: SpanCall) {
          langfuseMock.spans.push(spanBody);
          return {};
        },
      };
    }
    async flushAsync() {
      langfuseMock.flushes += 1;
    }
  },
}));

function fakeClient() {
  const traces: TraceCall[] = [];
  const spans: SpanCall[] = [];
  let flushes = 0;
  const client = {
    trace(body: TraceCall) {
      traces.push(body);
      return {
        span(body: SpanCall) {
          spans.push(body);
          return {};
        },
      };
    },
    async flushAsync() {
      flushes += 1;
    },
  };
  return { client, traces, spans, flushes: () => flushes };
}

function contentLikeKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(contentLikeKeys);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      CONTENT_LIKE_KEY.test(key) ? [key, ...contentLikeKeys(child)] : contentLikeKeys(child),
    );
  }
  return [];
}

const turn = () => ({
  durationMs: 125,
  cached: false,
  tools: ["search_listings", "city_snapshot"],
  errorCode: "provider_error",
  toolSpans: [
    { name: "search_listings", startMs: 1_000, endMs: 1_030 },
    { name: "city_snapshot", startMs: 1_050, endMs: 1_120 },
  ],
});

describe("traceChatTurn", () => {
  afterEach(() => {
    __setClientFactory(null);
    vi.unstubAllEnvs();
  });

  it("no-ops without keys and never calls the injected factory", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const factory = vi.fn(() => {
      throw new Error("factory must not run");
    });
    __setClientFactory(factory);

    expect(() => traceChatTurn(turn())).not.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("records one trace, one span per tool span, and a flush when keys are set", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    const fake = fakeClient();
    __setClientFactory(() => fake.client);

    traceChatTurn(turn());

    expect(fake.traces).toHaveLength(1);
    expect(fake.traces[0].name).toBe("chat_turn");
    expect(fake.traces[0].metadata).toEqual({
      durationMs: 125,
      cached: false,
      tools: ["search_listings", "city_snapshot"],
      errorCode: "provider_error",
    });
    expect(fake.spans).toHaveLength(2);
    expect(fake.spans[0]).toMatchObject({
      name: "tool:search_listings",
      metadata: { durationMs: 30 },
    });
    expect(fake.spans[0].startTime).toEqual(new Date(1_000));
    expect(fake.spans[0].endTime).toEqual(new Date(1_030));
    expect(fake.spans[1]).toMatchObject({
      name: "tool:city_snapshot",
      metadata: { durationMs: 70 },
    });
    expect(fake.spans[1].startTime).toEqual(new Date(1_050));
    expect(fake.spans[1].endTime).toEqual(new Date(1_120));
    expect(fake.flushes()).toBe(1);
    expect(contentLikeKeys({ traces: fake.traces, spans: fake.spans })).toEqual([]);
  });

  it("omits an undefined errorCode and sends no content-like keys", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    const fake = fakeClient();
    __setClientFactory(() => fake.client);

    traceChatTurn({ durationMs: 5, cached: true, tools: [] });

    expect(fake.traces[0].metadata).toEqual({ durationMs: 5, cached: true, tools: [] });
    expect(contentLikeKeys(fake.traces)).toEqual([]);
  });

  it("builds one span per same-name tool call from the provided toolSpans", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    const fake = fakeClient();
    __setClientFactory(() => fake.client);

    traceChatTurn({
      durationMs: 50,
      cached: false,
      tools: ["search_listings"],
      toolSpans: [
        { name: "search_listings", startMs: 0, endMs: 10 },
        { name: "search_listings", startMs: 20, endMs: 45 },
      ],
    });

    expect(fake.traces.map((trace) => trace.name)).toEqual(["chat_turn"]);
    expect(fake.spans.map((span) => span.name)).toEqual([
      "tool:search_listings",
      "tool:search_listings",
    ]);
    expect(fake.spans.map((span) => span.metadata.durationMs)).toEqual([10, 25]);
    expect(fake.spans.map((span) => [span.startTime?.getTime(), span.endTime?.getTime()])).toEqual([
      [0, 10],
      [20, 45],
    ]);
  });

  it("returns normally when the client throws on trace, span, or flush", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");

    __setClientFactory(() => ({
      trace() {
        throw new Error("trace failed");
      },
      async flushAsync() {},
    }));
    expect(() => traceChatTurn(turn())).not.toThrow();

    __setClientFactory(() => ({
      trace() {
        return {
          span() {
            throw new Error("span failed");
          },
        };
      },
      async flushAsync() {},
    }));
    expect(() => traceChatTurn(turn())).not.toThrow();

    __setClientFactory(() => ({
      trace() {
        return { span() {} };
      },
      flushAsync() {
        throw new Error("flush failed");
      },
    }));
    expect(() => traceChatTurn(turn())).not.toThrow();
  });

  it("returns normally when the factory itself throws", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    __setClientFactory(() => {
      throw new Error("factory failed");
    });

    expect(() => traceChatTurn(turn())).not.toThrow();
  });

  it("retries the real client load after a failed import/construct", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    langfuseMock.attempts = 0;
    langfuseMock.traces.length = 0;
    langfuseMock.spans.length = 0;
    langfuseMock.flushes = 0;

    traceChatTurn({ durationMs: 1, cached: false, tools: [] });
    await vi.waitFor(() => expect(langfuseMock.attempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    traceChatTurn({ durationMs: 2, cached: false, tools: [] });
    await vi.waitFor(() => expect(langfuseMock.traces).toHaveLength(1));

    expect(langfuseMock.attempts).toBe(2);
    expect(langfuseMock.traces[0].metadata).toEqual({ durationMs: 2, cached: false, tools: [] });
    expect(langfuseMock.flushes).toBe(1);
  });
});
