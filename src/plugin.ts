import { optionString, strictOptionNumber } from "./hub/options";
import { ensureHub, type StartHubOptions } from "./hub/server";
import type { HubLogger } from "./hub/types";

interface PluginLogOptions {
  body: {
    service: string;
    level: string;
    message: string;
  };
}

interface MagpiePluginInput {
  directory?: string;
  client?: {
    app?: {
      log?: (options: PluginLogOptions) => unknown;
    };
  };
  magpie?: {
    options?: () => Record<string, unknown> | undefined;
  };
}

function pluginLogger(input: MagpiePluginInput): HubLogger {
  const send = (level: string, message: string) => {
    // Never use console.log here: the plugin host's stdout is JSON-RPC.
    const log = input.client?.app?.log;
    if (typeof log !== "function") {
      console.error(`[t3code-hub] ${level.toUpperCase()} ${message}`);
      return;
    }
    try {
      const result = log({ body: { service: "magpie-t3code-hub", level, message } });
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Logging must never take the hub down.
    }
  };
  return {
    info: (message) => send("info", message),
    warn: (message) => send("warn", message),
    error: (message) => send("error", message),
  };
}

function pluginOptions(input: MagpiePluginInput, passed?: Record<string, unknown>): StartHubOptions {
  const fromInput = input.magpie?.options?.();
  const raw: Record<string, unknown> = {
    ...(fromInput && typeof fromInput === "object" ? fromInput : {}),
    ...(passed && typeof passed === "object" ? passed : {}),
  };
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
    logger: pluginLogger(input),
  };
}

/**
 * Magpie loads every function an entry exports. The default `{ id, server }`
 * object makes the host call only `server`, so no helper is invoked as a
 * second plugin.
 */
export default {
  id: "magpie-t3code-hub",
  async server(input: MagpiePluginInput, options?: Record<string, unknown>) {
    await ensureHub(pluginOptions(input, options));
    // No OpenCode hooks: this plugin exists for its Bun HTTP listener.
    return {};
  },
};
