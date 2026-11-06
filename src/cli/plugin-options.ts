import { readFileSync } from "node:fs";
import { join } from "node:path";
import { xdgConfigDir } from "../hub/auth";
import { optionString, strictOptionNumber } from "../hub/options";

export interface PluginHubOptions {
  managementKey?: string;
  token?: string;
  dataDir?: string;
  host?: string;
  port?: number;
}

/**
 * The raw `options` object of this plugin's entry in Magpie's plugins.json,
 * or undefined when the file or the entry is missing/unreadable. The hooks
 * entry starts the hub from these, since hooks modules get no load options.
 */
export function readPluginRawOptions(
  file = join(xdgConfigDir(), "magpie", "plugins.json"),
): Record<string, unknown> | undefined {
  let parsed: { plugins?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
  } catch {
    return undefined;
  }

  const entries = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const candidates = entries.filter(
    (entry): entry is { spec?: unknown; options?: unknown } =>
      typeof entry === "object" && entry !== null,
  );
  const matchesName = (entry: { spec?: unknown }) =>
    typeof entry.spec === "string" && entry.spec.includes("magpie-t3code-hub");
  const entry =
    candidates.find(
      (candidate) =>
        matchesName(candidate) &&
        typeof candidate.options === "object" &&
        candidate.options !== null,
    ) ?? candidates.find(matchesName);
  const options = entry?.options;
  if (!options || typeof options !== "object") return undefined;

  return options as Record<string, unknown>;
}

/**
 * Best-effort read of the options Magpie passes to this plugin. Magpie keeps
 * them in its plugins.json; a user may have set `managementKey` or `dataDir`
 * there instead of the environment, and the CLIs must use the same values.
 *
 * A missing/unreadable file is not an error (the plugin may be configured
 * elsewhere), but a present invalid port is: the plugin host will reject it,
 * and the CLIs must report the same configuration error.
 */
export function readPluginHubOptions(
  file = join(xdgConfigDir(), "magpie", "plugins.json"),
): PluginHubOptions | undefined {
  const raw = readPluginRawOptions(file);
  if (!raw) return undefined;
  return {
    managementKey: optionString(raw.managementKey),
    token: optionString(raw.token),
    dataDir: optionString(raw.dataDir),
    host: optionString(raw.host),
    port: strictOptionNumber(raw.port, "port"),
  };
}
