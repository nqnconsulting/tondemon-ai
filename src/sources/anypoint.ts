import type { Source, Result } from "./types.js";
import { parseLogText, type MuleRecord } from "../adapters/muleLog.js";
import { LogAnalyzer } from "../engine/logAnalysis.js";

// Live source: the real Anypoint Platform (CloudHub 2.0 / Runtime Manager) via
// a connected app (client_credentials). Read-only — it only ever GETs.
//
// It authenticates, resolves the target environment, lists deployments and
// reports their status/health. It degrades honestly: if the connected app lacks
// a scope, or nothing is deployed, each tool says exactly that (and what to
// grant) instead of pretending. As soon as apps are deployed and the app has
// Runtime Manager read on the environment, the same tools light up with real
// data.

interface AnypointConfig {
  clientId: string;
  clientSecret: string;
  orgId: string;
  envName?: string;
  envId?: string;
  host?: string;
}

interface Deployment {
  id: string;
  name: string;
  status?: string;
  application?: { status?: string };
  target?: { provider?: string };
  lastModifiedDate?: string;
}

interface ApiInstancePolicies {
  apiInstanceId: string;
  assetId: string | null;
  label: string | null;
  policies: { name: string; enabled: boolean }[];
}

interface PolicyData {
  access: string;
  instances: ApiInstancePolicies[];
}

export class AnypointSource implements Source {
  kind = "anypoint" as const;
  private cfg: Required<Pick<AnypointConfig, "clientId" | "clientSecret" | "orgId">> & AnypointConfig;
  private host: string;
  private tokenCache?: { token: string; expEpochMs: number };
  private bootstrapPromise?: Promise<{ envId: string | null; deployments: Deployment[]; access: string }>;
  private logCache?: { atMs: number; analyzer: LogAnalyzer };
  private policyCache?: { atMs: number; data: PolicyData };

  constructor(cfg: AnypointConfig) {
    this.cfg = cfg;
    this.host = cfg.host || "anypoint.mulesoft.com";
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expEpochMs > now + 30_000) return this.tokenCache.token;
    const res = await fetch(`https://${this.host}/accounts/api/v2/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.tokenCache = { token: body.access_token, expEpochMs: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async get(path: string): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
    const token = await this.token();
    const res = await fetch(`https://${this.host}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, ok: res.ok, json: parsed, text };
  }

  // ---- Bootstrap: resolve env + list deployments (memoised) ----------------

  private bootstrap() {
    if (!this.bootstrapPromise) this.bootstrapPromise = this.doBootstrap();
    return this.bootstrapPromise;
  }

  private async doBootstrap(): Promise<{ envId: string | null; deployments: Deployment[]; access: string }> {
    // 1) Resolve environment id.
    let envId = this.cfg.envId ?? null;
    let access = "ok";
    if (!envId) {
      const r = await this.get(`/accounts/api/organizations/${this.cfg.orgId}/environments`);
      if (r.ok && r.json && Array.isArray((r.json as any).data)) {
        const envs = (r.json as any).data as Array<{ id: string; name: string }>;
        const match = this.cfg.envName
          ? envs.find((e) => e.name.toLowerCase() === this.cfg.envName!.toLowerCase())
          : envs[0];
        envId = match?.id ?? envs[0]?.id ?? null;
      } else {
        access = `environment list not accessible (HTTP ${r.status}); connected app needs "Environment — Read" / Runtime Manager read, or set ANYPOINT_ENV_ID explicitly.`;
      }
    }

    // 2) List CloudHub 2.0 deployments for that environment.
    let deployments: Deployment[] = [];
    if (envId) {
      const r = await this.get(
        `/amc/application-manager/api/v2/organizations/${this.cfg.orgId}/environments/${envId}/deployments`,
      );
      if (r.ok && r.json) {
        const items = (r.json as any).items ?? (r.json as any).data ?? [];
        deployments = (items as any[]).map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status ?? d.application?.status,
          application: d.application,
          target: d.target,
          lastModifiedDate: d.lastModifiedDate,
        }));
      } else if (access === "ok") {
        access = `deployments not accessible (HTTP ${r.status}); connected app needs Runtime Manager read on this environment.`;
      }
    }
    return { envId, deployments, access };
  }

  private statusFromDeployment(d: Deployment): "healthy" | "degraded" | "down" | "unknown" {
    const s = (d.status ?? d.application?.status ?? "").toUpperCase();
    if (["RUNNING", "STARTED", "APPLIED"].includes(s)) return "healthy";
    if (["DEPLOYING", "STARTING", "UPDATING", "PARTIALLY_STARTED"].includes(s)) return "degraded";
    if (["UNDEPLOYED", "STOPPED", "FAILED", "DELETED"].includes(s)) return "down";
    return "unknown";
  }

  // ---- CloudHub 2.0 log retrieval -----------------------------------------
  //
  // CloudHub 2.0 logs ARE Mule-format log lines, so once fetched they go through
  // the SAME parser + LogAnalyzer as file logs — search/trace/diagnose come for
  // free. Endpoint shape (per MuleSoft docs / community):
  //   detail: GET .../deployments/{id}                       → specification id
  //   logs:   GET .../deployments/{id}/specs/{specId}/logs   → log records
  // Response shapes vary by runtime version, so entry mapping is defensive.
  // Verified end-to-end requires a deployed app + Runtime Manager read.

  private deploymentsPath(envId: string): string {
    return `/amc/application-manager/api/v2/organizations/${this.cfg.orgId}/environments/${envId}/deployments`;
  }

  private async specIdFor(envId: string, deploymentId: string): Promise<string | null> {
    const r = await this.get(`${this.deploymentsPath(envId)}/${deploymentId}`);
    if (!r.ok || !r.json) return null;
    const d = r.json as any;
    return (
      d.desiredVersion ??
      d.specificationId ??
      d.currentDeployment?.specId ??
      d.currentDeployment?.id ??
      d.application?.desiredVersion ??
      d.specs?.[0]?.version ??
      null
    );
  }

  /** Epoch ms of a CH2 log entry's own (API-side) timestamp; 0 when unusable. */
  private entryEpochMs(entry: any): number {
    return typeof entry?.timestamp === "number" ? entry.timestamp : Date.parse(entry?.timestamp ?? "") || 0;
  }

  private ch2EntryToRecords(app: string, entry: any): MuleRecord[] {
    const msg = String(entry?.message ?? entry?.log ?? entry?.line ?? "");
    // If the log entry's message already carries the Mule header, parse it
    // properly (gets flow / event / error-type for free).
    const parsed = parseLogText(app, msg).map((r) => ({ ...r, app }));
    if (parsed.length) {
      // The API entry's timestamp is authoritative for recency; parsing the
      // time out of the log-line text is best-effort. Backfill when the parse
      // produced no usable epochMs.
      const apiMs = this.entryEpochMs(entry);
      return parsed.map((r) =>
        r.epochMs || !apiMs ? r : { ...r, epochMs: apiMs, ts: new Date(apiMs).toISOString() },
      );
    }
    // Otherwise synthesise a record from the structured fields + best-effort
    // extraction of a correlation id / error type from the message text.
    const level = String(entry?.priority ?? entry?.logLevel ?? entry?.level ?? "INFO").toUpperCase();
    const epochMs = this.entryEpochMs(entry);
    const cid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(msg)?.[0];
    const etype = /\b([A-Z][A-Z0-9_]*:[A-Z0-9_]+)\b/.exec(msg)?.[1];
    return [
      {
        app,
        level: (["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].includes(level) ? level : "INFO") as MuleRecord["level"],
        ts: epochMs ? new Date(epochMs).toISOString() : "",
        epochMs,
        thread: String(entry?.threadName ?? ""),
        correlationId: cid,
        message: msg.slice(0, 1000),
        errorType: etype,
      },
    ];
  }

  /** One GET against the CH2 logs endpoint; returns the raw entry array ([] on failure). */
  private async fetchLogPage(envId: string, deploymentId: string, specId: string, query: string): Promise<any[]> {
    const r = await this.get(`${this.deploymentsPath(envId)}/${deploymentId}/specs/${specId}/logs${query}`);
    if (!r.ok || !r.json) return [];
    return Array.isArray(r.json) ? r.json : (r.json as any).data ?? (r.json as any).items ?? (r.json as any).logs ?? [];
  }

  // Live-verified endpoint behavior (curl against the real CH2 API): the logs
  // endpoint returns a FIXED page of 10 entries — limit/pageSize/size/offset
  // are ignored. Default order is ASCENDING FROM APP START (a naive GET yields
  // the app's oldest 10 lines forever). `descending=true` returns the newest
  // 10 but ignores startTime/endTime; ascending honors `startTime`. So we grab
  // the newest 10 once, then page ascending through a recent window
  // (LOG_WINDOW_MS, default 48h) up to LOG_MAX_PAGES pages, and merge.
  private async fetchAppLogs(envId: string, d: Deployment): Promise<MuleRecord[]> {
    const windowMs = Number(process.env.LOG_WINDOW_MS) || 48 * 60 * 60 * 1000;
    const maxPages = Number(process.env.LOG_MAX_PAGES) || 12;
    const specId = await this.specIdFor(envId, d.id);
    if (!specId) return [];

    // 1) Newest 10 entries, guaranteed regardless of window.
    const newest = await this.fetchLogPage(envId, d.id, specId, "?descending=true");
    const newestMaxMs = newest.reduce((m, e) => Math.max(m, this.entryEpochMs(e)), 0);

    // 2) Page ascending from the start of the recent window (total requests
    //    per app: 1 + at most maxPages).
    const entries: any[] = [...newest];
    let cursor = Date.now() - windowMs;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.fetchLogPage(envId, d.id, specId, `?startTime=${cursor}`);
      if (!batch.length) break;
      entries.push(...batch);
      const batchMaxMs = batch.reduce((m, e) => Math.max(m, this.entryEpochMs(e)), 0);
      if (batchMaxMs + 1 <= cursor) break; // cursor didn't advance — never loop forever
      cursor = batchMaxMs + 1;
      if (batch.length < 10) break; // short page = end of the log
      if (newestMaxMs && cursor > newestMaxMs) break; // caught up with the newest entry
    }

    // 3) Dedupe (ascending pages overlap the descending page near "now").
    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      const msg = String(e?.message ?? e?.log ?? e?.line ?? "");
      const key = `${this.entryEpochMs(e)}|${msg.slice(0, 120)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.flatMap((e) => this.ch2EntryToRecords(d.name, e));
  }

  /** Build (and briefly cache) a LogAnalyzer over the deployed apps' CH2 logs. */
  private async analyzer(): Promise<LogAnalyzer | null> {
    if (this.logCache && Date.now() - this.logCache.atMs < 30_000) return this.logCache.analyzer;
    const boot = await this.bootstrap();
    if (!boot.envId || !boot.deployments.length) return null;
    // Fetch every app's logs in parallel (mirrors getEstateHealth's fan-out);
    // one app's failed log read must not sink the others.
    const perApp = await Promise.allSettled(boot.deployments.map((d) => this.fetchAppLogs(boot.envId!, d)));
    const all: MuleRecord[] = perApp.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (!all.length) return null;
    const analyzer = new LogAnalyzer(all, { sourceKind: this.kind });
    this.logCache = { atMs: Date.now(), analyzer };
    return analyzer;
  }

  // ---- API Manager: policies applied per API instance ----------------------
  //
  // Read-only. Lists the API instances in this environment and the policies
  // applied to each (rate-limiting, client-id-enforcement, JWT, etc.). Needs
  // the connected app to have API Manager read; degrades honestly on 401.
  // API instances are matched to CloudHub deployments by asset id / label.

  private async fetchPolicies(envId: string): Promise<PolicyData> {
    if (this.policyCache && Date.now() - this.policyCache.atMs < 60_000) return this.policyCache.data;
    const base = `/apimanager/api/v1/organizations/${this.cfg.orgId}/environments/${envId}/apis`;
    const r = await this.get(base);
    if (!r.ok || !r.json) {
      const data: PolicyData = {
        access: `API Manager not accessible (HTTP ${r.status}); connected app needs "API Manager — Read" (View APIs Configuration) to list policies.`,
        instances: [],
      };
      this.policyCache = { atMs: Date.now(), data };
      return data;
    }
    // Shape varies: { assets: [ { assetId, apis: [ { id, instanceLabel } ] } ] } or { apis: [...] }.
    const body = r.json as any;
    const collected: Array<{ id: string | number; assetId: string | null; label: string | null }> = [];
    if (Array.isArray(body.assets)) {
      for (const a of body.assets) {
        const assetId = a.assetId ?? a.exchangeAssetName ?? null;
        for (const api of a.apis ?? []) {
          collected.push({ id: api.id, assetId, label: api.instanceLabel ?? api.autodiscoveryInstanceName ?? null });
        }
      }
    } else {
      const arr = body.apis ?? body.instances ?? (Array.isArray(body) ? body : []);
      for (const api of arr as any[]) {
        collected.push({ id: api.id, assetId: api.assetId ?? api.exchangeAssetName ?? null, label: api.instanceLabel ?? api.autodiscoveryInstanceName ?? null });
      }
    }
    const instances: ApiInstancePolicies[] = [];
    for (const c of collected) {
      let policies: { name: string; enabled: boolean }[] = [];
      try {
        const pr = await this.get(`${base}/${c.id}/policies`);
        if (pr.ok && pr.json) {
          const arr = Array.isArray(pr.json) ? pr.json : ((pr.json as any).policies ?? (pr.json as any).data ?? []);
          policies = (arr as any[]).map((p) => ({
            name: p.policyTemplateId ?? p.template?.assetId ?? p.implementationAsset?.name ?? p.asset?.assetId ?? p.assetId ?? "policy",
            enabled: p.disabled === true ? false : true,
          }));
        }
      } catch {
        /* skip an instance whose policies we can't read */
      }
      instances.push({ apiInstanceId: String(c.id), assetId: c.assetId, label: c.label, policies });
    }
    const data: PolicyData = { access: "ok", instances };
    this.policyCache = { atMs: Date.now(), data };
    return data;
  }

  private instanceMatchesApp(i: ApiInstancePolicies, appName: string): boolean {
    const lc = appName.toLowerCase();
    const a = (i.assetId ?? "").toLowerCase();
    const l = (i.label ?? "").toLowerCase();
    return (!!a && (lc.includes(a) || a.includes(lc))) || (!!l && (lc.includes(l) || l.includes(lc)));
  }

  private matchPolicies(appName: string, pd: PolicyData): string[] {
    const set = new Set<string>();
    for (const i of pd.instances) if (this.instanceMatchesApp(i, appName)) i.policies.forEach((p) => set.add(p.enabled ? p.name : `${p.name} (disabled)`));
    return [...set];
  }

  /** Per-app extras shared by estate + single-app health: top errors (from logs) and applied policies. */
  private async appExtras(
    appName: string,
    envId: string | null,
    analyzer: LogAnalyzer | null,
    pd: PolicyData,
  ): Promise<{ errorRatePct: number | null; topErrors: { errorType: string; count: number }[]; policies: string[] }> {
    let errorRatePct: number | null = null;
    let topErrors: { errorType: string; count: number }[] = [];
    if (analyzer && analyzer.apps.includes(appName)) {
      const h = analyzer.healthOf(appName);
      errorRatePct = h.errorRatePct;
      topErrors = h.errorBreakdown.slice(0, 5).map((e) => ({ errorType: e.code, count: e.count }));
    }
    return { errorRatePct, topErrors, policies: envId ? this.matchPolicies(appName, pd) : [] };
  }

  // ---- Source interface ----------------------------------------------------

  async describe(): Promise<Result> {
    let identity: string | null = null;
    let authError: string | null = null;
    try {
      const me = await this.get("/accounts/api/me");
      const m = me.json as any;
      identity = m?.user?.organization?.name ?? m?.organization?.name ?? null;
    } catch (e) {
      authError = (e as Error).message;
    }
    const boot = authError ? null : await this.bootstrap().catch((e) => ({ envId: null, deployments: [], access: (e as Error).message }));
    return {
      kind: this.kind,
      mode: "live Anypoint Platform (CloudHub 2.0, read-only)",
      host: this.host,
      org: identity,
      orgId: this.cfg.orgId,
      environmentName: this.cfg.envName ?? null,
      environmentId: boot?.envId ?? null,
      authenticated: !authError,
      authError,
      deployedApps: boot?.deployments.length ?? 0,
      access: boot?.access ?? "n/a",
      note: "Read-only. Lists CloudHub 2.0 deployments + status. Latency/queue/DLQ/transaction-trace need Anypoint Monitoring / MQ admin APIs and are reported as unavailable until wired.",
    };
  }

  private async emptyOr<T>(build: (deployments: Deployment[], envId: string | null, access: string) => T): Promise<T | Result> {
    const boot = await this.bootstrap();
    return build(boot.deployments, boot.envId, boot.access);
  }

  async listApis(): Promise<Result> {
    return this.emptyOr((deployments, envId, access) => ({
      source: this.kind,
      org: this.cfg.orgId,
      environmentId: envId,
      count: deployments.length,
      access,
      apps: deployments.map((d) => ({ id: d.name, deploymentId: d.id, status: this.statusFromDeployment(d), target: d.target?.provider, lastModified: d.lastModifiedDate })),
      note: deployments.length ? undefined : "No CloudHub 2.0 apps deployed in this environment yet (or Runtime Manager read not granted). Deploy apps, then this lists them live.",
    }));
  }

  async listFlows(): Promise<Result> {
    return {
      source: this.kind,
      unavailable: true,
      reason: "Flow inventory isn't exposed by Runtime Manager. Use the Mule-logs source (MULE_LOG_DIR) for per-app flows, or read the apps' specs in Exchange.",
    };
  }

  async getApiHealth(apiId: string): Promise<Result> {
    const boot = await this.bootstrap();
    const deployments = boot.deployments;
    const d =
      deployments.find((x) => x.name === apiId) ??
      deployments.find((x) => x.name.toLowerCase() === apiId.toLowerCase());
    if (!d) {
      return {
        source: this.kind,
        apiId,
        deployed: false,
        status: "not-deployed",
        environmentId: boot.envId,
        environmentName: this.cfg.envName ?? null,
        message: `'${apiId}' is NOT deployed in the ${this.cfg.envName ?? "target"} environment.`,
        deployedApps: deployments.map((x) => x.name),
        hint: deployments.length
          ? "If you expected it to be running, it may be undeployed/failed or named differently — see deployedApps."
          : "No applications are deployed in this environment at all.",
      };
    }
    const analyzer = await this.analyzer().catch(() => null);
    const pd = boot.envId
      ? await this.fetchPolicies(boot.envId).catch((e) => ({ access: (e as Error).message, instances: [] } as PolicyData))
      : ({ access: "no environment resolved", instances: [] } as PolicyData);
    const extras = await this.appExtras(d.name, boot.envId, analyzer, pd);
    return {
      source: this.kind,
      apiId,
      deployed: true,
      environmentId: boot.envId,
      deploymentId: d.id,
      status: this.statusFromDeployment(d),
      rawStatus: d.status ?? d.application?.status ?? null,
      target: d.target?.provider ?? null,
      lastModified: d.lastModifiedDate ?? null,
      errorRatePct: extras.errorRatePct,
      topErrors: extras.topErrors,
      policies: extras.policies,
      policyAccess: pd.access,
      logAccess: analyzer ? "ok" : "no CloudHub 2.0 logs readable yet (Runtime Manager log read, or none emitted)",
      note: "topErrors from CloudHub 2.0 logs; policies from API Manager. Error-rate/latency trends need Anypoint Monitoring.",
    };
  }

  async getEstateHealth(): Promise<Result> {
    const boot = await this.bootstrap();
    const deployments = boot.deployments;
    const analyzer = await this.analyzer().catch(() => null);
    const pd = boot.envId
      ? await this.fetchPolicies(boot.envId).catch((e) => ({ access: (e as Error).message, instances: [] } as PolicyData))
      : ({ access: "no environment resolved", instances: [] } as PolicyData);

    const apps = await Promise.all(
      deployments.map(async (d) => {
        const extras = await this.appExtras(d.name, boot.envId, analyzer, pd);
        return {
          apiId: d.name,
          status: this.statusFromDeployment(d),
          rawStatus: d.status ?? d.application?.status ?? null,
          errorRatePct: extras.errorRatePct,
          topErrors: extras.topErrors,
          policies: extras.policies,
        };
      }),
    );
    const overall = !apps.length
      ? "unknown"
      : apps.some((a) => a.status === "down")
        ? "down"
        : apps.some((a) => a.status === "degraded")
          ? "degraded"
          : "healthy";
    return {
      source: this.kind,
      environmentId: boot.envId,
      overall,
      apps,
      access: boot.access,
      logAccess: analyzer
        ? "ok"
        : "CloudHub 2.0 logs not available (no Runtime Manager log read, or none emitted yet) — topErrors stay empty until logs are readable.",
      policyAccess: pd.access,
      policyCatalog: pd.instances.map((i) => ({
        apiInstance: i.label ?? i.assetId ?? i.apiInstanceId,
        assetId: i.assetId,
        policies: i.policies.map((p) => (p.enabled ? p.name : `${p.name} (disabled)`)),
      })),
      note: apps.length
        ? "Per app: status + errorRatePct + topErrors (up to 5 most frequent Mule error types from CloudHub 2.0 logs) + policies (API Manager policies on the matching API instance). policyCatalog lists every API Manager instance in case deployment-name matching is imperfect."
        : "Nothing deployed yet (or no Runtime Manager read). Once apps run, this shows live deployment health.",
    };
  }

  async traceTransaction(query: string): Promise<Result> {
    const analyzer = await this.analyzer();
    if (analyzer) return { ...analyzer.traceTransaction(query), via: "cloudhub2-logs" };
    return {
      source: this.kind,
      unavailable: true,
      requestedQuery: query,
      reason: "No CloudHub 2.0 logs available to trace (no deployed apps, or Runtime Manager log read not granted). Once apps are deployed, traces come from the CH2 logs API; or point the server at log files (MULE_LOG_DIR).",
    };
  }

  async getQueueStatus(queueName?: string): Promise<Result> {
    return { source: this.kind, unavailable: true, requestedQueue: queueName ?? null, reason: "Queue depth / DLQ state need the Anypoint MQ admin API (separate connected-app scope), not Runtime Manager." };
  }

  async getDlqMessages(queue: string): Promise<Result> {
    return { source: this.kind, unavailable: true, requestedQueue: queue, reason: "Dead-letter message bodies live on Anypoint MQ. Wire the MQ admin API to populate this." };
  }

  async searchLogs(filter: { apiId?: string; level?: string; contains?: string; sinceMinutes?: number; limit?: number }): Promise<Result> {
    const analyzer = await this.analyzer();
    if (analyzer) return { ...analyzer.searchLogs(filter), via: "cloudhub2-logs" };
    return {
      source: this.kind,
      count: 0,
      lines: [],
      note: "No CloudHub 2.0 logs available (no deployed apps, or Runtime Manager log read not granted). Once apps are deployed this searches their CH2 logs; for full log search now use MULE_LOG_DIR.",
    };
  }

  async diagnose(question: string): Promise<Result> {
    // Prefer real root cause from CloudHub 2.0 logs when we can read them.
    const analyzer = await this.analyzer();
    if (analyzer && !analyzer.isEmpty) return { ...analyzer.diagnose(question), via: "cloudhub2-logs" };

    const boot = await this.bootstrap();
    if (!boot.deployments.length) {
      return {
        source: this.kind,
        question,
        verdict: "Connected to the Anypoint Platform, but there are no running apps to diagnose yet.",
        org: this.cfg.orgId,
        environmentId: boot.envId,
        access: boot.access,
        suggestedTools: ["describe_source", "get_apis_health"],
        summary:
          "I'm authenticated to your Anypoint org, but no CloudHub 2.0 apps are deployed in this environment (or the connected app lacks Runtime Manager read). Deploy the estate, then ask again — or set MULE_LOG_DIR to diagnose from real Mule logs right now.",
      };
    }
    const down = boot.deployments.filter((d) => this.statusFromDeployment(d) !== "healthy");
    return {
      source: this.kind,
      question,
      environmentId: boot.envId,
      brokenApps: down.map((d) => ({ apiId: d.name, status: this.statusFromDeployment(d) })),
      summary: down.length
        ? `Runtime Manager shows ${down.length} app(s) not healthy: ${down.map((d) => d.name).join(", ")}. For root cause (error type, correlation id) wire Anypoint Monitoring or use the Mule-logs source.`
        : "All deployed apps report a healthy Runtime Manager status. For message-level root cause (why a specific record didn't arrive), wire Anypoint Monitoring or use the Mule-logs source.",
    };
  }
}
