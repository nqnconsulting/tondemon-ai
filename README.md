# TondemonAI — your MuleSoft Teammate

> Ask it what's broken and it tells you **where, why, and how to fix it**.
>
> *"Why are orders not coming through to Salesforce?"* → the failing app, the root cause, a
> sample correlation id to trace, and the remediation — across an API-led estate
> (MuleSoft · Anypoint MQ · SAP · Salesforce).

TondemonAI is the teammate who has already read every log. It works the way an on-call engineer
does: start from the business symptom, walk the flow to the deepest hop that is actually failing,
classify the error, and corroborate with a trace and the dead-letter queue before answering.

It works inside **Claude, Cursor, Slack, or any agent** — that part is handled by MCP, which is
just the wiring, not the point. One brain, every front door, zero per-agent code.

```
   Manager ── "why are orders not reaching Salesforce?" ──►  any agent
                                                              (Claude / Cursor / Slack / Agentforce)
                                                                       │  MCP (stdio or HTTP)
                                                              ┌────────▼─────────┐
                                                              │   TondemonAI     │   diagnose · trace ·
                                                              │                  │   health · queues ·
                                                              └────────┬─────────┘   DLQ · logs
                                          ┌───────────────────────────┼───────────────────────────┐
                                  commerce-order-api → order-events → amq-papi → salesforce-sapi → Salesforce
```

**Nothing to configure to try it.** With no environment variables set it runs a self-demonstrating
estate with one scripted incident, so you can ask it a real question sixty seconds after cloning.
Point it at a log directory or an Anypoint connected app when you want it on your own estate.

MIT licensed. See [`docs/INSTALL.md`](docs/INSTALL.md) to get running.

## Three modes — same tools

| Mode | When (priority order) | Backed by |
|------|------|-----------|
| **Anypoint Platform** | `ANYPOINT_CLIENT_ID` + `ANYPOINT_CLIENT_SECRET` + `ANYPOINT_BG_ID` set | The **live Anypoint Platform** (CloudHub 2.0 Runtime Manager, read-only): deployment status + CloudHub 2.0 logs. |
| **Live logs** | `MULE_LOG_DIR=<dir>` or `--logs <dir>` | A directory of **real Mule runtime logs** — parsed on startup. |
| **Demo** (default) | nothing set | A hand-built estate with one scripted incident (`src/data/`) so the server is self-demonstrating. |

The tools are identical in every mode; only the `Source` behind them changes (`src/sources/`).
Call `describe_source` to see which is active.

### Anypoint Platform mode (CloudHub 2.0, read-only)

A connected app (client_credentials) → it authenticates, resolves the environment, lists CloudHub 2.0
deployments + status, and pulls **CloudHub 2.0 logs**. Because CH2 logs are Mule-format, they run
through the *same* parser + analysis engine as file logs (`src/engine/logAnalysis.ts`) — so
`diagnose` / `trace_transaction` / `search_logs` work identically. Read-only: it only ever GETs.

```bash
export ANYPOINT_CLIENT_ID=…        # connected app (client_credentials)
export ANYPOINT_CLIENT_SECRET=…
export ANYPOINT_BG_ID=…            # business group / org GUID
export CH2_ENV=Sandbox             # environment name (or set ANYPOINT_ENV_ID directly)
# optional: ANYPOINT_ENV_ID, ANYPOINT_HOST (default anypoint.mulesoft.com)
npm start
```

The connected app needs **Runtime Manager read** on the target environment. Queue/DLQ depth and
latency aren't in Runtime Manager, so those tools report "unavailable / wire the MQ admin or
Monitoring API" — everything log-derived works.

### Live mode is client-agnostic by design

It assumes **no naming convention** — no `companyA-`, `teamB-`, `nqn-` prefixes, nothing. The only
thing it relies on is the **Mule runtime log format**, which is identical for every customer:

```
ERROR 2026-05-21 08:50:03,447 [thread] [processor: someFlow/processors/1; event: 4aed5a80-54e1-11f1-…] org.mule…:
  Message      : HTTP POST on resource '…' failed: internal server error (500).
  Element      : https-s4hana-soap-request/processors/1 @ app:connectors.xml:20 (S4HANA SOAP Request)
  Error type   : HTTP:INTERNAL_SERVER_ERROR
  FlowStack    : at someFlow(… (S4HANA SOAP Request))
```

From that the adapter (`src/adapters/muleLog.ts`) discovers, for any estate:

- **apps** — from log filenames (no prefix assumed)
- **flows** — from the `processor:` / `FlowStack` frames
- **correlation ids** — the Mule `event:` UUID (used by `trace_transaction`)
- **error types** — the `Error type` block (used to classify + remediate)
- **failing component / file:line** — from `Element` / `FlowStack` (e.g. a specific BAPI or SOAP request)

`diagnose` then matches your question to apps/flows by plain string scoring, picks the app with the
most errors, reports the dominant **classified** error type, a sample correlation id to trace, and
generic remediation keyed off the error-type family (AMQP, SAP, HTTP:UNAUTHORIZED, SMB, NETSUITE, …).

> **What logs don't contain:** broker queue depth and dead-letter *bodies* live on the
> AMQP/Anypoint MQ broker, not in app logs — so `get_queue_status` / `get_dlq_messages` return a
> clear "connect the broker admin API" notice in live mode (they're fully populated in demo mode).

---

## The scenario it ships with

Orders created in SAP/the storefront are published to the `order-events` Anypoint MQ queue,
fanned out by `amq-papi`, and upserted into Salesforce by `salesforce-sapi`. ~73 minutes ago a
Salesforce connected-app **client secret was rotated** but the matching Mule secure property was
not updated, so `salesforce-sapi` now gets **HTTP 401 `invalid_client`** from the token endpoint.
Every order exhausts its retries and lands in `order-events-dlq`. To a manager it just looks like
*"orders stopped showing up in Salesforce."*

The agent, driving the tools below, walks the flow to its **deepest failing hop** (`salesforce-sapi`),
reads the matching incident, corroborates with the 47-message DLQ and a sample trace, and reports
the cause + fix.

---

## Tools

| Tool | What it answers |
|------|-----------------|
| `diagnose` | **Headline tool.** Plain-English question → matched flow/app, broken hop, root cause, sample correlation id, remediation, and which tools to verify with. |
| `describe_source` | Whether answers are coming from the demo estate or live logs (with file/app/record counts). |
| `trace_transaction` | Follow one order / reference number hop-by-hop across all layers; shows exactly where it died. |
| `get_estate_health` | One-shot: which APIs are healthy / degraded / down + open incidents. |
| `get_api_health` | Deep health for one API: throughput, success/error rate, p95, top errors, incident. |
| `list_apis` | The estate topology by layer (channel / experience / process / system / backend). |
| `list_flows` | The named business flows that are monitored and their ordered hops. |
| `get_queue_status` | Anypoint MQ depths, in-flight, publish/consume rates, DLQ links. |
| `get_dlq_messages` | Inspect parked dead-letter messages: business key, error, where it failed, payload. |
| `search_logs` | Consolidated logs across APIs, filtered by API / level / substring / time window. |

A capable agent typically needs only `diagnose`; the rest let it (or a curious manager) drill in
and verify.

---

## Run it

```bash
npm install
npm run dev        # demo mode, from source over stdio (tsx)
# or
npm run build && npm start   # node dist/index.js

# Live mode — point it at any directory of Mule runtime logs:
MULE_LOG_DIR=/path/to/mule/logs npm start
#   or
node dist/index.js --logs /path/to/mule/logs
```

Verify the whole flagship path without an agent:

```bash
node scripts/smoke-test.mjs   # lists tools, runs the orders-→-Salesforce diagnosis
```

Explore interactively with the official inspector:

```bash
npm run inspect    # opens the MCP Inspector against this server
```

## Connect an agent

See [`examples/connect-agents.md`](examples/connect-agents.md) for copy-paste config for OpenClaw,
Hermes, Agentforce, Claude Desktop / Code, and Cursor. The launch command is always the same:

```
command: node    args: ["<abs-path>/dist/index.js"]      # or: npx tsx <abs-path>/src/index.ts
```

Sample manager conversations are in [`examples/manager-questions.md`](examples/manager-questions.md).

---

## Project layout

```
src/
  index.ts            MCP server entry (stdio transport; selects + reports the source)
  tools.ts            10 tool definitions + handlers (zod-validated) → delegate to the active Source
  types.ts            shared domain types
  scenario.ts         clock helpers + the one incident the demo data is built around
  sources/
    types.ts          the Source interface both modes implement
    index.ts          getActiveSource() — picks live logs (MULE_LOG_DIR/--logs) or demo
    mock.ts           MockSource — the bundled demo estate
    muleLogs.ts       MuleLogSource — analysis/diagnose over parsed real logs
  adapters/
    muleLog.ts        client-agnostic Mule runtime log parser
  data/               demo estate (used by MockSource)
    estate.ts · telemetry.ts · queues.ts · transactions.ts · logs.ts
  engine/
    diagnose.ts       demo-mode correlation engine: flow → deepest failing hop → root cause
scripts/
  smoke-test.mjs      end-to-end client test, demo mode (no agent, no real logs required)
```

## Making it more real

Live mode already reads real Mule **logs**. To enrich it further, extend `MuleLogSource`
(`src/sources/muleLogs.ts`) with platform APIs — the agent-facing tool contract stays identical:

- **Anypoint Monitoring / Visualizer** → throughput, latency, success-rate (logs give error *counts*, not latency).
- **Anypoint MQ Admin API / RabbitMQ management** → real `get_queue_status` + `get_dlq_messages`.
- **Anypoint transaction search / OpenTelemetry** → richer cross-app `trace_transaction`.

Because everything goes through the `Source` interface, you can also add new sources (Splunk, ELK,
CloudWatch) without touching `tools.ts`.
