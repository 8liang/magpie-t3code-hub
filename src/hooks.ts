/**
 * Magpie entry: an async request-hooks module (`"magpie": { "hooks" }`).
 *
 * The package has no `main`/`exports`, so Magpie neither loads an OpenCode
 * provider entry nor shows a Provider chip (a package with `main` always gets
 * one). This module is the only Bun code the plugin host runs for it: the
 * host imports it once when it loads plugins, and the hub's Bun listener
 * starts at import time. A failure rejects the import, which Magpie reports
 * as the plugin's load error. `onRequest` never touches agent requests.
 *
 * `src/hub.middleware.js` (magpie.middleware) is a no-op that gives the
 * plugin its Middleware chip; see docs/decisions/0002.
 */
import { readPluginRawOptions } from "./cli/plugin-options";
import { optionString, strictOptionNumber } from "./hub/options";
import { ensureHub, type StartHubOptions } from "./hub/server";
import type { HubLogger } from "./hub/types";

// The plugin host's stdout is JSON-RPC: log to stderr only.
const logger: HubLogger = {
  info: (message) => console.error(`[t3code-hub] INFO ${message}`),
  warn: (message) => console.error(`[t3code-hub] WARN ${message}`),
  error: (message) => console.error(`[t3code-hub] ERROR ${message}`),
};

/**
 * Hooks modules get their options only per request (`ctx.options`), so the
 * listener reads the entry's options from plugins.json. Magpie reloads the
 * host when they change, which re-runs this.
 */
export function hubOptions(raw: Record<string, unknown> = {}): StartHubOptions {
  return {
    host: optionString(raw.host),
    port: strictOptionNumber(raw.port, "port"),
    magpieQuotaUrl: optionString(raw.magpieQuotaUrl) ?? optionString(raw.quotaUrl),
    magpieManagementKey: optionString(raw.magpieManagementKey) ?? optionString(raw.magpieKey),
    managementKey: optionString(raw.managementKey) ?? optionString(raw.token),
    dataDir: optionString(raw.dataDir),
    cacheTtlMs: strictOptionNumber(raw.cacheTtlMs, "cacheTtlMs"),
    fetchTimeoutMs: strictOptionNumber(raw.fetchTimeoutMs, "fetchTimeoutMs"),
    maxStaleMs: strictOptionNumber(raw.maxStaleMs, "maxStaleMs"),
    backoffMs: strictOptionNumber(raw.backoffMs, "backoffMs"),
    logger,
  };
}

await ensureHub(hubOptions(readPluginRawOptions()));

interface GatewayContext {
  report?: (code: string, bytes?: number) => void;
}

/** Required by Magpie for a hooks module; the hub leaves every request as it is. */
export async function onRequest(_body: unknown, ctx?: GatewayContext): Promise<undefined> {
  try {
    ctx?.report?.("skipped");
  } catch {
    // Diagnostics must never affect a request.
  }
  return undefined;
}
