import type { ApiHealth, Incident } from "../types.js";
import { ORDER_INCIDENT_START_MIN } from "../scenario.js";

// Current per-API health. salesforce-sapi is DOWN (401 from Salesforce token
// endpoint); amq-papi is DEGRADED because its downstream calls are failing and
// it is busy retrying + dead-lettering. Everything else is healthy, so the
// contrast points an agent straight at the broken hop.

const ORDER_INCIDENT: Incident = {
  id: "INC-2041",
  startedMinutesAgo: ORDER_INCIDENT_START_MIN,
  summary:
    "salesforce-sapi cannot authenticate to Salesforce: the OAuth token endpoint returns HTTP 401 'invalid_client'. All Order upserts fail and are dead-lettered.",
  suspectedCause:
    "The Salesforce connected-app client secret was rotated on the Salesforce side but the matching Mule secure property (salesforce.client.secret) was not updated, so token requests are rejected.",
  remediation: [
    "Confirm the connected-app consumer secret in Salesforce Setup → App Manager.",
    "Update salesforce.client.secret in the salesforce-sapi secure properties and redeploy (or update the CloudHub/Runtime Manager property).",
    "Once healthy, replay order-events-dlq back onto order-events so parked orders flow into Salesforce.",
  ],
};

export const HEALTH: Record<string, ApiHealth> = {
  "commerce-order-api": {
    apiId: "commerce-order-api",
    status: "healthy",
    throughputRpm: 42,
    successRatePct: 99.9,
    errorRatePct: 0.1,
    p95LatencyMs: 180,
    errorBreakdown: [],
  },
  "amq-papi": {
    apiId: "amq-papi",
    status: "degraded",
    throughputRpm: 41,
    successRatePct: 12.4,
    errorRatePct: 87.6,
    p95LatencyMs: 9400, // inflated by retry/back-off before dead-lettering
    errorBreakdown: [
      {
        code: "HTTP:UNAUTHORIZED",
        message: "401 from salesforce-sapi while routing ORDER_CREATED event; exhausted 3 retries → DLQ",
        count: 47,
      },
    ],
    incident: ORDER_INCIDENT,
  },
  "salesforce-sapi": {
    apiId: "salesforce-sapi",
    status: "down",
    throughputRpm: 44,
    successRatePct: 0,
    errorRatePct: 100,
    p95LatencyMs: 620,
    errorBreakdown: [
      {
        code: "SALESFORCE:OAUTH_401",
        message: "POST /services/oauth2/token → 401 invalid_client (cannot obtain access token)",
        count: 132,
      },
    ],
    incident: ORDER_INCIDENT,
  },
  "sap-erp-api": {
    apiId: "sap-erp-api",
    status: "healthy",
    throughputRpm: 18,
    successRatePct: 99.6,
    errorRatePct: 0.4,
    p95LatencyMs: 540,
    errorBreakdown: [],
  },
  "sf-service-api": {
    apiId: "sf-service-api",
    status: "healthy",
    throughputRpm: 23,
    successRatePct: 99.8,
    errorRatePct: 0.2,
    p95LatencyMs: 210,
    errorBreakdown: [],
  },
  "inventory-adjustment": {
    apiId: "inventory-adjustment",
    status: "healthy",
    throughputRpm: 22,
    successRatePct: 99.5,
    errorRatePct: 0.5,
    p95LatencyMs: 430,
    errorBreakdown: [],
  },
  "sap-wms-sapi": {
    apiId: "sap-wms-sapi",
    status: "healthy",
    throughputRpm: 21,
    successRatePct: 99.3,
    errorRatePct: 0.7,
    p95LatencyMs: 880,
    errorBreakdown: [],
  },
};

export function getHealth(apiId: string): ApiHealth | undefined {
  return HEALTH[apiId];
}
