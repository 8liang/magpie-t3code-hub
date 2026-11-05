import { readSavedToken, readTokenFileDetailed, resolveToken } from "../hub/auth";
import type { HubStatusFile } from "../hub/status";
import type { PluginHubOptions } from "./plugin-options";

export type CliKeySource = "cli" | "plugin" | "hub" | "env" | "file" | "created";

export interface CliKeyResult {
  key?: string;
  source?: CliKeySource;
  created?: boolean;
  path?: string;
  blocked?: string;
}

/**
 * One key-precedence chain for `token` and `verify`, matching how the server
 * resolves its key and preferring the running hub's actual token file over a
 * shell environment that may belong to a different process.
 */
export async function resolveCliKey(input: {
  cliKey?: string;
  plugin?: PluginHubOptions;
  env?: Record<string, string | undefined>;
  status?: HubStatusFile;
  dataDir: string;
  allowCreate: boolean;
}): Promise<CliKeyResult> {
  const env = input.env ?? process.env;
  const envKey = env.MAGPIE_T3CODE_HUB_TOKEN?.trim();
  const cliKey = input.cliKey?.trim();
  if (cliKey) return { key: cliKey, source: "cli" };

  // The plugin option is the server's highest-precedence key. After that, the
  // running hub's actual token file beats this shell's environment, which the
  // hub may never have seen.
  const pluginKey = input.plugin?.managementKey || input.plugin?.token;
  if (pluginKey) return { key: pluginKey, source: "plugin" };

  if (input.status?.tokenPath) {
    const file = readTokenFileDetailed(input.status.tokenPath);
    if (file.token) return { key: file.token, source: "hub" };
    // The hub's file key is gone; documented precedence still allows an
    // explicit environment key (for example a remote hub selected with --url).
    if (envKey) return { key: envKey, source: "env" };
    const reason = file.code === "EACCES" ? "not readable (EACCES)" : "missing or empty";
    return {
      blocked:
        `The running hub's token file ${input.status.tokenPath} is ${reason}, ` +
        "so its key cannot be read. Restart the hub (it will create a new token) or pass --key.",
    };
  }

  // hub.json with tokenPath:null means the hub used its own option/env. Do not
  // fabricate a new file token in that case.
  if (input.status && input.status.tokenPath === null) {
    if (envKey) return { key: envKey, source: "env" };
    return {
      blocked:
        "The running hub uses a key from its own environment (hub.json has tokenPath:null). " +
        "Set MAGPIE_T3CODE_HUB_TOKEN in this shell or pass --key.",
    };
  }

  if (envKey) return { key: envKey, source: "env" };

  const saved = readSavedToken(input.dataDir);
  if (saved) return { key: saved, source: "file" };

  if (!input.allowCreate) {
    return {
      blocked:
        "No management key found. Pass --key/--data-dir, set MAGPIE_T3CODE_HUB_TOKEN, " +
        "configure the plugin's managementKey, or start the hub once so it creates a token file.",
    };
  }

  const token = await resolveToken({ dataDir: input.dataDir, env });
  return {
    key: token.token,
    source: token.created ? "created" : "file",
    created: token.created,
    ...(token.path ? { path: token.path } : {}),
  };
}
