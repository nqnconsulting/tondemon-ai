// A Source is whatever backs the tools: the bundled demo estate, or a live
// directory of Mule runtime logs. Both implement the same surface so the 9
// tools never branch on which one is active. Each method returns a plain
// JSON-serialisable object that the tool wraps verbatim.

export type Result = Record<string, unknown>;
/** Sources may answer synchronously (mock/logs) or async (live platform APIs). */
export type MaybeAsync<T> = T | Promise<T>;

export interface Source {
  kind: "mock" | "mule-logs" | "anypoint";
  /** Human-readable description of what's backing the server right now. */
  describe(): MaybeAsync<Result>;

  listApis(layer?: string): MaybeAsync<Result>;
  listFlows(entity?: string): MaybeAsync<Result>;
  getApiHealth(apiId: string): MaybeAsync<Result>;
  getEstateHealth(): MaybeAsync<Result>;
  traceTransaction(query: string): MaybeAsync<Result>;
  getQueueStatus(queueName?: string): MaybeAsync<Result>;
  getDlqMessages(queue: string, limit?: number): MaybeAsync<Result>;
  searchLogs(filter: {
    apiId?: string;
    level?: string;
    contains?: string;
    sinceMinutes?: number;
    limit?: number;
  }): MaybeAsync<Result>;
  diagnose(question: string): MaybeAsync<Result>;
}
