# Connecting the MCP server to each agent

The server speaks **MCP over stdio**, which is the lowest-common-denominator transport every
MCP client supports. So the integration is the same everywhere: tell the agent how to **launch**
the server, and it discovers the 9 tools automatically.

Pick one launch command:

| | Command | Args |
|---|---------|------|
| Built (recommended) | `node` | `["<ABS_PATH>/dist/index.js"]` (run `npm run build` first) |
| From source | `npx` | `["tsx", "<ABS_PATH>/src/index.ts"]` |

Replace `<ABS_PATH>` with the absolute path to this `tondemon-ai` folder.

**Demo vs live logs.** With no extra config the server runs the bundled demo estate. To point it
at a real estate, add an `env` block with `MULE_LOG_DIR` set to a Mule runtime logs directory — the
exact same config, one extra line. Example (OpenClaw/Claude/Cursor shape):

```json
{
  "mcpServers": {
    "integration-monitor": {
      "command": "node",
      "args": ["<ABS_PATH>/dist/index.js"],
      "env": { "MULE_LOG_DIR": "/path/to/mule/logs" }
    }
  }
}
```

---

## OpenClaw

`~/.openclaw/mcp.json` (or the workspace `.openclaw/mcp.json`):

```json
{
  "mcpServers": {
    "integration-monitor": {
      "command": "node",
      "args": ["<ABS_PATH>/dist/index.js"]
    }
  }
}
```

Then in chat: *"Using integration-monitor, why are orders not coming to Salesforce?"*

## Hermes

`hermes.config.yaml`:

```yaml
tools:
  mcp:
    integration-monitor:
      transport: stdio
      command: node
      args:
        - <ABS_PATH>/dist/index.js
```

Hermes registers each MCP tool as a callable; the agent will pick `diagnose` for operational
questions and drill in with `trace_transaction` / `get_dlq_messages` as needed.

## Salesforce Agentforce

Agentforce consumes MCP servers as an **external tool/action provider**. Run the server behind
the MCP endpoint your Agentforce instance reaches (the stdio server wrapped by your MCP gateway,
or a hosted transport), then register it in **Setup → Agentforce → Actions → MCP Servers** and
add its actions to the agent's topic. The tool names (`diagnose`, `trace_transaction`, …) map
straight to Agentforce actions — no schema rewriting, the server advertises JSON Schema for each.

> Because Agentforce already sits next to Salesforce, "why are orders not coming to Salesforce?"
> is the natural question — and this MCP answers it by pointing back at the **MuleSoft** hop that
> failed, not at Salesforce.

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "integration-monitor": {
      "command": "node",
      "args": ["<ABS_PATH>/dist/index.js"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add integration-monitor -- node <ABS_PATH>/dist/index.js
```

## Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "integration-monitor": {
      "command": "node",
      "args": ["<ABS_PATH>/dist/index.js"]
    }
  }
}
```

## Codex Desktop

Use a local launcher so the desktop app starts the server directly from this repo:

```json
{
  "mcpServers": {
    "tondemon": {
      "command": "node",
      "args": ["/ABS_PATH/tondemon-ai/scripts/codex-desktop-launch.mjs"]
    }
  }
}
```

This launcher prefers `dist/index.js` when you have built the project and falls back to
`tsx src/index.ts` so it still works during development.

---

### Verify any connection

After adding the server, the client should list 9 tools:
`list_apis, list_flows, get_api_health, get_estate_health, trace_transaction, get_queue_status,
get_dlq_messages, search_logs, diagnose`.

If not, run `node scripts/smoke-test.mjs` from this folder — if that prints the diagnosis, the
server is fine and the issue is the client's config path or the absolute path you supplied.
