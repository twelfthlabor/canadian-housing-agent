import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../mcp/server";

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { type: string; text: string }[])[0].text;

describe("mcp server", () => {
  it("lists the 6 agent tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "city_snapshot",
      "compare_cities",
      "find_deals",
      "rank_areas",
      "search_docs",
      "search_listings",
    ]);
    await client.close();
  });

  it("runs search_listings via tools/call", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "search_listings",
      arguments: { city: "toronto", limit: 1 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).totalMatches).toBeGreaterThan(0);
    await client.close();
  });

  it("returns an isError result for an unknown tool", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "not_a_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Unknown tool");
    await client.close();
  });
});
