// Smoke test: spin up the MCP server over stdio with a real MCP client,
// list tools, and run the flagship "orders → Salesforce" diagnosis path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/index.ts"],
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(res.content[0].text);
}

await call("diagnose", { question: "why are orders not coming to salesforce?" });
await call("trace_transaction", { query: "10042" });
await call("get_dlq_messages", { queue: "order-events-dlq", limit: 2 });
await call("diagnose", { question: "are inventory adjustments flowing to SAP?" });

await client.close();
process.exit(0);
