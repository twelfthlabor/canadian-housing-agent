import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_IMPLS, TOOL_SPECS } from "../lib/tools";

/** MCP server exposing the agent tools; no transport attached. */
export function createServer(): Server {
  const server = new Server(
    { name: "canadian-housing-agent", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_SPECS.map(
      (spec): Tool => ({
        name: spec.function.name,
        description: spec.function.description,
        inputSchema: spec.function.parameters as unknown as Tool["inputSchema"],
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    const impl = Object.hasOwn(TOOL_IMPLS, name) ? TOOL_IMPLS[name] : undefined;
    if (typeof impl !== "function") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      return { content: [{ type: "text", text: JSON.stringify(impl(args ?? {})) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
