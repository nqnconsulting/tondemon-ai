// Shared domain types for the integration-monitor MCP server.
//
// The whole estate is a *mock*: there is no live SAP, Salesforce, Anypoint MQ or
// MuleSoft runtime behind it. The data is hand-built to tell one coherent
// incident story ("orders are no longer reaching Salesforce") so that any
// MCP-capable agent driving these tools reaches the same, correct root cause.

export type Layer = "channel" | "experience" | "process" | "system" | "backend";

export type Health = "healthy" | "degraded" | "down";

export interface Api {
  id: string;
  name: string;
  layer: Layer;
  description: string;
  /** Team that owns the deployable. */
  owner: string;
  /** ids of APIs / backends this one calls (for topology + tracing). */
  calls?: string[];
}

export type StepKind = "api" | "queue" | "backend";

export interface FlowStep {
  /** api id, `queue:<name>`, or backend id. */
  ref: string;
  kind: StepKind;
  /** What happens at this hop, in business terms. */
  action: string;
}

/** A named business flow a manager would recognise ("Order → Salesforce"). */
export interface Flow {
  id: string;
  name: string;
  /** Plain-language keywords used to match a manager's question to this flow. */
  entities: string[];
  direction: string;
  steps: FlowStep[];
}

export interface ErrorBucket {
  code: string;
  message: string;
  count: number;
}

export interface Incident {
  /** Short stable id, e.g. INC-2041. */
  id: string;
  startedMinutesAgo: number;
  summary: string;
  suspectedCause: string;
  remediation: string[];
}

export interface ApiHealth {
  apiId: string;
  status: Health;
  /** Requests per minute over the last 15 min. */
  throughputRpm: number;
  successRatePct: number;
  errorRatePct: number;
  p95LatencyMs: number;
  errorBreakdown: ErrorBucket[];
  incident?: Incident;
}

export interface QueueStatus {
  name: string;
  /** Messages waiting to be consumed. */
  depth: number;
  /** Messages currently in-flight (delivered, awaiting ack). */
  inFlight: number;
  /** Linked dead-letter queue name, if any. */
  deadLetterQueue?: string;
  /** Age of the oldest waiting message, in minutes. */
  oldestMessageAgeMin: number;
  publishRpm: number;
  consumeRpm: number;
}

export interface DlqMessage {
  messageId: string;
  queue: string;
  correlationId: string;
  /** Business key carried in the payload (e.g. order number). */
  businessKey: string;
  enqueuedMinutesAgo: number;
  errorCode: string;
  errorMessage: string;
  /** Which deployable rejected / failed to deliver the message. */
  failedAt: string;
  redeliveryCount: number;
  payloadExcerpt: Record<string, unknown>;
}

export type TraceStatus = "completed" | "in-progress" | "failed" | "dead-lettered";

export interface TraceHop {
  ref: string;
  kind: StepKind;
  action: string;
  status: "ok" | "error" | "skipped" | "pending";
  atMinutesAgo: number;
  latencyMs?: number;
  detail?: string;
}

export interface Transaction {
  correlationId: string;
  businessKey: string;
  flowId: string;
  status: TraceStatus;
  startedMinutesAgo: number;
  hops: TraceHop[];
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogLine {
  apiId: string;
  level: LogLevel;
  minutesAgo: number;
  correlationId?: string;
  message: string;
}
