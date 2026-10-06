/**
 * Optional local pgvector demo. Seeds docs_embeddings from the generated
 * data/docs_index.json, then optionally prints the top-3 passages for a query.
 *
 *   docker compose up -d
 *   npm run seed:pgvector
 *   npm run seed:pgvector -- --query "discount estimate"
 *   docker compose down
 *
 * The app itself stays keyless and in-memory; this is a local showcase only.
 */

import { readFileSync } from "node:fs";
import { Client } from "pg";
import { embed } from "../lib/rag";
import type { DocsIndex } from "../lib/rag";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent";

const args = process.argv.slice(2);
const queryIndex = args.indexOf("--query");
const queryText = queryIndex >= 0 ? args[queryIndex + 1] : undefined;
const force = args.includes("--force");

// The seed drops and recreates docs_embeddings, so never point it at a remote
// database by accident: local hosts only, unless --force is passed explicitly.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
let databaseUrl: URL;
try {
  databaseUrl = new URL(DATABASE_URL);
} catch {
  console.error("seed:pgvector: DATABASE_URL is not a valid URL; refusing to continue");
  process.exit(1);
}
if (!force && !LOCAL_HOSTS.has(databaseUrl.hostname.toLowerCase())) {
  console.error(
    `seed:pgvector: refusing to DROP/CREATE tables on non-local host "${databaseUrl.hostname}" without --force`,
  );
  process.exit(1);
}

const docsIndex = JSON.parse(
  readFileSync(new URL("../data/docs_index.json", import.meta.url), "utf8"),
) as DocsIndex;

function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

async function main(): Promise<void> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query("DROP TABLE IF EXISTS docs_embeddings");
    await client.query(
      "CREATE TABLE docs_embeddings (id text PRIMARY KEY, source text, heading text, content text, embedding vector(256))",
    );
    for (const chunk of docsIndex.chunks) {
      await client.query(
        "INSERT INTO docs_embeddings (id, source, heading, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)",
        [chunk.id, chunk.source, chunk.heading, chunk.text, toVector(chunk.embedding)],
      );
    }
    console.log(`seed:pgvector: inserted ${docsIndex.chunks.length} docs chunks`);

    if (queryText !== undefined) {
      const rows = await client.query(
        "SELECT source, heading, embedding <=> $1::vector AS distance FROM docs_embeddings ORDER BY embedding <=> $1::vector LIMIT 3",
        [toVector(embed(queryText))],
      );
      for (const row of rows.rows as Array<{ source: string; heading: string; distance: number }>) {
        console.log(`${row.source} — ${row.heading} (distance ${Number(row.distance).toFixed(4)})`);
      }
    }
  } catch (error) {
    // Node wraps connection failures in an AggregateError with an empty message.
    const nested = (error as { errors?: Array<{ message?: string }> } | null)?.errors?.find(
      (entry) => entry?.message,
    );
    const detail =
      nested?.message || (error instanceof Error ? error.message : "") || String(error);
    console.error(`seed:pgvector: could not use Postgres (${detail})`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void main();
