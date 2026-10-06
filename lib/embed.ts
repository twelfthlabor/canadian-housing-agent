/**
 * Pure deterministic hash encoding for project-docs retrieval: an FNV-1a
 * "embedding" over word unigrams plus character 4-grams. No index import,
 * no network, no LLM, no dependencies — safe for scripts to import on a
 * fresh checkout (lib/rag.ts adds the index and search on top).
 */

export const DIMS = 256;
export const ENCODER = "hash-v1";

/** FNV-1a 32-bit, deterministic across platforms (integer ops only). */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Lowercase whitespace words plus every character 4-gram of each word. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    tokens.push(word);
    for (let i = 0; i + 4 <= word.length; i += 1) {
      tokens.push(word.slice(i, i + 4));
    }
  }
  return tokens;
}

/** Unit-length hash embedding; blank text is the zero vector (never NaN). */
export function embed(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  for (const token of tokenize(typeof text === "string" ? text : "")) {
    vector[fnv1a(token) % DIMS] += 1;
  }
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}
