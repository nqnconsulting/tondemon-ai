import type { Api, Flow } from "../types.js";

// The API-led estate. Mirrors the sanitized NQN/NQN portfolio shape:
// channels → experience → process → system → backends, plus Anypoint MQ.

export const APIS: Api[] = [
  // ---- Channels / backends (not Mule deployables, but tracing endpoints) ----
  {
    id: "sap-erp",
    name: "SAP ERP",
    layer: "backend",
    description: "Source of truth for orders, billing documents and master data.",
    owner: "SAP CoE",
  },
  {
    id: "storefront",
    name: "E-commerce storefront",
    layer: "channel",
    description: "Public web shop where customer orders originate.",
    owner: "Digital team",
  },
  {
    id: "salesforce-crm",
    name: "Salesforce CRM",
    layer: "backend",
    description: "Customer 360 — Accounts, Orders, Cases. Where managers expect orders to appear.",
    owner: "CRM team",
  },
  {
    id: "sap-wms",
    name: "SAP WMS",
    layer: "backend",
    description: "Warehouse management backend (JCo RFC).",
    owner: "SAP CoE",
  },

  // ---- Experience APIs ----
  {
    id: "commerce-order-api",
    name: "commerce-order-api",
    layer: "experience",
    description: "Accepts orders from the storefront and SAP, normalises them and publishes order events.",
    owner: "Integration team",
    calls: ["queue:order-events"],
  },
  {
    id: "sf-service-api",
    name: "sf-service-api",
    layer: "experience",
    description: "Salesforce-facing service API for inventory adjustments and service requests.",
    owner: "Integration team",
    calls: ["inventory-adjustment"],
  },

  // ---- Process APIs ----
  {
    id: "amq-papi",
    name: "amq-papi",
    layer: "process",
    description: "Central event orchestrator. Consumes Anypoint MQ queues and routes events to the right System API, with retry + dead-letter handling.",
    owner: "Integration team",
    calls: ["salesforce-sapi", "sap-erp-api", "queue:order-events-dlq"],
  },
  {
    id: "inventory-adjustment",
    name: "inventory-adjustment",
    layer: "process",
    description: "Inventory-adjustment lifecycle (submit, validate, retrieve) orchestration.",
    owner: "Integration team",
    calls: ["sap-wms-sapi"],
  },

  // ---- System APIs ----
  {
    id: "salesforce-sapi",
    name: "salesforce-sapi",
    layer: "system",
    description: "Salesforce abstraction — upserts Accounts/Orders via REST, holds the OAuth connected-app credentials.",
    owner: "Integration team",
    calls: ["salesforce-crm"],
  },
  {
    id: "sap-erp-api",
    name: "sap-erp-api",
    layer: "system",
    description: "SAP ERP abstraction — inbound IDoc / business-partner + order reads.",
    owner: "Integration team",
    calls: ["sap-erp"],
  },
  {
    id: "sap-wms-sapi",
    name: "sap-wms-sapi",
    layer: "system",
    description: "SAP WMS abstraction over JCo RFC (inventory adjustments, contracts).",
    owner: "Integration team",
    calls: ["sap-wms"],
  },
];

export const FLOWS: Flow[] = [
  {
    id: "order-to-salesforce",
    name: "Order → Salesforce",
    entities: [
      "order",
      "orders",
      "salesforce",
      "sales force",
      "crm",
      "sf",
      "sale",
      "purchase",
      "checkout",
    ],
    direction: "SAP ERP / storefront → Salesforce CRM",
    steps: [
      { ref: "storefront", kind: "backend", action: "Customer places order (or SAP emits order)" },
      { ref: "commerce-order-api", kind: "api", action: "Normalise order, publish event" },
      { ref: "queue:order-events", kind: "queue", action: "Order event queued (Anypoint MQ)" },
      { ref: "amq-papi", kind: "api", action: "Consume event, route to Salesforce" },
      { ref: "salesforce-sapi", kind: "api", action: "Upsert Order into Salesforce (OAuth + REST)" },
      { ref: "salesforce-crm", kind: "backend", action: "Order visible in Salesforce CRM" },
    ],
  },
  {
    id: "inventory-adjustment-capture",
    name: "Inventory adjustment → SAP WMS",
    entities: ["inventory", "adjustment", "adjustments", "stock", "bin", "wms"],
    direction: "Salesforce / portal → SAP WMS",
    steps: [
      { ref: "salesforce-crm", kind: "backend", action: "Agent submits reading" },
      { ref: "sf-service-api", kind: "api", action: "Receive reading" },
      { ref: "inventory-adjustment", kind: "api", action: "Validate + orchestrate" },
      { ref: "sap-wms-sapi", kind: "api", action: "Write reading via RFC" },
      { ref: "sap-wms", kind: "backend", action: "Reading stored in WMS" },
    ],
  },
];

export function findApi(id: string): Api | undefined {
  return APIS.find((a) => a.id === id);
}

/** Resolve a flow from a free-text manager question by entity-keyword scoring. */
export function matchFlow(question: string): { flow: Flow; score: number } | undefined {
  const q = question.toLowerCase();
  let best: { flow: Flow; score: number } | undefined;
  for (const flow of FLOWS) {
    const score = flow.entities.reduce((n, kw) => (q.includes(kw) ? n + 1 : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { flow, score };
  }
  return best;
}
