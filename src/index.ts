#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { getActiveSource } from "./sources/index.js";
import { startHttp } from "./http.js";

// TondemonAI
// ----------------------------------------------------------------------------
// A vendor-neutral Model Context Protocol server that turns a manager's
// plain-English question ("why are orders not coming to Salesforce?") into a
// traced, root-caused answer over an API-led integration estate.
//
// Two transports:
//  - stdio  (default)        — spawned locally by an MCP client (Claude, etc.).
//  - HTTP   (MCP_HTTP_PORT or --http) — deployable to a host and
//    reached over the network, token-guarded. See src/http.ts.

function httpPort(): number | undefined {
  if (process.env.MCP_HTTP_PORT) return parseInt(process.env.MCP_HTTP_PORT, 10);
  const i = process.argv.indexOf("--http");
  if (i >= 0) return process.argv[i + 1] && /^\d+$/.test(process.argv[i + 1]) ? parseInt(process.argv[i + 1], 10) : 8080;
  return undefined;
}

async function main(): Promise<void> {
  const port = httpPort();
  if (port !== undefined) {
    await startHttp(port);
    return;
  }

  const server = new McpServer({ name: "tondemon-ai", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const source = getActiveSource();
  registerTools(server, source);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Never write to stdout: it is the MCP transport. Diagnostics go to stderr.
  const desc = await Promise.resolve(source.describe()).catch((e) => ({ error: (e as Error).message }));
  console.error(`[tondemon-ai] MCP server ready on stdio. Source: ${JSON.stringify(desc)}`);
}

main().catch((err) => {
  console.error("[tondemon-ai] fatal:", err);
  process.exit(1);
});
