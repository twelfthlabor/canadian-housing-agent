import { describe, expect, it } from "vitest";
import { DIMS, embed, retrieveDocs } from "../lib/rag";

describe("hash embeddings (deterministic, no network)", () => {
  it("is deterministic, case-insensitive, 256-dimensional, and unit length", () => {
    const a = embed("The hmb-v1 estimate for comparable listings");
    const b = embed("the HMB-V1 ESTIMATE FOR COMPARABLE LISTINGS");
    expect(a).toHaveLength(DIMS);
    expect(b).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 12);
  });

  it("maps blank text to the zero vector without NaNs", () => {
    for (const text of ["", "   ", "\n\t"]) {
      const vector = embed(text);
      expect(vector).toHaveLength(DIMS);
      expect(vector.every((value) => value === 0)).toBe(true);
    }
  });
});

describe("retrieveDocs", () => {
  const query = "How does the hmb-v1 estimate work?";

  it("returns the documentation passage that explains the hmb-v1 estimate", () => {
    const results = retrieveDocs(query);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("docs/DATA.md");
    expect(results[0].heading).toBe("Valuation (hmb-v1)");
    expect(results[0].text.length).toBeGreaterThan(50);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("clamps limit to 1-10", () => {
    expect(retrieveDocs(query, 0)).toHaveLength(1);
    expect(retrieveDocs(query, -5)).toHaveLength(1);
    expect(retrieveDocs(query, 2)).toHaveLength(2);
    expect(retrieveDocs(query, 99)).toHaveLength(10);
  });

  it("returns no results for a blank query", () => {
    expect(retrieveDocs("")).toEqual([]);
    expect(retrieveDocs("   ")).toEqual([]);
  });
});
