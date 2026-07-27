# Sample manager conversations

These are real outputs from this server (via `scripts/smoke-test.mjs`), shown as a manager would
experience them through an agent. The agent's job is just to call the tools and narrate.

Examples 1–4 use the bundled **demo** estate. Example 5 shows the **live-logs** mode against a
real (unnamed) Mule estate.

---

## 1. "Why are orders not coming to Salesforce?"

**Agent calls** `diagnose(question="why are orders not coming to salesforce?")` and replies:

> **Yes — orders are not reaching Salesforce, and I found why.**
>
> The *Order → Salesforce* flow (SAP/storefront → Salesforce CRM) breaks at the **`salesforce-sapi`**
> System API. It's been **down for ~1h 13m** (incident **INC-2041**), failing **100%** of calls.
>
> **Root cause:** the Salesforce connected-app **client secret was rotated** in Salesforce but the
> matching Mule secure property (`salesforce.client.secret`) wasn't updated — so the OAuth token
> endpoint returns **401 `invalid_client`** and no order can be upserted.
>
> **Impact:** **47 orders** are parked in `order-events-dlq` and not in Salesforce.
>
> **Fix:** update the connected-app secret in `salesforce-sapi`, redeploy, then replay
> `order-events-dlq` back onto `order-events`.
>
> *Want me to show a stuck order or the dead-letter queue?*

**If the manager says "show me one":** `trace_transaction(query="10042")` →

> Order **10042** (€219.90, CUST-3391): storefront ✅ → commerce-order-api ✅ → order-events ✅ →
> amq-papi ❌ (3 retries, all 401) → **salesforce-sapi ❌ (401 invalid_client, no token)** →
> Salesforce ⏭ never reached. **Dead-lettered.**

---

## 2. "Is the platform healthy right now?"

**Agent calls** `get_estate_health()` →

> Overall: **DEGRADED.** One open incident (**INC-2041**). `salesforce-sapi` is **down** (100% errors,
> `SALESFORCE:OAUTH_401`); `amq-papi` is **degraded** (88% errors — it's relaying salesforce-sapi's
> failures and dead-lettering). Everything else (commerce-order-api, sap-erp-api, sf-service-api,
> inventory-adjustment, sap-wms-sapi) is **healthy**.

---

## 3. "Are inventory adjustments flowing to SAP?"

**Agent calls** `diagnose(question="are inventory adjustments flowing to SAP?")` →

> **Yes — the *Inventory adjustment → SAP WMS* flow is healthy end-to-end.** No active incident on this
> path. (Last reading MR-55012 reached WMS in ~2.5s.) The Salesforce problem is isolated to the
> orders flow.

This is the important contrast: the tool doesn't cry wolf — a healthy flow reads as healthy, so a
real failure stands out.

---

## 4. "Where exactly is it breaking and what do I tell the integration team?"

**Agent chains** `get_api_health(apiId="salesforce-sapi")` + `get_dlq_messages(queue="order-events-dlq")`
+ `search_logs(apiId="salesforce-sapi", level="ERROR")` →

> Tell the integration team: **`salesforce-sapi` → INC-2041**. Log line:
> `POST /services/oauth2/token → 401 {"error":"invalid_client","error_description":"client identifier
> or secret is invalid"}`. First seen ~72 min ago (a successful token refresh logged just before).
> All 47 DLQ messages share error `HTTP:UNAUTHORIZED`, `failedAt: salesforce-sapi`. This is a
> **credential/config issue in the System API**, not a Salesforce outage and not a code change.

---

## 5. Live mode — real Mule logs, any client

Start the server with `MULE_LOG_DIR=/path/to/mule/logs`. The estate is discovered from the logs;
no app names are hardcoded. Manager asks *"why are employee records failing to reach the ERP?"* →

**Agent calls** `diagnose(...)` →

> The logs point at the **ERP SOAP system API**. It's failing with **`HTTP:INTERNAL_SERVER_ERROR`**
> (80×, ~9% of its traffic) — the downstream ERP returns **HTTP 500** on the employee-replication
> SOAP request (failing component *"… SOAP Request"* at `connectors.xml:20`). That's a fault in the
> target system or the request it received, not a Mule outage. **Trace one:** correlation id
> `4aed5a80-…-11f1-…`.

**Then** `trace_transaction(query="4aed5a80-…")` returns the hops for that Mule `event:` id:

> `http-post-employee` ✅ → `…-soap-request` ✅ → `…-soap-request` ❌ **HTTP:INTERNAL_SERVER_ERROR**:
> *"HTTP POST on resource '…/sap/bc/srt/…' failed: internal server error (500)."*

No naming convention was configured — the app, flow, correlation id, error type and failing
component all came straight out of the standard Mule log format.
