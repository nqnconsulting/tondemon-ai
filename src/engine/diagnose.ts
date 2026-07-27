import type { Flow, FlowStep } from "../types.js";
import { matchFlow, findApi } from "../data/estate.js";
import { getHealth } from "../data/telemetry.js";
import { getQueue, getDlqMessages } from "../data/queues.js";
import { latestTransactionForFlow } from "../data/transactions.js";
import { humanMinutesAgo } from "../scenario.js";

export interface Diagnosis {
  question: string;
  matchedFlow: { id: string; name: string; direction: string } | null;
  verdict: string;
  brokenHop: { ref: string; layer: string; action: string } | null;
  rootCause: string | null;
  /** Correlation ids of affected transactions, for handoff / further tracing. */
  correlationIds: string[];
  /** A single representative correlation id to quote in the answer. */
  sampleCorrelationId: string | null;
  evidence: string[];
  impact: string | null;
  remediation: string[];
  suggestedTools: string[];
  summary: string;
}

function queueName(step: FlowStep): string | null {
  return step.ref.startsWith("queue:") ? step.ref.slice("queue:".length) : null;
}

/**
 * Find the hop that is the *root* of a failure. A failure propagates upstream
 * (a degraded process API is usually just relaying a downstream system API's
 * errors), so we follow the chain to the deepest (furthest-downstream) failing
 * API in flow order — that one owns the cause. Only if no API is failing do we
 * fall back to a queue's overflowing dead-letter queue as the signal.
 */
function findBrokenHop(flow: Flow): { step: FlowStep; reason: string } | null {
  let deepestApi: { step: FlowStep; reason: string } | null = null;
  for (const step of flow.steps) {
    if (step.kind !== "api") continue;
    const h = getHealth(step.ref);
    if (h && (h.status === "down" || h.status === "degraded")) {
      const top = h.errorBreakdown[0];
      deepestApi = {
        step,
        reason: top
          ? `${step.ref} is ${h.status} (${h.errorRatePct}% errors). Top error: ${top.code} — ${top.message}`
          : `${step.ref} is ${h.status} (${h.errorRatePct}% errors).`,
      };
    }
  }
  if (deepestApi) return deepestApi;

  for (const step of flow.steps) {
    const qn = queueName(step);
    const q = qn ? getQueue(qn) : undefined;
    const dlqName = q?.deadLetterQueue;
    const dlq = dlqName ? getQueue(dlqName) : undefined;
    if (dlq && dlq.depth > 0) {
      return {
        step,
        reason: `${dlq.depth} message(s) parked in ${dlqName} (oldest ${humanMinutesAgo(dlq.oldestMessageAgeMin)}).`,
      };
    }
  }
  return null;
}

export function diagnose(question: string): Diagnosis {
  const match = matchFlow(question);

  if (!match) {
    return {
      question,
      matchedFlow: null,
      verdict: "Could not map the question to a known business flow.",
      brokenHop: null,
      rootCause: null,
      correlationIds: [],
      sampleCorrelationId: null,
      evidence: [],
      impact: null,
      remediation: [],
      suggestedTools: ["list_flows", "get_apis_health"],
      summary:
        "I couldn't match that question to a known flow. Call list_flows to see what's monitored (e.g. 'Order → Salesforce', 'Inventory adjustment → SAP WMS') and rephrase using one of those entities.",
    };
  }

  const flow = match.flow;
  const broken = findBrokenHop(flow);

  if (!broken) {
    return {
      question,
      matchedFlow: { id: flow.id, name: flow.name, direction: flow.direction },
      verdict: `The '${flow.name}' flow looks healthy end-to-end.`,
      brokenHop: null,
      rootCause: null,
      correlationIds: [],
      sampleCorrelationId: null,
      evidence: flow.steps.map((s) => `${s.ref}: ${s.action}`),
      impact: "No active incident detected on this flow.",
      remediation: [],
      suggestedTools: [`trace_transaction`, "search_logs"],
      summary: `Every hop in '${flow.name}' (${flow.direction}) is currently healthy. If a specific item is missing, trace it with trace_transaction using its order/reference number.`,
    };
  }

  // Build the evidence chain from the broken hop.
  const evidence: string[] = [broken.reason];
  let rootCause: string | null = null;
  let impact: string | null = null;
  const remediation: string[] = [];
  const suggestedTools = new Set<string>();
  const correlationIds = new Set<string>();

  if (broken.step.kind === "api") {
    const h = getHealth(broken.step.ref)!;
    suggestedTools.add(`get_api_health(apiId="${broken.step.ref}")`);
    suggestedTools.add(`search_logs(apiId="${broken.step.ref}", level="ERROR")`);
    if (h.incident) {
      rootCause = h.incident.suspectedCause;
      impact = h.incident.summary;
      remediation.push(...h.incident.remediation);
      evidence.push(`Incident ${h.incident.id} opened ${humanMinutesAgo(h.incident.startedMinutesAgo)}.`);
    }
  }

  // Pull DLQ corroboration regardless of which hop type tripped first.
  for (const step of flow.steps) {
    const qn = queueName(step);
    const q = qn ? getQueue(qn) : undefined;
    const dlqName = q?.deadLetterQueue;
    const dlq = dlqName ? getQueue(dlqName) : undefined;
    if (dlq && dlq.depth > 0 && dlqName) {
      const sample = getDlqMessages(dlqName);
      const top = sample[0];
      sample.forEach((m) => correlationIds.add(m.correlationId));
      evidence.push(
        `${dlqName}: ${dlq.depth} parked message(s); they all failed at '${top?.failedAt}' with ${top?.errorCode}.`,
      );
      suggestedTools.add(`get_dlq_messages(queue="${dlqName}")`);
      if (!rootCause && top) rootCause = `Messages rejected at ${top.failedAt}: ${top.errorMessage}`;
      if (!impact) impact = `${dlq.depth} ${flow.name} item(s) are stuck and not reaching the destination.`;
      if (!remediation.length) {
        remediation.push(
          `Fix the failure at ${top?.failedAt}, then replay ${dlqName} back onto ${qn}.`,
        );
      }
    }
  }

  // Add a sample trace as concrete proof.
  const tx = latestTransactionForFlow(flow.id);
  if (tx) {
    correlationIds.add(tx.correlationId);
    const failedHop = tx.hops.find((hp) => hp.status === "error");
    evidence.push(
      `Sample trace ${tx.correlationId} (${tx.status}) stops at '${failedHop?.ref ?? "unknown"}': ${failedHop?.detail ?? ""}`.trim(),
    );
    suggestedTools.add(`trace_transaction(query="${tx.correlationId}")`);
  }

  const correlationIdList = [...correlationIds];
  const sampleCorrelationId = tx?.correlationId ?? correlationIdList[0] ?? null;

  const brokenLayer =
    broken.step.kind === "api" ? (findApi(broken.step.ref)?.layer ?? "api") : "queue";

  const summary = [
    `Yes — '${flow.name}' (${flow.direction}) is broken.`,
    `The flow breaks at **${broken.step.ref}** (${broken.step.action}).`,
    rootCause ? `Root cause: ${rootCause}` : "",
    impact ? `Impact: ${impact}` : "",
    remediation.length ? `Fix: ${remediation[0]}` : "",
    sampleCorrelationId
      ? `Example affected transaction: ${sampleCorrelationId} (trace it with trace_transaction).`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    question,
    matchedFlow: { id: flow.id, name: flow.name, direction: flow.direction },
    verdict: `'${flow.name}' is failing at ${broken.step.ref}.`,
    brokenHop: { ref: broken.step.ref, layer: brokenLayer, action: broken.step.action },
    rootCause,
    correlationIds: correlationIdList,
    sampleCorrelationId,
    evidence,
    impact,
    remediation,
    suggestedTools: [...suggestedTools],
    summary,
  };
}
