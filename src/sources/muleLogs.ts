import type { Source } from "./types.js";
import { loadLogDir, type MuleLogIndex } from "../adapters/muleLog.js";
import { LogAnalyzer } from "../engine/logAnalysis.js";

// Live source: discovers an estate purely from a directory of Mule runtime
// logs. No naming convention is assumed — apps come from log filenames, flows
// and correlation ids from the universal `[processor: …; event: …]` header, and
// root causes from the `Error type` / `FlowStack` blocks. Works for any client.
//
// All analysis is delegated to the shared LogAnalyzer (also used by the live
// CloudHub 2.0 source). This source only owns log *loading* + the queue/DLQ
// notices that are specific to reading from files.

export class MuleLogSource implements Source {
  kind = "mule-logs" as const;
  private idx: MuleLogIndex;
  private analyzer: LogAnalyzer;

  constructor(dir: string) {
    this.idx = loadLogDir(dir);
    this.analyzer = new LogAnalyzer(this.idx.records, { sourceKind: this.kind, asOfEpochMs: this.idx.asOfEpochMs });
  }

  describe() {
    return {
      kind: this.kind,
      mode: "live Mule runtime logs",
      dir: this.idx.dir,
      files: this.idx.fileCount,
      apps: this.idx.apps.length,
      records: this.idx.records.length,
      asOf: this.idx.asOfEpochMs ? new Date(this.idx.asOfEpochMs).toISOString() : null,
      note: "Estate discovered from log filenames + the universal Mule log format. No client naming convention assumed.",
    };
  }

  listApis() {
    return this.analyzer.listApis();
  }
  listFlows(entity?: string) {
    return this.analyzer.listFlows(entity);
  }
  getApiHealth(apiId: string) {
    return this.analyzer.getApiHealth(apiId);
  }
  getEstateHealth() {
    return this.analyzer.getEstateHealth();
  }
  traceTransaction(query: string) {
    return this.analyzer.traceTransaction(query);
  }
  searchLogs(filter: { apiId?: string; level?: string; contains?: string; sinceMinutes?: number; limit?: number }) {
    return this.analyzer.searchLogs(filter);
  }
  diagnose(question: string) {
    return this.analyzer.diagnose(question);
  }

  getQueueStatus(queueName?: string) {
    // Queue depth/DLQ state needs the broker (AMQP/Anypoint MQ) admin API, not
    // app logs. Surface what the logs *can* tell us instead.
    const amqp = this.idx.records.filter((r) => r.errorType?.startsWith("AMQP")).length;
    return {
      source: this.kind,
      unavailable: true,
      reason: "Queue depth and dead-letter contents are not in application logs; connect the broker admin API (AMQP/RabbitMQ or Anypoint MQ) to populate this.",
      observedFromLogs: { amqpErrorRecords: amqp },
      requestedQueue: queueName ?? null,
    };
  }

  getDlqMessages(queue: string) {
    return {
      source: this.kind,
      unavailable: true,
      reason: "Dead-letter message bodies live on the broker, not in app logs. Use search_logs (e.g. contains='dead' or level='ERROR') and trace_transaction to follow failed messages.",
      requestedQueue: queue,
    };
  }
}
