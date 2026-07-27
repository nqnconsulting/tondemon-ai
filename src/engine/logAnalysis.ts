import type { MuleRecord } from "../adapters/muleLog.js";

// Shared analysis engine over parsed Mule log records. The records can come from
// a directory of log files (MuleLogSource) or from the CloudHub 2.0 logs API
// (AnypointSource) — CloudHub 2.0 emits the same Mule log format, so the same
// engine root-causes both. Client-agnostic: no naming convention assumed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generic, error-type-driven remediation keyed by the Mule error-type prefix.
const REMEDIATION: Record<string, string> = {
  "AMQP": "Check the AMQP/RabbitMQ broker: connectivity from the runtime, that the exchange/queue exists, and the consumer's prefetch/ack timeout. AMQP:TIMEOUT usually means the consumer didn't ack in time or the broker was unreachable.",
  "HTTP:UNAUTHORIZED": "The downstream HTTP API rejected the credentials (401). Verify the OAuth client id/secret or token and that it hasn't been rotated/expired.",
  "HTTP:FORBIDDEN": "The downstream API authenticated but denied access (403). Check scopes/permissions for the service account.",
  "HTTP:CONNECTIVITY": "The downstream HTTP endpoint was unreachable. Check host/DNS, firewall, TLS and the configured timeout.",
  "HTTP:TIMEOUT": "The downstream HTTP endpoint was too slow. Check its health and the requester's response timeout.",
  "HTTP:INTERNAL_SERVER_ERROR": "The downstream returned 500. The fault is in the target system or the request it received — inspect the response body in the logs.",
  "HTTP:NOT_FOUND": "The downstream returned 404 — check the request path/resource against the target API (wrong path, missing object, or a record that doesn't exist).",
  "SAP": "SAP/JCo connectivity or call error. Verify the SAP host (saprouter), system number, client, and credentials; check the BAPI/RFC named in the FlowStack.",
  "SMB": "A file/path on the SMB share was missing or unreachable (SMB:OBJECT_NAME_NOT_FOUND). Verify the share path and that the producing system actually wrote the file.",
  "NETSUITE": "NetSuite rejected the call. Check the integration role/permissions, required record fields, and SuiteTalk governance limits.",
  "SALESFORCE": "Salesforce rejected the call. Check the connected-app credentials, field-level security, and any required fields/validation rules.",
  "VALIDATION": "A business validation rule failed — the payload didn't satisfy a constraint (e.g. a credit/debit mismatch). Fix the upstream data.",
  "APIKIT": "The inbound request didn't match the API spec (bad payload or unknown path). Fix the caller or the RAML/OAS.",
  "MULE:RETRY_EXHAUSTED": "All retries to a downstream failed; the real cause is the wrapped error — trace the same correlation id to the underlying connectivity/auth failure.",
  "MULE:EXPRESSION": "A DataWeave/expression error — usually a missing or malformed field in the payload. Inspect the failing component named in the FlowStack.",
  "MULE:COMPOSITE_ROUTING": "One or more routes in a scatter-gather/parallel block failed; expand to find which downstream errored.",
};

// Mule HTTP requester failures name the operation and target, in both the
// exception-dump form ("Message : HTTP POST on resource 'https://host/path'
// failed: not found (404).") and the JSON problem-detail form
// ('"raw": "HTTP POST on resource \'...\' failed: ..."'). Extract METHOD + URL.
const FAILING_REQUEST_RE = /HTTP\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+on\s+resource\s+'([^']+)'/i;

export function extractFailingRequest(message?: string | null): { method: string; url: string } | null {
  const m = message ? FAILING_REQUEST_RE.exec(message) : null;
  return m ? { method: m[1].toUpperCase(), url: m[2] } : null;
}

export function remediationFor(errorType?: string, sampleMessage?: string): string {
  if (!errorType) return "Inspect the error records for this app and trace the correlation id end-to-end to find the originating failure.";
  if (errorType === "HTTP:NOT_FOUND") {
    // Path-aware 404 reading: a 404 on POST/PUT/PATCH (create/upsert) is an
    // ENDPOINT-level miss — a missing record cannot 404 an upsert/create.
    const req = extractFailingRequest(sampleMessage);
    if (req && /^(POST|PUT|PATCH)$/.test(req.method)) {
      return `The downstream returned 404 on ${req.method} ${req.url} — this is an ENDPOINT-level 404: the resource path/object doesn't exist on the target (e.g. a missing custom object/sObject in the target org, a wrong object API name, or a wrong API version/base path). A missing record cannot 404 an upsert/create — fix the endpoint, not the data.`;
    }
    if (req) {
      return `The downstream returned 404 on ${req.method} ${req.url} — wrong path/resource id, or the record doesn't exist yet upstream.`;
    }
    return REMEDIATION["HTTP:NOT_FOUND"];
  }
  if (REMEDIATION[errorType]) return REMEDIATION[errorType];
  const prefix = errorType.split(":")[0];
  return REMEDIATION[prefix] ?? `Investigate ${errorType}: review the failing component in the FlowStack and the downstream system it calls.`;
}

// Failures in this estate are often logged at INFO via DefaultExceptionListener,
// so `level === "ERROR"` alone is blind to them. A record counts as an error if
// the level says so, a Mule error type was parsed, or the message carries an
// unmistakable error marker (conservative — no lowercase "error" prose match).
const ERRORISH_RE = /\bERROR\b|\bException\b|Error type\s*:/;

export function isErrorRecord(r: MuleRecord): boolean {
  return r.level === "ERROR" || !!r.errorType || ERRORISH_RE.test(r.message ?? "");
}

// Specific backend/client failures own the root cause over generic relays.
const SPECIFIC_TYPES = new Set(["HTTP:UNAUTHORIZED", "HTTP:NOT_FOUND", "HTTP:FORBIDDEN"]);

function isSpecificType(t?: string | null): boolean {
  if (!t) return false;
  return SPECIFIC_TYPES.has(t) || /:(CONNECTIVITY|TIMEOUT)$/.test(t);
}

type Result = Record<string, unknown>;

export class LogAnalyzer {
  readonly records: MuleRecord[];
  readonly apps: string[];
  readonly asOf: number;
  private sourceKind: string;

  constructor(records: MuleRecord[], opts: { sourceKind: string; asOfEpochMs?: number }) {
    this.records = [...records].sort((a, b) => a.epochMs - b.epochMs);
    this.apps = [...new Set(this.records.map((r) => r.app))].sort();
    this.asOf = opts.asOfEpochMs ?? this.records.reduce((mx, r) => Math.max(mx, r.epochMs), 0);
    this.sourceKind = opts.sourceKind;
  }

  get isEmpty(): boolean {
    return this.records.length === 0;
  }

  private appRecords(app: string): MuleRecord[] {
    return this.records.filter((r) => r.app === app);
  }

  private statusFor(errorRatePct: number): "healthy" | "degraded" | "down" {
    if (errorRatePct >= 50) return "down";
    if (errorRatePct >= 10) return "degraded";
    return "healthy";
  }

  healthOf(app: string) {
    const recs = this.appRecords(app);
    const errs = recs.filter(isErrorRecord);
    const infoLevelErrors = errs.filter((e) => e.level !== "ERROR").length;
    const total = recs.length || 1;
    const errorRatePct = Math.round((errs.length / total) * 1000) / 10;
    const byType: Record<string, number> = {};
    for (const e of errs) byType[e.errorType ?? "(unclassified)"] = (byType[e.errorType ?? "(unclassified)"] ?? 0) + 1;
    const errorBreakdown = Object.entries(byType).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
    const lastError = [...errs].sort((a, b) => b.epochMs - a.epochMs)[0];
    return {
      app,
      status: this.statusFor(errorRatePct),
      records: recs.length,
      errors: errs.length,
      infoLevelErrors,
      errorRatePct,
      errorBreakdown,
      lastErrorAt: lastError?.ts ?? null,
      lastErrorType: lastError?.errorType ?? null,
    };
  }

  listApis(): Result {
    const apis = this.apps.map((app) => {
      const h = this.healthOf(app);
      return { id: app, status: h.status, records: h.records, errors: h.errors, errorRatePct: h.errorRatePct, topError: h.errorBreakdown[0]?.code ?? null };
    });
    return { source: this.sourceKind, count: apis.length, apis, note: "layer is not inferred — no naming convention assumed." };
  }

  listFlows(entity?: string): Result {
    const e = entity?.toLowerCase();
    const byApp: Record<string, Set<string>> = {};
    for (const r of this.records) {
      if (!r.flow) continue;
      (byApp[r.app] ??= new Set()).add(r.flow);
    }
    const flows = Object.entries(byApp)
      .map(([app, set]) => ({ app, flows: [...set].sort() }))
      .filter((f) => !e || f.app.toLowerCase().includes(e) || f.flows.some((fl) => fl.toLowerCase().includes(e)));
    return { source: this.sourceKind, count: flows.reduce((n, f) => n + f.flows.length, 0), apps: flows };
  }

  getApiHealth(apiId: string): Result {
    if (!this.apps.includes(apiId)) return { error: `Unknown app '${apiId}'.`, knownApps: this.apps };
    const h = this.healthOf(apiId);
    const recs = this.appRecords(apiId);
    const span = recs.length ? { from: new Date(recs[0].epochMs).toISOString(), to: new Date(recs[recs.length - 1].epochMs).toISOString() } : null;
    return { source: this.sourceKind, ...h, window: span };
  }

  getEstateHealth(): Result {
    const apps = this.apps.map((a) => this.healthOf(a));
    const incidents = apps
      .filter((a) => a.status !== "healthy")
      .map((a) => ({ app: a.app, status: a.status, errorRatePct: a.errorRatePct, topError: a.errorBreakdown[0]?.code ?? null, lastErrorAt: a.lastErrorAt }));
    return {
      source: this.sourceKind,
      asOf: this.asOf ? new Date(this.asOf).toISOString() : null,
      overall: apps.some((a) => a.status === "down") ? "down" : apps.some((a) => a.status === "degraded") ? "degraded" : "healthy",
      apps: apps.map((a) => ({ apiId: a.app, status: a.status, errorRatePct: a.errorRatePct, errors: a.errors, topError: a.errorBreakdown[0]?.code ?? null })),
      attentionNeeded: incidents,
    };
  }

  traceTransaction(query: string): Result {
    const q = query.trim();
    let cid = q;
    if (!UUID_RE.test(q)) {
      const hit = this.records.find((r) => (r.correlationId && r.correlationId.includes(q)) || r.message.toLowerCase().includes(q.toLowerCase()));
      if (!hit || !hit.correlationId) {
        return { error: `No transaction found for '${query}'.`, hint: "Pass a Mule correlation id (the 'event:' UUID) or a token that appears in the log message." };
      }
      cid = hit.correlationId;
    }
    const hops = this.records
      .filter((r) => r.correlationId === cid)
      .sort((a, b) => a.epochMs - b.epochMs)
      .map((r) => ({ app: r.app, flow: r.flow, level: r.level, at: r.ts, status: r.level === "ERROR" ? "error" : "ok", errorType: r.errorType, failingComponent: r.failingComponent, message: r.message?.slice(0, 200) }));
    if (!hops.length) return { error: `No log records carry correlation id '${cid}'.` };
    const lastError = [...hops].reverse().find((h) => h.status === "error");
    return {
      source: this.sourceKind,
      correlationId: cid,
      apps: [...new Set(hops.map((h) => h.app))],
      status: lastError ? "failed" : "completed",
      hops,
      failedAt: lastError ? { app: lastError.app, flow: lastError.flow, errorType: lastError.errorType } : null,
    };
  }

  searchLogs(filter: { apiId?: string; level?: string; contains?: string; sinceMinutes?: number; limit?: number }): Result {
    const contains = filter.contains?.toLowerCase();
    const cutoff = filter.sinceMinutes !== undefined ? this.asOf - filter.sinceMinutes * 60_000 : undefined;
    const lines = this.records
      .filter((r) => {
        if (filter.apiId && r.app !== filter.apiId) return false;
        if (filter.level && r.level !== filter.level) return false;
        if (cutoff !== undefined && r.epochMs < cutoff) return false;
        if (contains) {
          const hay = `${r.message} ${r.correlationId ?? ""} ${r.errorType ?? ""} ${r.flow ?? ""}`.toLowerCase();
          if (!hay.includes(contains)) return false;
        }
        return true;
      })
      .sort((a, b) => b.epochMs - a.epochMs)
      .slice(0, filter.limit ?? 50)
      .map((r) => ({ at: r.ts, api: r.app, level: r.level, flow: r.flow, correlationId: r.correlationId, errorType: r.errorType, message: r.message?.slice(0, 240) }));
    return { source: this.sourceKind, asOf: this.asOf ? new Date(this.asOf).toISOString() : null, count: lines.length, lines };
  }

  diagnose(question: string): Result {
    const q = question.toLowerCase();
    const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const flowsByApp: Record<string, Set<string>> = {};
    for (const r of this.records) if (r.flow) (flowsByApp[r.app] ??= new Set()).add(r.flow.toLowerCase());

    // "Recent" = the last 25% of the dataset's time span (min 1 hour), derived
    // from record timestamps — a stale error type must not outrank today's.
    // With no usable timestamps everything counts as recent (total classified).
    const minEpoch = this.records.reduce((mn, r) => (r.epochMs ? Math.min(mn, r.epochMs) : mn), Infinity);
    const maxEpoch = this.records.reduce((mx, r) => Math.max(mx, r.epochMs), 0);
    const span = Number.isFinite(minEpoch) && maxEpoch > minEpoch ? maxEpoch - minEpoch : 0;
    const recentCutoff = span > 0 ? maxEpoch - Math.max(span * 0.25, 3_600_000) : 0;

    const scored = this.apps.map((app) => {
      const hayApp = app.toLowerCase();
      const flows = [...(flowsByApp[app] ?? [])].join(" ");
      let score = 0;
      for (const t of tokens) {
        if (hayApp.includes(t)) score += 2;
        if (flows.includes(t)) score += 1;
      }
      const errs = this.appRecords(app).filter(isErrorRecord).sort((a, b) => b.epochMs - a.epochMs);
      const classified = errs.filter((e) => e.errorType);
      const recentClassified = classified.filter((e) => e.epochMs >= recentCutoff);
      return { app, score, health: this.healthOf(app), errs, classified, newest: recentClassified[0] ?? classified[0], recentClassifiedCount: recentClassified.length };
    });

    const matched = scored.filter((s) => s.score > 0);
    // Candidates = keyword-matched apps ∪ apps with errors, ranked by EVIDENCE:
    // recent classified errors, then total errors; keyword score is only a
    // tiebreak. A name-match with zero errors never outranks real errors.
    const candidates = scored
      .filter((s) => s.score > 0 || s.health.errors > 0)
      .sort((a, b) => b.recentClassifiedCount - a.recentClassifiedCount || b.health.errors - a.health.errors || b.score - a.score);

    // No candidates, or only zero-error keyword matches: never name a brokenApp
    // without error evidence ("healthy 0%" next to "brokenApp" is a lie).
    if (!candidates.length || candidates[0].health.errors === 0) {
      return {
        source: this.sourceKind,
        question,
        verdict: "No errors found in the loaded logs for anything matching that question.",
        matchedApps: matched.map((m) => m.app),
        suggestedTools: ["get_apis_health", "list_apis"],
        summary: "I couldn't tie that question to a failing app in the logs. Run get_apis_health to see which apps have errors, or rephrase using an app or flow name from list_apis / list_flows.",
      };
    }

    // Deepest hop owns the cause: if the top pick's freshest error is a generic
    // relay (HTTP:INTERNAL_SERVER_ERROR, MULE:UNKNOWN, unclassified) and another
    // candidate sharing failing correlation ids has a specific backend/client
    // error (401/403/404/CONNECTIVITY/TIMEOUT), that downstream app is the cause.
    let worst = candidates[0];
    let symptomApp: string | null = null;
    const sharesCids = (a: (typeof scored)[number], b: (typeof scored)[number]) => {
      const cids = new Set(a.errs.map((e) => e.correlationId).filter(Boolean));
      return b.errs.some((e) => e.correlationId && cids.has(e.correlationId));
    };
    if (!isSpecificType(worst.newest?.errorType)) {
      const deeper = candidates.find((c) => c !== worst && isSpecificType(c.newest?.errorType) && sharesCids(worst, c));
      if (deeper) {
        symptomApp = worst.app;
        worst = deeper;
      }
    } else {
      // Already on the specific downstream cause: name any upstream generic
      // relay sharing failing correlation ids as the symptom.
      const relay = candidates.find(
        (c) => c !== worst && c.health.errors > 0 && !isSpecificType(c.newest?.errorType) && sharesCids(worst, c),
      );
      if (relay) symptomApp = relay.app;
    }

    const errs = worst.errs;
    // Root cause = the NEWEST classified error of the chosen app, not the
    // all-time most frequent type.
    const topType = worst.newest?.errorType ?? null;
    const topTypeCount = topType ? worst.classified.filter((e) => e.errorType === topType).length : 0;
    const sampleErr = worst.newest ?? errs[0];
    const sampleCorrelationId = sampleErr?.correlationId ?? errs.find((e) => e.correlationId)?.correlationId ?? null;
    const infoLevelErrors = worst.health.infoLevelErrors;

    // Honest impact: each failed transaction writes several error LOG LINES
    // sharing one correlation id — never present line counts as transactions.
    const errorCids = new Set(errs.map((e) => e.correlationId).filter(Boolean));
    const linesWithoutCid = errs.filter((e) => !e.correlationId).length;
    const affectedTransactionCount = errorCids.size > 0 ? errorCids.size : null;
    const failingRequest = extractFailingRequest(sampleErr?.message);

    const evidence = [
      affectedTransactionCount !== null
        ? `${worst.app}: ${affectedTransactionCount} failing transaction(s) (unique correlation ids) across ${worst.health.errors} error log lines in ${worst.health.records} records (${worst.health.errorRatePct}%), status ${worst.health.status}.${linesWithoutCid > 0 ? ` ${linesWithoutCid} error line(s) carried no correlation id.` : ""}`
        : `${worst.app}: ${worst.health.errors} error log line(s) in ${worst.health.records} records (${worst.health.errorRatePct}%), status ${worst.health.status} — no correlation ids on the error lines, so the failing-transaction count is unknown.`,
      topType ? `Newest classified error type: ${topType} (${topTypeCount}× total).` : "Errors have no Mule error-type block (raw logger.error lines) — inspect the messages.",
      failingRequest ? `Failing request: ${failingRequest.method} ${failingRequest.url}` : "",
      symptomApp ? `${symptomApp} shares failing correlation ids with ${worst.app} — it is failing as a symptom of ${worst.app}'s ${topType}.` : "",
      infoLevelErrors > 0 ? `${infoLevelErrors} failures are logged at INFO level (DefaultExceptionListener) — platform error-rate metrics read 0%; tondemon counted them from message content/error types.` : "",
      sampleErr?.element ? `Failing element: ${sampleErr.element}` : "",
      sampleErr?.failingComponent ? `Failing component (FlowStack): ${sampleErr.failingComponent}` : "",
      sampleErr?.flowStackHead ? `FlowStack: ${sampleErr.flowStackHead.slice(0, 200)}` : "",
      sampleErr ? `Last seen: ${sampleErr.ts}` : "",
    ].filter(Boolean);

    const remediation = remediationFor(topType ?? undefined, sampleErr?.message);
    const suggestedTools = [
      `get_api_health(apiId="${worst.app}")`,
      `search_logs(apiId="${worst.app}", level="ERROR")`,
      sampleCorrelationId ? `trace_transaction(query="${sampleCorrelationId}")` : 'trace_transaction(query="<a correlation id from search_logs>")',
    ];

    const summary = [
      matched.some((m) => m.app === worst.app) ? `The evidence points at **${worst.app}**.` : `The freshest error evidence points at **${worst.app}**.`,
      topType ? `Its newest classified error is **${topType}** (${topTypeCount}× total; app error rate ${worst.health.errorRatePct}%).` : `It has ${worst.health.errors} error log line(s) (${worst.health.errorRatePct}%) with no Mule error-type block — inspect the messages/FlowStack.`,
      affectedTransactionCount !== null
        ? `Impact: ${affectedTransactionCount} failing transaction(s) — unique correlation ids across ${worst.health.errors} error log lines; each failed transaction writes several lines.`
        : `Impact: ${worst.health.errors} error log line(s); the error lines carry no correlation ids, so the count of failing transactions is unknown.`,
      failingRequest ? `Failing request: ${failingRequest.method} ${failingRequest.url}.` : "",
      symptomApp ? `**${symptomApp}** is failing as a symptom of ${worst.app}'s ${topType}.` : "",
      infoLevelErrors > 0 ? `Note: ${infoLevelErrors} of these failures are logged at INFO level (DefaultExceptionListener), so platform error-rate metrics read 0% — the errors above were counted from message content/error types.` : "",
      `Likely fix: ${remediation}`,
      sampleCorrelationId ? `Trace a failing transaction: ${sampleCorrelationId}.` : "",
    ].filter(Boolean).join("\n");

    return {
      source: this.sourceKind,
      question,
      matchedApps: matched.map((m) => m.app),
      brokenApp: worst.app,
      symptomApp,
      rootCauseErrorType: topType,
      sampleCorrelationId,
      affectedTransactionCount,
      affectedTransactionsHint: `Run search_logs(apiId="${worst.app}", level="ERROR") to list correlation ids of failed transactions.`,
      evidence,
      remediation,
      suggestedTools,
      summary,
    };
  }
}
