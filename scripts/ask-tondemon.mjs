#!/usr/bin/env node
// ask-tondemon.mjs — ask your LIVE Anypoint estate a question from the terminal,
// using ONLY an API key. No Slack app, no OAuth browser flow.
//
// It points Claude at the deployed Tondemon MCP server (remote MCP connector)
// authenticated with the static bearer token the server already accepts, so the
// model calls get_apis_health / diagnose / trace_transaction against your estate
// and prints a plain-English answer.
//
// Run:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   export TONDEMON_TOKEN=<the MCP_AUTH_TOKEN from /opt/tondemon/.env>
//   node scripts/ask-tondemon.mjs "how is my anypoint platform doing?"
//
// Optional: ANTHROPIC_MODEL (default claude-sonnet-4-6),
//           TONDEMON_MCP_URL (default the deployed endpoint).

import Anthropic from "@anthropic-ai/sdk";

const apiKey = need("ANTHROPIC_API_KEY");
const mcpToken = need("TONDEMON_TOKEN");
const mcpUrl = process.env.TONDEMON_MCP_URL || "https://your-server.example.com/mcp";
const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const question = process.argv.slice(2).join(" ") || "How is my Anypoint platform doing?";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
  return v;
}

const anthropic = new Anthropic({ apiKey });

const resp = await anthropic.beta.messages.create({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
  mcp_servers: [{ type: "url", url: mcpUrl, name: "tondemon", authorization_token: mcpToken }],
  betas: ["mcp-client-2025-04-04"],
});

const text = resp.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n")
  .trim();

console.log(text || "(no text returned)");
