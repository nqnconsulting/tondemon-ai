// LAYER 1 — deterministic tool evals (NO LLM, fully model-agnostic).
//
// Drives the integration-monitor MCP server (demo mode) through a real MCP
// client and asserts the tool outputs against dataset/cases.jsonl. This certifies
// the *server* — your expertise-as-code — and runs in CI with no API key.
//
// Run:  node evals/tool-evals.mjs       (from the project root, after `npm run build`)
// Exits non-zero if any case fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const cases = readFileSync(join(here, "dataset", "cases.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function checkExpect(result, e) {
  const actual = getPath(result, e.path);
  if ("equals" in e) return { ok: actual === e.equals, why: `${e.path} == ${JSON.stringify(e.equals)} (got ${JSON.stringify(actual)})` };
  if ("contains" in e) {
    const ok = Array.isArray(actual)
      ? actual.includes(e.contains)
      : typeof actual === "string" && actual.toLowerCase().includes(String(e.contains).toLowerCase());
    return { ok, why: `${e.path} contains "${e.contains}" (got ${JSON.stringify(actual)?.slice(0, 80)})` };
  }
  if ("gte" in e) return { ok: typeof actual === "number" && actual >= e.gte, why: `${e.path} >= ${e.gte} (got ${actual})` };
  if ("lte" in e) return { ok: typeof actual === "number" && actual <= e.lte, why: `${e.path} <= ${e.lte} (got ${actual})` };
  if ("exists" in e) return { ok: (actual !== undefined && actual !== null) === e.exists, why: `${e.path} exists==${e.exists} (got ${JSON.stringify(actual)})` };
  return { ok: false, why: `unknown assertion ${JSON.stringify(e)}` };
}

const transport = new StdioClientTransport({ command: "node", args: [join(root, "dist", "index.js")] });
const client = new Client({ name: "tool-evals", version: "1.0.0" });
await client.connect(transport);

let passed = 0;
const failures = [];

for (const c of cases) {
  const res = await client.callTool({ name: c.tool, arguments: c.args });
  let result;
  try {
    result = JSON.parse(res.content[0].text);
  } catch {
    failures.push({ id: c.id, why: "tool output was not JSON" });
    console.log(`✗ ${c.id} — tool output not JSON`);
    continue;
  }
  const checks = (c.expect ?? []).map((e) => checkExpect(result, e));
  const failed = checks.filter((c2) => !c2.ok);
  if (failed.length === 0) {
    passed++;
    console.log(`✓ ${c.id}`);
  } else {
    failures.push({ id: c.id, fails: failed.map((f) => f.why) });
    console.log(`✗ ${c.id}\n    ${failed.map((f) => f.why).join("\n    ")}`);
  }
}

await client.close();

console.log(`\n${passed}/${cases.length} cases passed`);
if (failures.length) {
  console.log(`FAILED: ${failures.map((f) => f.id).join(", ")}`);
  process.exit(1);
}
process.exit(0);
