import { resolveCliDataDir } from "./config";
import { readHubStatus } from "../hub/status";
import { resolveCliKey } from "./key";
import { readPluginHubOptions } from "./plugin-options";

import { parseCliArgs } from "./args";

const args = parseCliArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    [
      "Usage: bun run token [--data-dir <dir>] [--key <management-key>]",
      "",
      "Prints the key the running hub uses. Resolution order:",
      "  --key, plugin options, the hub's hub.json token file, environment,",
      "  then <data-dir>/token (creating one only when no hub is running).",
      "  --data-dir, plugin options, MAGPIE_T3CODE_HUB_HOME, then the default.",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  const plugin = readPluginHubOptions();
  const dataDir = resolveCliDataDir(args.dataDir, plugin);
  const status = readHubStatus(dataDir);
  const result = await resolveCliKey({
    cliKey: args.key,
    plugin,
    env: process.env,
    status,
    dataDir,
    allowCreate: true,
  });

  if (!result.key) {
    console.error(`[t3code-hub] ${result.blocked ?? "No management key found."}`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${result.key}\n`);
    if (result.source === "created") {
      console.error(
        `[t3code-hub] management key created${result.path ? ` at ${result.path}` : ""}`,
      );
    } else {
      console.error(`[t3code-hub] management key from ${result.source}`);
    }
  }
} catch (error) {
  console.error(`[t3code-hub] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
