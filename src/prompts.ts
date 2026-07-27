import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The single source of prompt/instruction text is playbook/PLAYBOOK.md — the
// model-agnostic expertise layer (see playbook/README.md). It is loaded at
// startup and used both as the MCP `instructions` sent to clients on connect
// and as the Slack bot's system prompt. Override the location with
// PLAYBOOK_FILE — e.g. a bind mount on the server lets you tune the playbook
// and just restart the container, no rebuild.
const here = dirname(fileURLToPath(import.meta.url)); // dist/ (or src/ under tsx)
const PLAYBOOK_FILE =
  process.env.PLAYBOOK_FILE || resolve(here, "../playbook/PLAYBOOK.md");

export function loadPlaybook(): string {
  try {
    return readFileSync(PLAYBOOK_FILE, "utf8").trim();
  } catch (err) {
    console.error(
      `[tondemon] cannot read playbook ${PLAYBOOK_FILE} — set PLAYBOOK_FILE or restore playbook/PLAYBOOK.md. (${(err as Error).message})`,
    );
    process.exit(1);
  }
}
