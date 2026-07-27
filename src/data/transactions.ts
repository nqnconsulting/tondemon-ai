import type { Transaction } from "../types.js";

// Representative end-to-end traces. ORD-10042 is the canonical "stuck" order an
// agent will pull when asked about orders + Salesforce. ORD-09980 (before the
// incident) and the inventory-adjustment trace prove the tooling shows healthy paths
// too — so a failure genuinely stands out.

export const TRANSACTIONS: Transaction[] = [
  {
    correlationId: "ORD-10042",
    businessKey: "10042",
    flowId: "order-to-salesforce",
    status: "dead-lettered",
    startedMinutesAgo: 4,
    hops: [
      { ref: "storefront", kind: "backend", action: "Order placed", status: "ok", atMinutesAgo: 4 },
      {
        ref: "commerce-order-api",
        kind: "api",
        action: "Normalise + publish ORDER_CREATED",
        status: "ok",
        atMinutesAgo: 4,
        latencyMs: 165,
      },
      {
        ref: "queue:order-events",
        kind: "queue",
        action: "Event enqueued",
        status: "ok",
        atMinutesAgo: 4,
      },
      {
        ref: "amq-papi",
        kind: "api",
        action: "Consume + route to Salesforce (3 attempts)",
        status: "error",
        atMinutesAgo: 4,
        latencyMs: 9100,
        detail: "Downstream salesforce-sapi returned 401 on all 3 attempts; routed to order-events-dlq.",
      },
      {
        ref: "salesforce-sapi",
        kind: "api",
        action: "Obtain OAuth token + upsert Order",
        status: "error",
        atMinutesAgo: 4,
        latencyMs: 610,
        detail: "SALESFORCE:OAUTH_401 — POST /services/oauth2/token → 401 invalid_client. No access token, upsert never attempted.",
      },
      {
        ref: "salesforce-crm",
        kind: "backend",
        action: "Order created in Salesforce",
        status: "skipped",
        atMinutesAgo: 4,
        detail: "Never reached — upstream auth failed.",
      },
    ],
  },
  {
    correlationId: "ORD-09980",
    businessKey: "09980",
    flowId: "order-to-salesforce",
    status: "completed",
    startedMinutesAgo: 240,
    hops: [
      { ref: "storefront", kind: "backend", action: "Order placed", status: "ok", atMinutesAgo: 240 },
      {
        ref: "commerce-order-api",
        kind: "api",
        action: "Normalise + publish ORDER_CREATED",
        status: "ok",
        atMinutesAgo: 240,
        latencyMs: 172,
      },
      { ref: "queue:order-events", kind: "queue", action: "Event enqueued", status: "ok", atMinutesAgo: 240 },
      {
        ref: "amq-papi",
        kind: "api",
        action: "Consume + route to Salesforce",
        status: "ok",
        atMinutesAgo: 240,
        latencyMs: 540,
      },
      {
        ref: "salesforce-sapi",
        kind: "api",
        action: "Obtain OAuth token + upsert Order",
        status: "ok",
        atMinutesAgo: 240,
        latencyMs: 480,
      },
      {
        ref: "salesforce-crm",
        kind: "backend",
        action: "Order created in Salesforce",
        status: "ok",
        atMinutesAgo: 240,
        detail: "Salesforce Order 801xx000ABCxyz created.",
      },
    ],
  },
  {
    correlationId: "MR-55012",
    businessKey: "55012",
    flowId: "inventory-adjustment-capture",
    status: "completed",
    startedMinutesAgo: 12,
    hops: [
      { ref: "salesforce-crm", kind: "backend", action: "Agent submits reading", status: "ok", atMinutesAgo: 12 },
      { ref: "sf-service-api", kind: "api", action: "Receive reading", status: "ok", atMinutesAgo: 12, latencyMs: 150 },
      { ref: "inventory-adjustment", kind: "api", action: "Validate + orchestrate", status: "ok", atMinutesAgo: 12, latencyMs: 410 },
      { ref: "sap-wms-sapi", kind: "api", action: "Write reading via RFC", status: "ok", atMinutesAgo: 12, latencyMs: 860 },
      { ref: "sap-wms", kind: "backend", action: "Reading stored", status: "ok", atMinutesAgo: 12 },
    ],
  },
];

/** Look up a trace by correlation id or business key (order number), loosely. */
export function findTransaction(query: string): Transaction | undefined {
  const q = query.trim().toLowerCase();
  return (
    TRANSACTIONS.find((t) => t.correlationId.toLowerCase() === q) ??
    TRANSACTIONS.find((t) => t.businessKey.toLowerCase() === q) ??
    TRANSACTIONS.find((t) => t.correlationId.toLowerCase().includes(q) || q.includes(t.businessKey.toLowerCase()))
  );
}

export function latestTransactionForFlow(flowId: string): Transaction | undefined {
  return TRANSACTIONS.filter((t) => t.flowId === flowId).sort(
    (a, b) => a.startedMinutesAgo - b.startedMinutesAgo,
  )[0];
}
