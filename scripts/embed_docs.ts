/**
 * Generate data/docs_index.json: each project doc is split at markdown
 * headings, then into ~800-char windows with ~100 chars of overlap; every
 * window, prefixed with its section heading, is embedded with lib/embed.ts's
 * deterministic hash encoder. No clock and no RNG, so running it twice writes
 * a byte-identical file.
 *
 * Usage: npm run embed:docs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { DIMS, ENCODER, embed } from "../lib/embed";
import type { DocsChunk, DocsIndex } from "../lib/rag";

const SOURCES = ["README.md", "docs/DATA.md", "docs/DEMO.md", "docs/PLAN.md"];
const WINDOW_CHARS = 800;
const OVERLAP_CHARS = 100;
const MIN_PIECE_CHARS = 50;

/** Window text into overlapping pieces; pieces shorter than 50 chars are skipped. */
function windowsOf(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; ) {
    const end = Math.min(start + WINDOW_CHARS, text.length);
    const piece = text.slice(start, end).trim();
    if (piece.length >= MIN_PIECE_CHARS) pieces.push(piece);
    if (end === text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return pieces;
}

type Section = { heading: string; lines: string[] };

/** Heading-scoped sections; a section that is empty or only whitespace is dropped. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", lines: [] };
  for (const line of markdown.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((section) => section.lines.join("\n").trim() !== "");
}

const chunks: DocsChunk[] = [];
for (const source of SOURCES) {
  const markdown = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
  for (const section of sectionsOf(markdown)) {
    for (const text of windowsOf(section.lines.join("\n"))) {
      chunks.push({
        id: `${source}#${chunks.length}`,
        source,
        heading: section.heading,
        text,
        embedding: embed(section.heading ? `${section.heading}\n${text}` : text),
      });
    }
  }
}

const index: DocsIndex = { encoder: ENCODER, dims: DIMS, chunks };
writeFileSync(
  new URL("../data/docs_index.json", import.meta.url),
  `${JSON.stringify(index)}\n`,
);
console.log(`embed_docs: wrote data/docs_index.json (${chunks.length} chunks from ${SOURCES.length} files)`);
