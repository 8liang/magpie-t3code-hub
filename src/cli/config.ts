import { resolveDataDir } from "../hub/auth";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT } from "../hub/constants";
import { clientUrl } from "../hub/status";
import type { PluginHubOptions } from "./plugin-options";

/**
 * `--data-dir` is a CLI path and resolves against the cwd; a dataDir from
 * Magpie's plugin options or the environment resolves against home so every
 * process agrees regardless of where it was started.
 */
export function resolveCliDataDir(
  cliDataDir: string | undefined,
  plugin: PluginHubOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return cliDataDir
    ? resolveDataDir(env, cliDataDir, { relativeTo: "cwd" })
    : resolveDataDir(env, plugin?.dataDir);
}

/** The hub URL implied by plugin options, including a host-only config. */
export function pluginHubUrl(plugin: PluginHubOptions | undefined): string | undefined {
  if (!plugin || (plugin.host === undefined && plugin.port === undefined)) return undefined;
  return clientUrl(plugin.host ?? DEFAULT_HUB_HOST, plugin.port ?? DEFAULT_HUB_PORT);
}

export function defaultHubUrl(): string {
  return clientUrl(DEFAULT_HUB_HOST, DEFAULT_HUB_PORT);
}
