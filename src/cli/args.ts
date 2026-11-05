export interface CliArgs {
  key?: string;
  dataDir?: string;
  url?: string;
  json?: boolean;
  help?: boolean;
}

/** Shared flags for the token and verify CLIs. Unknown flags are ignored. */
export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--url") out.url = argv[++index];
    else if (arg.startsWith("--url=")) out.url = arg.slice("--url=".length);
    else if (arg === "--key") out.key = argv[++index];
    else if (arg.startsWith("--key=")) out.key = arg.slice("--key=".length);
    else if (arg === "--data-dir") out.dataDir = argv[++index];
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
  }
  return out;
}
