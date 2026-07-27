// One harness that drives the server through a real MCP client and runs a
// standard battery of tool calls. It auto-adapts to whichever Source the
// environment selects, so the SAME command tests all three modes:
//
//   node scripts/test-modes.mjs                       → demo (mock) mode
//   MULE_LOG_DIR=/path/to/logs node scripts/test-modes.mjs   → live Mule logs
//   (source ../../../.env.deploy first)               → live Anypoint Platform
//
// Optional 2nd arg overrides the question; optional 3rd overrides an app id:
//   node scripts/test-modes.mjs "why are orders failing?" salesforce-sapi
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const QUESTION = process.argv[2] ?? "why are orders not coming to salesforce?";
const APP = process.argv[3]; // optional app id to probe

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env });
const client = new Client({ name: "test-modes", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(r.content[0].text);
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return undefined;
  }
}

const src = await call("describe_source");
await call("get_estate_health");
await call("list_apis");

// Probe a specific app's health (defaults differ per mode).
const appId = APP ?? (src?.kind === "mock" ? "salesforce-sapi" : undefined);
if (appId) await call("get_api_health", { apiId: appId });

const diag = await call("diagnose", { question: QUESTION });

// If the diagnosis surfaced a correlation id, follow it.
const cid = diag?.sampleCorrelationId;
if (cid) await call("trace_transaction", { query: cid });

await call("search_logs", { level: "ERROR", limit: 5 });

await client.close();
process.exit(0);
