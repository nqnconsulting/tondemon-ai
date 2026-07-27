# Installing TondemonAI

Three ways to run it, in increasing order of setup. Start at the top — the first one needs
no configuration at all.

**Prerequisites:** Node ≥ 18 and an MCP-capable agent (Claude Desktop, Claude Code, Cursor,
Agentforce, or anything else that speaks MCP). No MuleSoft access required for the demo.

---

## 1. Sixty-second demo mode

```bash
git clone https://github.com/nqnconsulting/tondemon-ai.git
cd tondemon-ai
npm install
npm run build
node scripts/smoke-test.mjs
```

That runs the whole flagship path with no agent attached: it lists the tools and diagnoses the
bundled incident (orders stopping at Salesforce because a rotated client secret was never
updated in a Mule secure property).

With nothing configured, every tool answers from a hand-built estate in `src/data/`. The tools
behave exactly as they do against a real estate — only the source behind them changes. Call
`describe_source` at any time to see which mode is active.

---

## 2. Connect your agent

The launch command is the same everywhere:

```
command: node    args: ["<abs-path>/dist/index.js"]
```

**Claude Desktop / Claude Code** — add to your MCP config:

```json
{
  "mcpServers": {
    "tondemon": {
      "command": "node",
      "args": ["/ABS_PATH/tondemon-ai/dist/index.js"]
    }
  }
}
```

Cursor, Agentforce and others follow the same shape — copy-paste configs for each are in
[`../examples/connect-agents.md`](../examples/connect-agents.md).

To poke at it without an agent:

```bash
npm run inspect     # opens the official MCP Inspector
```

Sample questions a manager would actually ask are in
[`../examples/manager-questions.md`](../examples/manager-questions.md).

---

## 3. Point it at your own estate

### Live log mode

The fastest route to real answers. Give it any directory of Mule runtime logs:

```bash
MULE_LOG_DIR=/path/to/mule/logs npm start
# or
node dist/index.js --logs /path/to/mule/logs
```

It assumes **no naming convention** — no per-customer prefixes, nothing. The only thing it
relies on is the Mule runtime log format, which is the same for every customer. Apps, flows,
correlation ids, error types and the failing component are all discovered from the logs
themselves.

Queue depth and dead-letter *bodies* live on the broker, not in app logs, so `get_queue_status`
and `get_dlq_messages` report "connect the broker admin API" in this mode rather than guessing.

### Anypoint Platform mode (CloudHub 2.0, read-only)

Create a connected app with **client_credentials** and **Runtime Manager read** on the target
environment, then:

```bash
export ANYPOINT_CLIENT_ID=…
export ANYPOINT_CLIENT_SECRET=…
export ANYPOINT_BG_ID=…          # business group / org GUID
export CH2_ENV=Sandbox           # or set ANYPOINT_ENV_ID directly
npm start
```

It only ever issues GETs. It resolves the environment, lists CloudHub 2.0 deployments and
status, and pulls CH2 logs — which are Mule-format, so they run through the same parser and
analysis engine as file logs. `diagnose`, `trace_transaction` and `search_logs` work identically.

---

## 4. Remote / team deployment (optional)

To let a whole team share one instance instead of each running it locally, there is a Docker
Compose + Caddy setup in [`../deploy/`](../deploy/) that terminates TLS and serves the HTTP
transport with bearer-token auth (`MCP_AUTH_TOKEN`). See
[`../deploy/SETUP.md`](../deploy/SETUP.md).

An optional Slack bridge lets people @mention a bot instead of using an agent UI —
[`../deploy/SLACK.md`](../deploy/SLACK.md). It needs Slack bot + app tokens and an Anthropic
API key.

---

## Verifying and troubleshooting

```bash
node scripts/smoke-test.mjs    # end-to-end, demo mode, no dependencies on your estate
npm run eval:tools             # tool-level evals
npm run typecheck              # tsc --noEmit
```

- **The agent doesn't see the tools** — use an absolute path in the MCP config, and make sure
  you ran `npm run build` (the config points at `dist/`, not `src/`).
- **Answers look like the demo estate when you expected live data** — call `describe_source`.
  Mode is chosen by precedence: Anypoint vars, then `MULE_LOG_DIR`/`--logs`, then demo.
- **Queue/DLQ tools say "unavailable"** — expected outside demo mode; that data isn't in logs.
