import { parseCliArgs } from "./args";
import { defaultHubUrl, pluginHubUrl, resolveCliDataDir } from "./config";
import { readHubStatus } from "../hub/status";
import { resolveCliKey } from "./key";
import { readPluginHubOptions } from "./plugin-options";
import type {
  ClaudeUsage,
  CliproxyApiCallResponse,
  CliproxyAuthFile,
  CodexUsage,
} from "../hub/types";

function printHelp(): void {
  console.log(
    [
      `Usage: bun run verify [--url ${defaultHubUrl()}] [--key <management-key>] [--data-dir <dir>] [--json]`,
      "",
      "Replays the exact requests T3 Code's CLIProxyAPI usage source makes:",
      "  GET  v0/management/auth-files",
      "  POST v0/management/api-call  (Anthropic / ChatGPT usage URLs)",
      "",
      "Key precedence: --key, plugin options, the hub's hub.json token file,",
      "MAGPIE_T3CODE_HUB_TOKEN, then <data-dir>/token.",
      "--data-dir is relative to the current directory; plugin/env dataDir is relative to home.",
    ].join("\n"),
  );
}

function baseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function management<T>(base: string, key: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function apiCall(
  base: string,
  key: string,
  authIndex: string,
  url: string,
): Promise<CliproxyApiCallResponse> {
  return management<CliproxyApiCallResponse>(base, key, "v0/management/api-call", {
    auth_index: authIndex,
    method: "GET",
    url,
    header: { authorization: "Bearer $TOKEN$" },
  });
}

function decode<T>(reply: CliproxyApiCallResponse): T {
  if (reply.status_code < 200 || reply.status_code >= 300) {
    throw new Error(`upstream HTTP ${reply.status_code}: ${reply.body}`);
  }
  return JSON.parse(reply.body) as T;
}

interface CreditReply {
  credits: Array<{ id: string; status: string; reset_type: string; expires_at: string }>;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function reset(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return ` · resets ${new Date(value * 1000).toISOString()}`;
  return ` · resets ${value}`;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const plugin = readPluginHubOptions();
  const dataDir = resolveCliDataDir(args.dataDir, plugin);
  const status = readHubStatus(dataDir);
  const url = args.url ?? status?.url ?? pluginHubUrl(plugin) ?? defaultHubUrl();
  const resolved = await resolveCliKey({
    cliKey: args.key,
    plugin,
    env: process.env,
    status,
    dataDir,
    allowCreate: false,
  });
  if (!resolved.key) {
    console.error(resolved.blocked ?? "No management key found.");
    process.exitCode = 1;
    return;
  }
  const key = resolved.key;
  // With --json, stdout carries only the JSON report; progress goes to stderr.
  const log = args.json ? console.error : console.log;
  const base = baseUrl(url);

  const auth = await management<{ files: CliproxyAuthFile[] }>(
    base,
    key,
    "v0/management/auth-files",
  );
  const files = (auth.files ?? []).filter(
    (file) => file && !file.disabled && (file.provider === "claude" || file.provider === "codex"),
  );

  const report: unknown[] = [];
  let failures = 0;

  log(`hub: ${base}`);
  log(`accounts: ${auth.files?.length ?? 0} total, ${files.length} usable by T3 Code`);
  log("");

  for (const file of files) {
    const label = file.email ?? file.id;
    log(`${label}  [${file.provider}]`);
    try {
      if (file.provider === "claude") {
        const usage = decode<ClaudeUsage>(
          await apiCall(base, key, file.auth_index, "https://api.anthropic.com/api/oauth/usage"),
        );
        if (usage.five_hour) {
          log(
            `  Session ${percent(usage.five_hour.utilization)}${reset(usage.five_hour.resets_at)}`,
          );
        }
        if (usage.seven_day) {
          log(
            `  Weekly  ${percent(usage.seven_day.utilization)}${reset(usage.seven_day.resets_at)}`,
          );
        }
        for (const limit of usage.limits ?? []) {
          const name = limit.scope?.model?.display_name ?? limit.kind;
          log(`  ${name}: ${percent(limit.percent ?? 0)}${reset(limit.resets_at)}`);
        }
        report.push({ file, usage });
      } else {
        const usage = decode<CodexUsage>(
          await apiCall(base, key, file.auth_index, "https://chatgpt.com/backend-api/wham/usage"),
        );
        const primary = usage.rate_limit?.primary_window;
        const secondary = usage.rate_limit?.secondary_window;
        if (primary) {
          log(`  Session ${percent(primary.used_percent)}${reset(primary.reset_at)}`);
        }
        if (secondary) {
          log(`  Weekly  ${percent(secondary.used_percent)}${reset(secondary.reset_at)}`);
        }
        const credits = decode<CreditReply>(
          await apiCall(
            base,
            key,
            file.auth_index,
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
          ),
        );
        log(`  reset credits: ${credits.credits?.length ?? 0}`);
        report.push({ file, usage, credits });
      }
    } catch (error) {
      failures += 1;
      log(`  ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
    log("");
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (files.length === 0) {
    failures += 1;
    console.error("No usable accounts. Check Magpie's quota API and the hub's health endpoint.");
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

try {
  await main();
} catch (error) {
  console.error(
    `verify failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
