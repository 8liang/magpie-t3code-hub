import { startHub } from "./hub/server";

async function main(): Promise<void> {
  const handle = await startHub({ keepAliveOnBorrow: true });

  console.error(`[t3code-hub] standalone mode · ${handle.url}`);
  if (handle.server === null) {
    console.error(
      `[t3code-hub] another hub already owns ${handle.url}; standing by to take over (Ctrl-C to stop)`,
    );
  }
  console.error(`[t3code-hub] health: ${handle.url}/healthz`);
  console.error(
    `[t3code-hub] management key: ${
      handle.config.tokenPath ? `stored at ${handle.config.tokenPath} (run \`bun run token\`)` : "from option/environment"
    }`,
  );

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.error(`[t3code-hub] ${signal}: stopping`);
    await handle.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[t3code-hub] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

try {
  await main();
} catch (error) {
  console.error(`[t3code-hub] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
