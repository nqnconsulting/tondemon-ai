import type { Source } from "./types.js";
import { MockSource } from "./mock.js";
import { MuleLogSource } from "./muleLogs.js";
import { AnypointSource } from "./anypoint.js";

export type { Source } from "./types.js";

// Choose what backs the tools, in priority order:
//   1. Live Anypoint Platform — when ANYPOINT_CLIENT_ID + ANYPOINT_CLIENT_SECRET
//      (+ ANYPOINT_BG_ID) are set (e.g. `source .env.deploy`).
//   2. Live Mule logs — when MULE_LOG_DIR / `--logs <dir>` is set.
//   3. Bundled demo estate — otherwise (always self-demonstrating).
export function getActiveSource(): Source {
  const clientId = process.env.ANYPOINT_CLIENT_ID;
  const clientSecret = process.env.ANYPOINT_CLIENT_SECRET;
  const orgId = process.env.ANYPOINT_BG_ID;
  if (clientId && clientSecret && orgId) {
    return new AnypointSource({
      clientId,
      clientSecret,
      orgId,
      envName: process.env.CH2_ENV,
      envId: process.env.ANYPOINT_ENV_ID,
      host: process.env.ANYPOINT_HOST,
    });
  }

  const argIdx = process.argv.indexOf("--logs");
  const fromArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const dir = fromArg ?? process.env.MULE_LOG_DIR;
  if (dir && dir.trim()) {
    try {
      return new MuleLogSource(dir.trim());
    } catch (err) {
      console.error(`[integration-monitor] could not load logs from '${dir}': ${(err as Error).message}. Falling back to demo estate.`);
    }
  }
  return new MockSource();
}
