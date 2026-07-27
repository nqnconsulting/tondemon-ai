// Time helpers + the single "incident" the whole mock estate is built around.
//
// Everything is expressed as "minutes ago" so the demo always looks live
// relative to whenever it is run. Resolving to a real timestamp happens here,
// once, so all tool outputs agree on the clock.

export function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function humanMinutesAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

/**
 * THE STORY (used by health, queues, traces, logs and the diagnose engine):
 *
 * Orders created in SAP ERP / the storefront are published to the
 * `order-events` Anypoint MQ queue, fanned out by `amq-papi`, and upserted into
 * Salesforce by `salesforce-sapi`. ~73 minutes ago Salesforce started rejecting
 * the System API's OAuth token with HTTP 401 (a connected-app client secret was
 * rotated in Salesforce but not updated in the Mule secure property). Every
 * order now exhausts its retries and lands in `order-events-dlq`. To a manager
 * this looks like "orders stopped showing up in Salesforce".
 */
export const ORDER_INCIDENT_START_MIN = 73;
