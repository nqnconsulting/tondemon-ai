import type { LogLine } from "../types.js";

// A small, curated log stream. Skewed toward the incident so keyword/level
// filters surface the 401 story, with healthy INFO lines mixed in for realism.

export const LOGS: LogLine[] = [
  // --- salesforce-sapi: the root failure ---
  {
    apiId: "salesforce-sapi",
    level: "ERROR",
    minutesAgo: 4,
    correlationId: "ORD-10042",
    message: "SALESFORCE:OAUTH_401 obtaining access token: POST /services/oauth2/token → 401 {\"error\":\"invalid_client\",\"error_description\":\"client identifier or secret is invalid\"}",
  },
  {
    apiId: "salesforce-sapi",
    level: "ERROR",
    minutesAgo: 9,
    correlationId: "ORD-10041",
    message: "SALESFORCE:OAUTH_401 obtaining access token: 401 invalid_client. Order upsert aborted (no token).",
  },
  {
    apiId: "salesforce-sapi",
    level: "WARN",
    minutesAgo: 72,
    message: "OAuth token refresh started failing; previous cached token expired. First 401 invalid_client observed.",
  },
  {
    apiId: "salesforce-sapi",
    level: "INFO",
    minutesAgo: 80,
    message: "Token refreshed successfully; access token valid for 7200s.",
  },

  // --- amq-papi: the dead-lettering ---
  {
    apiId: "amq-papi",
    level: "ERROR",
    minutesAgo: 4,
    correlationId: "ORD-10042",
    message: "Routing ORDER_CREATED to salesforce-sapi failed (HTTP:UNAUTHORIZED) after 3 retries. Publishing to order-events-dlq.",
  },
  {
    apiId: "amq-papi",
    level: "WARN",
    minutesAgo: 5,
    correlationId: "ORD-10042",
    message: "Retry 2/3 for ORDER_CREATED → salesforce-sapi after 401; backing off 2000ms.",
  },
  {
    apiId: "amq-papi",
    level: "ERROR",
    minutesAgo: 26,
    correlationId: "ORD-10039",
    message: "Routing ORDER_CREATED to salesforce-sapi failed (HTTP:UNAUTHORIZED) after 3 retries. Publishing to order-events-dlq.",
  },
  {
    apiId: "amq-papi",
    level: "INFO",
    minutesAgo: 12,
    correlationId: "MR-55012",
    message: "Routed INVENTORY_ADJUSTMENT event to sap-wms-sapi: 200 OK.",
  },

  // --- commerce-order-api: still ingesting fine ---
  {
    apiId: "commerce-order-api",
    level: "INFO",
    minutesAgo: 4,
    correlationId: "ORD-10042",
    message: "ORDER_CREATED published to order-events for order 10042 (customer CUST-3391).",
  },
  {
    apiId: "commerce-order-api",
    level: "INFO",
    minutesAgo: 1,
    message: "Health check OK. 42 orders normalised in last minute.",
  },

  // --- healthy flow for contrast ---
  {
    apiId: "sap-wms-sapi",
    level: "INFO",
    minutesAgo: 12,
    correlationId: "MR-55012",
    message: "Inventory adjustment 55012 written to WMS via ZCS_MKD_IN_MR_UPLOAD.",
  },
  {
    apiId: "salesforce-sapi",
    level: "INFO",
    minutesAgo: 240,
    correlationId: "ORD-09980",
    message: "Upserted Salesforce Order 801xx000ABCxyz for order 09980 (200 OK).",
  },
];

export interface LogFilter {
  apiId?: string;
  level?: LogLine["level"];
  contains?: string;
  sinceMinutes?: number;
}

export function queryLogs(filter: LogFilter, limit = 50): LogLine[] {
  const contains = filter.contains?.toLowerCase();
  return LOGS.filter((l) => {
    if (filter.apiId && l.apiId !== filter.apiId) return false;
    if (filter.level && l.level !== filter.level) return false;
    if (filter.sinceMinutes !== undefined && l.minutesAgo > filter.sinceMinutes) return false;
    if (contains && !l.message.toLowerCase().includes(contains) && !(l.correlationId ?? "").toLowerCase().includes(contains))
      return false;
    return true;
  })
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
    .slice(0, limit);
}
