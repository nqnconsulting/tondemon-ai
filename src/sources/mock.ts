import type { Source } from "./types.js";
import type { Layer, LogLevel } from "../types.js";
import { APIS, FLOWS, findApi } from "../data/estate.js";
import { HEALTH, getHealth } from "../data/telemetry.js";
import { QUEUES, getQueue, getDlqMessages } from "../data/queues.js";
import { findTransaction } from "../data/transactions.js";
import { queryLogs } from "../data/logs.js";
import { diagnose } from "../engine/diagnose.js";
import { isoMinutesAgo, humanMinutesAgo } from "../scenario.js";

// The bundled demo estate (one hand-built incident). This is the default when
// no MULE_LOG_DIR is configured — it makes the server self-demonstrating.

export class MockSource implements Source {
  kind = "mock" as const;

  describe() {
    return {
      kind: this.kind,
      mode: "bundled demo estate",
      note: "Mocked estate with one scripted incident (orders → Salesforce, OAuth 401). Set MULE_LOG_DIR to point at a real Mule logs directory instead.",
      apis: APIS.length,
      flows: FLOWS.length,
    };
  }

  listApis(layer?: string) {
    const apis = (layer ? APIS.filter((a) => a.layer === (layer as Layer)) : APIS).map((a) => ({
      id: a.id,
      name: a.name,
      layer: a.layer,
      owner: a.owner,
      description: a.description,
      calls: a.calls ?? [],
      status: getHealth(a.id)?.status ?? "n/a",
    }));
    return { source: this.kind, count: apis.length, apis };
  }

  listFlows(entity?: string) {
    const e = entity?.toLowerCase();
    const flows = FLOWS.filter(
      (f) => !e || f.entities.some((k) => k.includes(e)) || f.name.toLowerCase().includes(e),
    ).map((f) => ({
      id: f.id,
      name: f.name,
      direction: f.direction,
      steps: f.steps.map((s, i) => `${i + 1}. [${s.kind}] ${s.ref} — ${s.action}`),
    }));
    return { source: this.kind, count: flows.length, flows };
  }

  getApiHealth(apiId: string) {
    const api = findApi(apiId);
    const health = getHealth(apiId);
    if (!api || !health) return { error: `Unknown apiId '${apiId}'. Call list_apis for valid ids.` };
    return {
      source: this.kind,
      api: { id: api.id, name: api.name, layer: api.layer, owner: api.owner },
      ...health,
      incident: health.incident
        ? { ...health.incident, startedAt: isoMinutesAgo(health.incident.startedMinutesAgo) }
        : undefined,
    };
  }

  getEstateHealth() {
    const apis = Object.values(HEALTH).map((h) => ({
      apiId: h.apiId,
      status: h.status,
      errorRatePct: h.errorRatePct,
      throughputRpm: h.throughputRpm,
      topError: h.errorBreakdown[0]?.code ?? null,
    }));
    const incidents = Object.values(HEALTH)
      .map((h) => h.incident)
      .filter((v, i, arr) => v && arr.findIndex((x) => x?.id === v?.id) === i)
      .map((inc) => ({
        id: inc!.id,
        startedAt: isoMinutesAgo(inc!.startedMinutesAgo),
        startedAgo: humanMinutesAgo(inc!.startedMinutesAgo),
        summary: inc!.summary,
      }));
    return {
      source: this.kind,
      overall: apis.some((a) => a.status === "down")
        ? "down"
        : apis.some((a) => a.status === "degraded")
          ? "degraded"
          : "healthy",
      apis,
      openIncidents: incidents,
    };
  }

  traceTransaction(query: string) {
    const tx = findTransaction(query);
    if (!tx) {
      return {
        error: `No trace found for '${query}'.`,
        hint: "Try an order number like '10042', or call get_dlq_messages to list stuck items.",
      };
    }
    return {
      source: this.kind,
      correlationId: tx.correlationId,
      businessKey: tx.businessKey,
      flowId: tx.flowId,
      status: tx.status,
      startedAt: isoMinutesAgo(tx.startedMinutesAgo),
      hops: tx.hops.map((h) => ({
        ref: h.ref,
        kind: h.kind,
        action: h.action,
        status: h.status,
        at: isoMinutesAgo(h.atMinutesAgo),
        latencyMs: h.latencyMs,
        detail: h.detail,
      })),
      failedAt: [...tx.hops].reverse().find((h) => h.status === "error")?.ref ?? null,
    };
  }

  getQueueStatus(queueName?: string) {
    if (queueName) {
      const q = getQueue(queueName);
      return q ? { source: this.kind, ...q } : { error: `Unknown queue '${queueName}'.` };
    }
    return { source: this.kind, count: QUEUES.length, queues: QUEUES };
  }

  getDlqMessages(queue: string, limit?: number) {
    const q = getQueue(queue);
    if (!q) return { error: `Unknown queue '${queue}'.` };
    const sample = getDlqMessages(queue)
      .slice(0, limit ?? 10)
      .map((m) => ({ ...m, enqueuedAt: isoMinutesAgo(m.enqueuedMinutesAgo) }));
    return {
      source: this.kind,
      queue,
      totalDepth: q.depth,
      returned: sample.length,
      commonError: sample[0]?.errorCode ?? null,
      failedAt: sample[0]?.failedAt ?? null,
      messages: sample,
    };
  }

  searchLogs(filter: { apiId?: string; level?: string; contains?: string; sinceMinutes?: number; limit?: number }) {
    const lines = queryLogs(
      { apiId: filter.apiId, level: filter.level as LogLevel | undefined, contains: filter.contains, sinceMinutes: filter.sinceMinutes },
      filter.limit ?? 50,
    );
    return {
      source: this.kind,
      count: lines.length,
      lines: lines.map((l) => ({
        at: isoMinutesAgo(l.minutesAgo),
        ago: humanMinutesAgo(l.minutesAgo),
        api: l.apiId,
        level: l.level,
        correlationId: l.correlationId,
        message: l.message,
      })),
    };
  }

  diagnose(question: string) {
    return { source: this.kind, ...diagnose(question) };
  }
}
