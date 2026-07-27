import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getActiveSource, type Source } from "./sources/index.js";
import { loadPlaybook } from "./prompts.js";

// Tool outputs are returned as JSON text content. Agents (OpenClaw, Hermes,
// Agentforce, Claude, etc.) parse the JSON; a `summary`/`note` field keeps
// transcripts readable when a result is shown verbatim.
//
// Every tool delegates to the active Source — the bundled demo estate, or a
// live directory of Mule runtime logs (set MULE_LOG_DIR / --logs). The tool
// surface is identical either way, so the same agents work against either.

// Sent to the client on connect (MCP `instructions`). Many clients surface this
// to the model as guidance on WHEN to reach for these tools — without it, a
// general-purpose/coding agent tends to answer Anypoint questions from memory or
// web search instead of calling the live tools.
export const SERVER_INSTRUCTIONS = loadPlaybook();

function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function registerTools(server: McpServer, source: Source = getActiveSource()): void {
  server.registerTool(
    "describe_source",
    {
      title: "Describe data source",
      description:
        "Report what's backing the server right now: the bundled demo estate, or a live Mule logs directory (with file/app/record counts). Call this first to know whether answers are live or demo.",
      inputSchema: {},
    },
    async () => json(await source.describe()),
  );

  server.registerTool(
    "list_apis",
    {
      title: "List APIs / apps",
      description:
        "List the apps (deployables) in the estate with their current error rate and status. In live-log mode these are discovered from the log files; no naming convention is assumed.",
      inputSchema: {
        layer: z
          .enum(["channel", "experience", "process", "system", "backend"])
          .optional()
          .describe("Filter by API-led layer (demo mode only; ignored in live-log mode)."),
      },
    },
    async ({ layer }) => json(await source.listApis(layer)),
  );

  server.registerTool(
    "list_flows",
    {
      title: "List flows",
      description:
        "List the business flows that are monitored. In demo mode these are named end-to-end flows; in live-log mode they are the Mule flow names discovered per app.",
      inputSchema: {
        entity: z.string().optional().describe("Optional keyword to filter, e.g. 'order', 'salesforce', 'inventory'."),
      },
    },
    async ({ entity }) => json(await source.listFlows(entity)),
  );

  server.registerTool(
    "get_api_health",
    {
      title: "Get API/app health",
      description:
        "Health of one app: status, error rate, top error types, and (demo mode) latency/incident. Use after a trace or diagnosis points at a suspect.",
      inputSchema: {
        apiId: z.string().describe("App id. See list_apis."),
      },
    },
    async ({ apiId }) => json(await source.getApiHealth(apiId)),
  );

  server.registerTool(
    "get_apis_health",
    {
      title: "Get APIs health",
      description:
        "One-shot platform overview and the right tool for 'how is my Anypoint platform doing?'. For EVERY app: deployment status (healthy/degraded/down), error rate, the TOP 5 error types from its CloudHub 2.0 logs, and the API Manager POLICIES applied to it (rate-limiting, client-id-enforcement, JWT, etc.). Also returns a policyCatalog of all API instances. Good first call to see if anything is wrong.",
      inputSchema: {},
    },
    async () => json(await source.getEstateHealth()),
  );

  server.registerTool(
    "trace_transaction",
    {
      title: "Trace a transaction",
      description:
        "Trace one transaction hop-by-hop. In live-log mode pass the Mule correlation id (the 'event:' UUID) or a token that appears in the log message; in demo mode pass an order number / correlation id. Shows where it failed.",
      inputSchema: {
        query: z.string().describe("Correlation id (e.g. a Mule event UUID, or 'ORD-10042') or a business key."),
      },
    },
    async ({ query }) => json(await source.traceTransaction(query)),
  );

  server.registerTool(
    "get_queue_status",
    {
      title: "Get queue status",
      description:
        "Queue depths / dead-letter state. Available in demo mode; in live-log mode this needs the broker admin API and returns what the logs can show instead.",
      inputSchema: {
        queueName: z.string().optional().describe("Specific queue name; omit for all."),
      },
    },
    async ({ queueName }) => json(await source.getQueueStatus(queueName)),
  );

  server.registerTool(
    "get_dlq_messages",
    {
      title: "Get dead-letter messages",
      description:
        "Inspect parked dead-letter messages (demo mode). In live-log mode use search_logs + trace_transaction to follow failed messages, since DLQ bodies live on the broker.",
      inputSchema: {
        queue: z.string().describe("Dead-letter queue name, e.g. 'order-events-dlq'."),
        limit: z.number().int().min(1).max(50).optional().describe("Max messages (default 10)."),
      },
    },
    async ({ queue, limit }) => json(await source.getDlqMessages(queue, limit)),
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description:
        "Search the consolidated logs across apps. Filter by app, level, substring (matches message / correlation id / error type / flow) and time window. Time windows are relative to the latest log timestamp in live-log mode.",
      inputSchema: {
        apiId: z.string().optional().describe("Restrict to one app id."),
        level: z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]).optional().describe("Exact level filter."),
        contains: z.string().optional().describe("Case-insensitive substring."),
        sinceMinutes: z.number().int().min(1).optional().describe("Only the last N minutes (relative to latest log)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max lines (default 50)."),
      },
    },
    async ({ apiId, level, contains, sinceMinutes, limit }) =>
      json(await source.searchLogs({ apiId, level, contains, sinceMinutes, limit })),
  );

  server.registerTool(
    "diagnose",
    {
      title: "Diagnose a plain-English question",
      description:
        "The headline tool. Ask a plain-English operational question (e.g. \"why are orders not coming to Salesforce?\") and get a correlated root-cause: which app/flow is failing, the dominant error type, a sample correlation id to trace, remediation, and which tools to verify with.",
      inputSchema: {
        question: z.string().describe('A manager-style question, e.g. "why are orders failing to reach SAP?"'),
      },
    },
    async ({ question }) => json(await source.diagnose(question)),
  );

  // --- ChatGPT connector contract -------------------------------------------
  // OpenAI's ChatGPT connectors (and deep research) look for two specific tools,
  // `search` and `fetch`, with a fixed result shape. These are thin wrappers
  // over the same live estate so Tondemon works in ChatGPT's default connector
  // path too, not only in Developer mode. `search` returns lightweight
  // {id,title,url} records; `fetch` resolves an id to a full document.
  const RES = "https://your-server.example.com"; // synthetic doc namespace

  async function appList(): Promise<{ id: string; name?: string; status?: string }[]> {
    const r = (await source.listApis()) as Record<string, unknown>;
    const arr = (r.apis ?? r.apps ?? r.items ?? []) as Record<string, unknown>[];
    return arr.map((a) => ({
      id: String(a.id ?? a.apiId ?? a.name ?? ""),
      name: a.name ? String(a.name) : undefined,
      status: a.status ? String(a.status) : undefined,
    }));
  }

  server.registerTool(
    "search",
    {
      title: "Search the integration estate",
      description:
        "ChatGPT connector search. Returns matching 'documents' (ids) for a query about this MuleSoft Anypoint estate — the estate-health overview, a live diagnosis of the question, and any matching apps/APIs. Pass each returned id to `fetch` to read the full result.",
      inputSchema: {
        query: z.string().describe("What to look up, e.g. 'estate health' or 'why are orders not reaching Salesforce'."),
      },
    },
    async ({ query }) => {
      const q = (query ?? "").toLowerCase();
      const results: { id: string; title: string; url: string }[] = [
        { id: "estate-health", title: "Anypoint estate health (all APIs)", url: `${RES}/#estate-health` },
        { id: `diagnose:${query}`, title: `Diagnosis: ${query}`, url: `${RES}/#diagnose` },
      ];
      const apps = await appList().catch(() => []);
      const matched = apps.filter((a) => !q || a.id.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q));
      for (const a of (matched.length ? matched : apps).slice(0, 25)) {
        results.push({
          id: `api:${a.id}`,
          title: `App health: ${a.name ?? a.id}${a.status ? ` (${a.status})` : ""}`,
          url: `${RES}/#api/${encodeURIComponent(a.id)}`,
        });
      }
      return json({ results });
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a document",
      description:
        "ChatGPT connector fetch. Resolves an id returned by `search` to a full document. Ids: 'estate-health', 'api:<appId>', 'diagnose:<question>', or 'trace:<correlationId>'.",
      inputSchema: {
        id: z.string().describe("A document id from search, e.g. 'estate-health' or 'api:salesforce-sapi'."),
      },
    },
    async ({ id }) => {
      const raw = id ?? "";
      let title = "Anypoint estate";
      let data: unknown;
      if (raw === "estate-health" || raw === "estate") {
        title = "Anypoint estate health (all APIs)";
        data = await source.getEstateHealth();
      } else if (raw.startsWith("api:")) {
        const appId = raw.slice(4);
        title = `App health: ${appId}`;
        data = await source.getApiHealth(appId);
      } else if (raw.startsWith("diagnose:")) {
        const q = raw.slice("diagnose:".length);
        title = `Diagnosis: ${q}`;
        data = await source.diagnose(q);
      } else if (raw.startsWith("trace:")) {
        const q = raw.slice("trace:".length);
        title = `Trace: ${q}`;
        data = await source.traceTransaction(q);
      } else {
        // Bare id — treat as an app id, falling back to a diagnosis.
        title = `App health: ${raw}`;
        data = await source.getApiHealth(raw);
      }
      return json({ id: raw, title, url: `${RES}/#${encodeURIComponent(raw)}`, text: JSON.stringify(data, null, 2), metadata: { source: "tondemon-ai" } });
    },
  );
}
