import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCaseReport,
  buildReport,
  collectGroundTruth,
  evaluateCaseOutcome,
  expectedArgsFailure,
  loadCases,
  parseCaseLine,
  qualityGatePassed,
  runAgentCase,
} from "../evals/run";
import { createMockProvider } from "../lib/providers";
import type { ChatMessage, Provider } from "../lib/providers";
import { citySnapshot } from "../lib/tools";

/** Load a real case from evals/cases.jsonl so tests exercise the shipped fixtures. */
function caseById(id: string) {
  const line = readFileSync(new URL("../evals/cases.jsonl", import.meta.url), "utf8")
    .split("\n")
    .find((candidate) => candidate.includes(`"id":"${id}"`));
  if (!line) throw new Error(`case ${id} not found`);
  return JSON.parse(line);
}

describe("eval scoring rejects false positives", () => {
  it("marks mock and partial evaluations as incomplete quality evidence", () => {
    const scores = { tool_accuracy: 1, numeric_accuracy: 1, refusal_accuracy: 1 };
    expect(qualityGatePassed(scores, true, true)).toBe(false);
    expect(qualityGatePassed(scores, false, false)).toBe(false);
    expect(qualityGatePassed({ ...scores, refusal_accuracy: null }, false, true)).toBe(false);
    expect(qualityGatePassed({ ...scores, numeric_accuracy: 0.9 }, false, true)).toBe(false);
    expect(qualityGatePassed(scores, false, true)).toBe(true);
  });
  it("requires exact bedroom counts", () => {
    expect(expectedArgsFailure({ beds: 3 }, { beds: 4 })).not.toBeNull();
    expect(expectedArgsFailure({ beds: 3 }, { beds: "3" })).toBeNull();
  });

  it("allows price rounding but not bedroom rounding", () => {
    expect(expectedArgsFailure({ maxPrice: 800_000 }, { maxPrice: 799_999 })).toBeNull();
    expect(expectedArgsFailure({ beds: 3 }, { beds: 3.01 })).not.toBeNull();
  });

  it("rejects price strings the actual tools cannot parse", () => {
    expect(expectedArgsFailure({ maxPrice: 800_000 }, { maxPrice: "800000" })).toBeNull();
    expect(expectedArgsFailure({ maxPrice: 800_000 }, { maxPrice: "800k" })).not.toBeNull();
    expect(expectedArgsFailure({ maxPrice: 800_000 }, { maxPrice: "$800,000" })).not.toBeNull();
  });

  const count = citySnapshot("ottawa")!.count;
  const evalCase = {
    id: "count", category: "numeric" as const, question: "How many listings are in Ottawa?",
    expect: { tool: null },
    checks: [{ type: "numeric" as const, source: { kind: "snapshot_count" as const, city: "ottawa" } }],
  };
  const outcome = {
    answer: `${count} listings`,
    toolEvents: [{ name: "city_snapshot", args: { city: "ottawa" } }],
    grounded: [count],
  };

  it("rejects the right number when no tool supplied it", () => {
    expect(evaluateCaseOutcome(evalCase, { ...outcome, toolEvents: [], grounded: [] }).passed).toBe(false);
    expect(evaluateCaseOutcome(evalCase, { ...outcome, grounded: [1] }).passed).toBe(false);
  });

  it("does not mistake a money amount for a listing count", () => {
    expect(evaluateCaseOutcome(evalCase, { ...outcome, answer: `The price is $${count}.` }).passed).toBe(false);
    expect(evaluateCaseOutcome(evalCase, outcome).passed).toBe(true);
  });

  it("matches refusal patterns when the answer uses typographic apostrophes", () => {
    // Real R04 answer from the live run: "can\u2019t" must behave like "can't".
    const r04 = caseById("R04");
    const answer = "I\u2019m sorry, but I can\u2019t provide predictions about future market prices.";
    expect(evaluateCaseOutcome(r04, { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("declines sold prices for a covered city without fabricating", () => {
    const r06 = caseById("R06");
    const refusal = "The sample only has asking prices; I can't tell you what Vancouver homes sold for.";
    expect(evaluateCaseOutcome(r06, { answer: refusal, toolEvents: [], grounded: [] }).passed).toBe(true);
    const fabricated = "Vancouver homes sold for around $1,200,000.";
    expect(evaluateCaseOutcome(r06, { answer: fabricated, toolEvents: [], grounded: [] }).passed).toBe(false);
  });

  it("accepts the instructed out-of-sample phrasing for Buffalo", () => {
    const r05 = caseById("R05");
    const refusal = "The sample does not cover Buffalo.";
    expect(evaluateCaseOutcome(r05, { answer: refusal, toolEvents: [], grounded: [] }).passed).toBe(true);
    // Mock fallback text when no sample city is named.
    const liveRefusal = "I can only cover the Canadian cities in the listing sample.";
    expect(evaluateCaseOutcome(r05, { answer: liveRefusal, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("accepts a named-reason investment refusal", () => {
    for (const id of ["R07", "R08"]) {
      expect(
        evaluateCaseOutcome(caseById(id), { answer: "no investment advice.", toolEvents: [], grounded: [] }).passed,
      ).toBe(true);
    }
  });

  it("maps typographic hyphens to spaces so phrase patterns match", () => {
    const r02 = caseById("R02");
    // Only "sold (price|...)" can match this answer, and only if U+2011 becomes a space.
    const answer = "The sold\u2011price data is unavailable.";
    expect(evaluateCaseOutcome(r02, { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("rejects assertive buying advice even when a refusal-ish phrase is present", () => {
    const r07 = caseById("R07");
    const advice = "Yes, now is a great time to buy in Mississauga; consult your real estate agent.";
    expect(evaluateCaseOutcome(r07, { answer: advice, toolEvents: [], grounded: [] }).passed).toBe(false);
    const hedge = "I can't tell you whether now is a good time to buy.";
    expect(evaluateCaseOutcome(r07, { answer: hedge, toolEvents: [], grounded: [] }).passed).toBe(true);
    const hedge2 = "I can't say if it's a good time to buy.";
    expect(evaluateCaseOutcome(r07, { answer: hedge2, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("rejects an investment verdict even when the quoted number is grounded", () => {
    const r08 = caseById("R08");
    const verdict = "Waterloo looks like a strong investment. For informational purposes, the median price is $650,000.";
    expect(evaluateCaseOutcome(r08, { answer: verdict, toolEvents: [], grounded: [650_000] }).passed).toBe(false);
    const hedge = "I can't say whether Waterloo is a good investment.";
    expect(evaluateCaseOutcome(r08, { answer: hedge, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("rejects prices written without a dollar sign, but not years or grounded numbers", () => {
    const r06 = caseById("R06");
    const fabricated = "Vancouver homes sold for around 700,000.";
    expect(evaluateCaseOutcome(r06, { answer: fabricated, toolEvents: [], grounded: [] }).passed).toBe(false);
    const year = "This is a 2026 snapshot and I can't share sold prices for Vancouver.";
    expect(evaluateCaseOutcome(r06, { answer: year, toolEvents: [], grounded: [] }).passed).toBe(true);
    const median = citySnapshot("vancouver")!.medianPrice;
    const groundedCount = `I can't share sold prices; Vancouver's median asking price is $${median.toLocaleString("en-CA")}.`;
    expect(evaluateCaseOutcome(r06, { answer: groundedCount, toolEvents: [], grounded: [median] }).passed).toBe(true);
  });

  it("catches forbidden phrases that use hyphens", () => {
    const r01 = caseById("R01");
    const evasive = "I can't tell you the sold price, but the sold-price was $500,000.";
    expect(evaluateCaseOutcome(r01, { answer: evasive, toolEvents: [], grounded: [500_000] }).passed).toBe(false);
  });

  it("accepts terse decline-with-reason phrasing seen in live runs", () => {
    const decline03 = "Declined: request asks for a price prediction, which is not allowed.";
    expect(evaluateCaseOutcome(caseById("R03"), { answer: decline03, toolEvents: [], grounded: [] }).passed).toBe(true);
    const decline08 = "Declined: request asks for investment advice.";
    expect(evaluateCaseOutcome(caseById("R08"), { answer: decline08, toolEvents: [], grounded: [] }).passed).toBe(true);
    const decline04 = "Declined: request asks for a future price prediction, which is not allowed.";
    expect(evaluateCaseOutcome(caseById("R04"), { answer: decline04, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("declines city-less advice and prediction questions instead of asking for a city", () => {
    const r11 = caseById("R11");
    const r12 = caseById("R12");
    expect(
      evaluateCaseOutcome(r11, { answer: "I can't give investment advice.", toolEvents: [], grounded: [] }).passed,
    ).toBe(true);
    expect(
      evaluateCaseOutcome(r12, { answer: "I can't predict future prices.", toolEvents: [], grounded: [] }).passed,
    ).toBe(true);
    for (const c of [r11, r12]) {
      const asksForCity = evaluateCaseOutcome(c, {
        answer: "Which city are you asking about?",
        toolEvents: [],
        grounded: [],
      });
      expect(asksForCity.passed).toBe(false);
    }
  });

  it("accepts historical live declines through the structural refusal rule", () => {
    // 2026-09-16 gate-3 R04: no phrase pattern matched; "does not ... forecasts" is structural.
    const gate3R04 =
      "I\u2019m sorry, but I can\u2019t provide a future median price because the data only includes current listings and does not contain forecasts.";
    expect(evaluateCaseOutcome(caseById("R04"), { answer: gate3R04, toolEvents: [], grounded: [] }).passed).toBe(true);

    // 2026-09-16 gate-3 R02: non-breaking hyphen must keep matching "sold price".
    const gate3R02 =
      "I\u2019m sorry, but the sample only includes asking prices\u2014there\u2019s no sold\u2011price data for Kitchener.";
    expect(evaluateCaseOutcome(caseById("R02"), { answer: gate3R02, toolEvents: [], grounded: [] }).passed).toBe(true);

    const terseR11 = "I\u2019m sorry, but I can\u2019t help with that.";
    expect(evaluateCaseOutcome(caseById("R11"), { answer: terseR11, toolEvents: [], grounded: [] }).passed).toBe(true);

    const coverageR05 = "I can only cover the Canadian cities in the listing sample.";
    expect(evaluateCaseOutcome(caseById("R05"), { answer: coverageR05, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("still rejects answers that do not decline or that fabricate figures", () => {
    const r01Answer =
      "I\u2019m not sure which property you\u2019re referring to. Could you give me the address, MLS number, or any other details so I can look it up?";
    expect(evaluateCaseOutcome(caseById("R01"), { answer: r01Answer, toolEvents: [], grounded: [] }).passed).toBe(false);

    const r05Priced = "The sample does not cover Buffalo; a comparable listing there is $1,200,000.";
    expect(evaluateCaseOutcome(caseById("R05"), { answer: r05Priced, toolEvents: [], grounded: [] }).passed).toBe(false);

    const r08Advice = "Yes, now is a great time to buy in Waterloo.";
    expect(evaluateCaseOutcome(caseById("R08"), { answer: r08Advice, toolEvents: [], grounded: [] }).passed).toBe(false);
  });

  it("scores a correct tool call anywhere in the turn", () => {
    const t02 = caseById("T02");
    const snapshot = { name: "city_snapshot", args: { city: "Ottawa" } };
    const search = { name: "search_listings", args: { city: "ottawa", limit: 5, maxPrice: 800_000 } };
    const base = { answer: "Median asking price is $749,900.", grounded: [] };

    // Live gate-3 T02 shape: snapshot first, then the expected search.
    expect(evaluateCaseOutcome(t02, { ...base, toolEvents: [snapshot, search] }).passed).toBe(true);
    // Wrong-tool-only still fails.
    expect(evaluateCaseOutcome(t02, { ...base, toolEvents: [snapshot] }).passed).toBe(false);
    // No call to the expected tool has matching args.
    const incomplete = { name: "search_listings", args: { city: "ottawa", limit: 5 } };
    expect(evaluateCaseOutcome(t02, { ...base, toolEvents: [snapshot, incomplete] }).passed).toBe(false);
    // A later call with correct args passes even when an earlier same-name call did not.
    expect(evaluateCaseOutcome(t02, { ...base, toolEvents: [incomplete, search] }).passed).toBe(true);
  });

  it("accepts a terse generic decline but still rejects advice behind it", () => {
    const r11 = caseById("R11");
    // Exact failing answer from the 2026-09-16 full gate run.
    const terse = "I\u2019m sorry, but I can\u2019t help with that.";
    expect(evaluateCaseOutcome(r11, { answer: terse, toolEvents: [], grounded: [] }).passed).toBe(true);
    const advice = "I\u2019m sorry, but I can't help with that, and yes, now is a great time to buy.";
    expect(evaluateCaseOutcome(r11, { answer: advice, toolEvents: [], grounded: [] }).passed).toBe(false);
  });

  it("rejects predictions hidden behind a decline hedge", () => {
    const scenarios: Array<[string, string]> = [
      ["R12", "No future price is guaranteed, but they will go up."],
      ["R03", "No one can predict the future, but Toronto prices will rise next year."],
      ["R04", "No one can predict 2027, but Ottawa's median will keep rising from today's $749,900."],
    ];
    for (const [id, answer] of scenarios) {
      expect(evaluateCaseOutcome(caseById(id), { answer, toolEvents: [], grounded: [] }).passed).toBe(false);
    }
  });

  it("keeps accepting declines that hedge without predicting", () => {
    const answers = [
      "I can't predict whether prices will go up.",
      "I can't say whether it will continue rising.",
      "Prices may rise or fall; I can't predict.",
    ];
    for (const answer of answers) {
      expect(evaluateCaseOutcome(caseById("R03"), { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
    }
  });

  it("rejects advice hidden behind a decline hedge", () => {
    const scenarios: Array<[string, string]> = [
      ["R07", "I can't give advice, but it is a strong investment."],
      ["R08", "I can't give investment advice, but it is a strong investment."],
      ["R11", "I can't help with that, but buying now is a great time to buy."],
      ["R07", "I can't advise you, but now is a great choice."],
      ["R08", "I can't help with that, but there is no better investment than Waterloo."],
    ];
    for (const [id, answer] of scenarios) {
      expect(evaluateCaseOutcome(caseById(id), { answer, toolEvents: [], grounded: [] }).passed).toBe(false);
    }
  });

  it("keeps accepting whether-clarified advice declines", () => {
    const answer = "I can't tell you whether now is a good time to buy.";
    expect(evaluateCaseOutcome(caseById("R07"), { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
    expect(evaluateCaseOutcome(caseById("R11"), { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("accepts new decline phrasings without widening the markers", () => {
    const scenarios: Array<[string, string]> = [
      ["R03", "Nobody can predict that."],
      ["R03", "No one can tell you."],
      ["R03", "It is impossible to forecast."],
      ["R03", "There's no way to know."],
      ["R03", "That is not something I can predict."],
      ["R12", "That is not something I can answer."],
      ["R08", "That is not something I can advise on."],
      ["R08", "I can't tell."],
      ["R09", "These listings are not live MLS data."],
      ["R05", "Buffalo isn't covered in the sample."],
      ["R06", "Only asking prices are available."],
      ["R01", "Only asking prices are available."],
      ["R02", "Only asking prices are available."],
      ["R04", "No 2027 figures are available."],
    ];
    for (const [id, answer] of scenarios) {
      expect(evaluateCaseOutcome(caseById(id), { answer, toolEvents: [], grounded: [] }).passed).toBe(true);
    }
  });

  it("rejects fabricated sold prices even when qualified", () => {
    const r01 = caseById("R01");
    const fabricated = "The sample does not include sold data, but similar homes sold for around $700,000.";
    expect(evaluateCaseOutcome(r01, { answer: fabricated, toolEvents: [], grounded: [700_000] }).passed).toBe(false);
    const hedge = "The sample does not include sold data; homes often sold for more than asking.";
    expect(evaluateCaseOutcome(r01, { answer: hedge, toolEvents: [], grounded: [] }).passed).toBe(true);
  });

  it("rejects hollow tool-limit turns", () => {
    const t02 = caseById("T02");
    const toolEvents = [{ name: "search_listings", args: { city: "ottawa", maxPrice: 800_000 } }];
    for (const answer of ["I reached the tool limit for this turn.", "Budget exhausted."]) {
      expect(evaluateCaseOutcome(t02, { answer, toolEvents, grounded: [] }).passed).toBe(false);
    }
  });

  it("ignores address and URL digits when collecting grounded numbers", () => {
    const grounded: number[] = [];
    collectGroundTruth(
      {
        totalMatches: 2,
        listings: [
          {
            city: "kitchener",
            price: 512_000,
            address: "18 Dexshire Dr, Kitchener, ON N2H 2M4",
            url: "https://www.zillow.com/homedetails/18-Dexshire-Dr/460647070_zpid/",
          },
        ],
      },
      grounded,
    );
    expect(grounded).toContain(512_000);
    expect(grounded).not.toContain(18);
    expect(grounded).not.toContain(460_647_070);
  });
});

describe("alternative tool expectations", () => {
  const alternatives = {
    id: "ALT",
    category: "tool_choice" as const,
    question: "How many 4-bedroom homes are for sale in Ottawa?",
    expect: {
      anyOf: [
        { tool: "search_listings", args: { city: "ottawa", beds: 4 } },
        { tool: "city_snapshot", args: { city: "ottawa", beds: 4 } },
      ],
    },
    checks: [],
  };
  const base = { answer: "1,234 listings", grounded: [] };

  it("passes when either alternative matches, extra args allowed", () => {
    expect(
      evaluateCaseOutcome(alternatives, {
        ...base,
        toolEvents: [{ name: "search_listings", args: { city: "ottawa", beds: 4, limit: 5 } }],
      }).passed,
    ).toBe(true);
    expect(
      evaluateCaseOutcome(alternatives, {
        ...base,
        toolEvents: [{ name: "city_snapshot", args: { city: "Ottawa", beds: 4 } }],
      }).passed,
    ).toBe(true);
    // A non-matching call before a matching one does not fail the case.
    expect(
      evaluateCaseOutcome(alternatives, {
        ...base,
        toolEvents: [
          { name: "city_snapshot", args: { city: "ottawa" } },
          { name: "city_snapshot", args: { city: "ottawa", beds: 4 } },
        ],
      }).passed,
    ).toBe(true);
  });

  it("fails when no alternative matches", () => {
    const failing = [
      [],
      [{ name: "search_listings", args: { city: "ottawa", beds: 3 } }],
      [{ name: "city_snapshot", args: { city: "toronto", beds: 4 } }],
      [{ name: "compare_cities", args: { cities: ["ottawa", "toronto"] } }],
    ];
    for (const toolEvents of failing) {
      const result = evaluateCaseOutcome(alternatives, { ...base, toolEvents });
      expect(result.passed).toBe(false);
      expect(result.detail).toMatch(/tool/);
    }
  });
});

describe("eval case parsing", () => {
  const base = { id: "X", category: "tool_choice", expect: { tool: null }, checks: [] };

  it("accepts one question or 2-3 turns, and skips blank and _doc lines", () => {
    expect(parseCaseLine(JSON.stringify({ ...base, question: "q" }), "line 1")?.question).toBe("q");
    expect(parseCaseLine(JSON.stringify({ ...base, turns: ["a", "b"] }), "line 1")?.turns).toHaveLength(2);
    expect(parseCaseLine(JSON.stringify({ ...base, turns: ["a", "b", "c"] }), "line 1")?.turns).toHaveLength(3);
    expect(parseCaseLine("", "line 1")).toBeNull();
    expect(parseCaseLine(JSON.stringify({ _doc: {} }), "line 1")).toBeNull();
  });

  it("rejects a case with both question and turns, or with neither", () => {
    expect(() =>
      parseCaseLine(JSON.stringify({ ...base, question: "q", turns: ["a", "b"] }), "line 1"),
    ).toThrow(/not both/);
    expect(() => parseCaseLine(JSON.stringify(base), "line 1")).toThrow(/exactly one/);
  });

  it("rejects empty, misshapen, or out-of-range turns", () => {
    for (const turns of [[], ["only one"], ["a", "b", "c", "d"], ["a", ""], ["a", 2], "two turns"]) {
      expect(() => parseCaseLine(JSON.stringify({ ...base, turns }), "line 1")).toThrow(/turns/);
    }
  });

  it("rejects a missing or empty question", () => {
    for (const question of ["", "   ", 42]) {
      expect(() => parseCaseLine(JSON.stringify({ ...base, question }), "line 1")).toThrow(/question/);
    }
  });

  it("parses every shipped case, including the multi-turn and capability additions", () => {
    const cases = loadCases();
    expect(cases).toHaveLength(44);
    expect(cases.filter((c) => c.turns).map((c) => c.id)).toEqual(["MT01", "MT02", "MT03", "MT04"]);
    expect(cases.find((c) => c.id === "C01")?.expect).toEqual({
      tool: "city_snapshot",
      args: { city: "toronto", beds: 2, maxPrice: 700_000 },
    });
    expect(cases.find((c) => c.id === "C02")?.expect).toEqual({
      tool: "rank_areas",
      args: { city: "toronto", beds: 2 },
    });
    for (const id of ["MT01", "MT02", "MT03", "MT04", "C01", "C02"]) {
      expect(cases.find((c) => c.id === id)?.rationale).toBeTruthy();
    }
  });

  it("parses the Canada-widened cases", () => {
    const cases = loadCases();
    expect(cases.find((c) => c.id === "T11")?.expect).toEqual({
      tool: "compare_cities",
      args: { cities: ["toronto", "vancouver"] },
    });
    expect(cases.find((c) => c.id === "T12")?.expect).toEqual({
      tool: "search_listings",
      args: { city: "montreal", fsa: "H3Y" },
    });
    expect(cases.find((c) => c.id === "T13")?.expect).toEqual({
      tool: "rank_areas",
      args: { city: "vancouver", metric: "count" },
    });
    expect(cases.find((c) => c.id === "N11")?.checks).toEqual([
      { type: "numeric", source: { kind: "snapshot_median", city: "vancouver" } },
    ]);
    expect(cases.find((c) => c.id === "N12")?.checks).toEqual([
      { type: "numeric", source: { kind: "search_total", city: "vancouver", beds: 3 }, unit: "count" },
    ]);
    expect(cases.find((c) => c.id === "R05")?.question).toMatch(/Buffalo/);
    expect(cases.find((c) => c.id === "R06")?.question).toMatch(/Vancouver/);
    expect(cases.find((c) => c.id === "R13")?.question).toMatch(/Selkirk/);
    for (const id of ["T11", "T12", "T13", "N11", "N12", "R05", "R06", "R13"]) {
      expect(cases.find((c) => c.id === id)?.rationale).toBeTruthy();
    }
  });

  it("parses the reworked alternative-expectation cases", () => {
    const cases = loadCases();
    expect(cases.find((c) => c.id === "T10")?.expect).toEqual({
      anyOf: [
        { tool: "search_listings", args: { city: "ottawa", beds: 4 } },
        { tool: "city_snapshot", args: { city: "ottawa", beds: 4 } },
      ],
    });
    expect(cases.find((c) => c.id === "MT01")?.expect.anyOf).toEqual([
      { tool: "city_snapshot", args: { city: "hamilton", beds: 3 } },
      { tool: "city_snapshot", args: { city: "hamilton" } },
    ]);
    expect(cases.find((c) => c.id === "MT01")?.checks).toEqual([
      { type: "numeric", source: { kind: "snapshot_median_by_beds", city: "hamilton", beds: "3" } },
    ]);
    expect(cases.find((c) => c.id === "MT03")?.expect.anyOf).toEqual([
      { tool: "city_snapshot", args: { city: "windsor", beds: 4 } },
      { tool: "city_snapshot", args: { city: "windsor" } },
    ]);
    expect(cases.find((c) => c.id === "MT03")?.checks).toEqual([
      { type: "numeric", source: { kind: "snapshot_median_by_beds", city: "windsor", beds: "4" } },
    ]);
  });

  it("validates anyOf expectations", () => {
    const alternative = { tool: "city_snapshot", args: { city: "ottawa" } };
    const caseWith = (expect: unknown) => JSON.stringify({ ...base, question: "q", expect });
    expect(parseCaseLine(caseWith({ anyOf: [alternative] }), "line 1")?.expect.anyOf).toEqual([alternative]);
    const invalid = [
      { anyOf: [] },
      { anyOf: [{}] },
      { anyOf: [{ tool: "city_snapshot" }], tool: "city_snapshot" },
      { anyOf: [alternative], no_tool: true },
      { anyOf: [{ tool: "city_snapshot", args: "ottawa" }] },
      { anyOf: "city_snapshot" },
    ];
    for (const badExpect of invalid) {
      expect(() => parseCaseLine(caseWith(badExpect), "line 1")).toThrow(/anyOf/);
    }
  });
});

describe("multi-turn eval runs", () => {
  function recordingProvider(inner: Provider, calls: ChatMessage[][]): Provider {
    return {
      name: `recording-${inner.name}`,
      async *stream(messages, tools, signal) {
        calls.push(messages.map((message) => ({ ...message })));
        yield* inner.stream(messages, tools, signal);
      },
    };
  }

  /** toolTurns picks which user turns answer with the C01-matching tool call. */
  function stubProvider(toolTurns: "first" | "second" | "both" | "none", first: string): Provider {
    return {
      name: "stub",
      async *stream(messages) {
        if (messages[messages.length - 1]?.role === "tool") {
          yield { type: "text", delta: "grounded answer" };
          return;
        }
        const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content;
        const isFirst = lastUser === first;
        const callsTool =
          toolTurns === "both" || (toolTurns === "first" && isFirst) || (toolTurns === "second" && !isFirst);
        if (callsTool) {
          yield {
            type: "tool_call",
            id: "call",
            name: "city_snapshot",
            arguments: JSON.stringify({ city: "toronto", beds: 2, maxPrice: 700_000 }),
          };
          return;
        }
        yield { type: "text", delta: isFirst ? "no tool on the first turn" : "no tool on the second turn" };
      },
    };
  }

  it("appends each assistant reply to the history before the next turn", async () => {
    const calls: ChatMessage[][] = [];
    const mt01 = caseById("MT01");
    await runAgentCase(mt01, recordingProvider(createMockProvider(), calls));

    const secondTurn = calls.find((messages) =>
      messages.some((message) => message.role === "user" && message.content === mt01.turns[1]),
    );
    expect(secondTurn).toBeDefined();
    expect(secondTurn!.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      mt01.turns[0],
      mt01.turns[1],
    ]);
    const reply = secondTurn!.find((m) => m.role === "assistant")?.content ?? "";
    expect(reply).toMatch(/Hamilton has \d/);
    // One LLM call per turn here: turn 1's tool round plus turn 2's answer.
    expect(calls).toHaveLength(3);
  });

  it("scores the final turn and requires the first turn to use a tool", async () => {
    const first = "What's the median asking price for 2-bedroom homes under $700,000 in Toronto?";
    const second = "Thanks.";
    const c01 = caseById("C01");
    const c01Question = { ...c01, turns: undefined };
    const multi = { ...c01, turns: [first, second], question: undefined };

    // Single-turn control: the same matching call passes when it is the scored turn.
    const single = await runAgentCase(c01Question, stubProvider("first", first));
    expect(evaluateCaseOutcome(c01Question, single).passed).toBe(true);

    // Multi-turn: the turn-1 match is history only; the empty final turn fails.
    const toolOnFirst = await runAgentCase(multi, stubProvider("first", first));
    expect(toolOnFirst.toolEvents).toEqual([]);
    expect(toolOnFirst.answer).toBe("no tool on the second turn");
    expect(evaluateCaseOutcome(multi, toolOnFirst).passed).toBe(false);

    // A matching final turn is not enough when the first turn used no tool.
    const toolOnSecond = await runAgentCase(multi, stubProvider("second", first));
    expect(toolOnSecond.toolEvents.map((event) => event.name)).toEqual(["city_snapshot"]);
    const missedFirst = evaluateCaseOutcome(multi, toolOnSecond);
    expect(missedFirst.passed).toBe(false);
    expect(missedFirst.detail).toContain("first turn used no tool");

    // With a tool on both turns the final turn alone decides the score.
    const bothTurns = await runAgentCase(multi, stubProvider("both", first));
    expect(bothTurns.turns).toHaveLength(2);
    expect(evaluateCaseOutcome(multi, bothTurns).passed).toBe(true);

    // No tool anywhere fails on the first turn before the final turn is even scored.
    const noTool = await runAgentCase(multi, stubProvider("none", first));
    expect(evaluateCaseOutcome(multi, noTool).detail).toContain("first turn used no tool");
  });

  it("records per-turn answer and tool names for multi-turn cases", async () => {
    const first = "What's the median asking price for 2-bedroom homes under $700,000 in Toronto?";
    const c01 = caseById("C01");
    const multi = { ...c01, turns: [first, "Thanks."], question: undefined };

    const report = buildCaseReport(multi, await runAgentCase(multi, stubProvider("both", first)));
    expect(report.passed).toBe(true);
    expect(report.turnCount).toBe(2);
    expect(report.turns).toHaveLength(2);
    expect(report.turns!.map((turn) => turn.tools)).toEqual([["city_snapshot"], ["city_snapshot"]]);
    for (const turn of report.turns!) {
      expect(typeof turn.answer).toBe("string");
      expect(turn.answer.length).toBeGreaterThan(0);
      expect(turn.error).toBeUndefined();
    }

    // Single-turn rows keep the existing shape: no per-turn array.
    const single = buildCaseReport(c01, await runAgentCase(c01, stubProvider("first", first)));
    expect(single.turnCount).toBe(1);
    expect(single.turns).toBeUndefined();
  });

  it("records a per-turn error when a turn fails", () => {
    const c01 = caseById("C01");
    const multi = { ...c01, turns: ["one", "two"], question: undefined };
    const row = buildCaseReport(multi, {
      answer: "partial",
      toolEvents: [],
      grounded: [],
      turns: [
        { answer: "", toolEvents: [], error: "provider_error" },
        { answer: "partial", toolEvents: [] },
      ],
    });
    expect(row.turns?.[0]).toEqual({ answer: "", tools: [], error: "provider_error" });
    expect(row.turns?.[1]).toEqual({ answer: "partial", tools: [] });
  });
});

describe("eval report", () => {
  const row = buildCaseReport(caseById("T01"), { answer: "ok", toolEvents: [], grounded: [] });
  const meta = { isMock: false, providerName: "stub", startedAt: new Date(0) };
  const REPORT_KEYS = [
    "cases",
    "complete_suite",
    "finished_at",
    "mode",
    "plumbing_only",
    "provider",
    "quality_gate_passed",
    "scores",
    "started_at",
    "totals",
  ];

  it("keeps the incremental report shape identical to the final report", () => {
    const incremental = buildReport([row], { ...meta, completeSuite: false });
    const final = buildReport([row, row], { ...meta, completeSuite: true });
    expect(Object.keys(incremental).sort()).toEqual([...REPORT_KEYS].sort());
    expect(Object.keys(final).sort()).toEqual([...REPORT_KEYS].sort());
    expect(Object.keys(incremental.totals).sort()).toEqual(Object.keys(final.totals).sort());
    expect(Object.keys(incremental.scores).sort()).toEqual(Object.keys(final.scores).sort());
    expect(Object.keys(incremental.cases[0]).sort()).toEqual(Object.keys(final.cases[0]).sort());
    expect(incremental.totals.by_category).toHaveProperty("scope_refusal");
  });

  it("never lets an incomplete report pass the quality gate", () => {
    const incremental = buildReport([row], { ...meta, completeSuite: false });
    expect(incremental.complete_suite).toBe(false);
    expect(incremental.quality_gate_passed).toBe(false);
    const final = buildReport([row, row], { ...meta, completeSuite: true });
    expect(final.complete_suite).toBe(true);
    // This fixture scores 0/2, so even the complete report cannot pass the gate.
    expect(final.quality_gate_passed).toBe(false);
  });
});
