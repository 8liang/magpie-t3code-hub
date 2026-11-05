import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAGPIE_QUOTA_URL } from "../src/hub/constants";
import { startHub } from "../src/hub/server";
import { fixture, NOW } from "./fixtures";

const silent = { info() {}, warn() {}, error() {} };

test("verify reports a hub error without an unhandled stack", async () => {
  // A port that was just free: connection refused is immediate and local.
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port!;
  await probe.stop(true);

  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/cli/verify.ts",
      "--url",
      `http://127.0.0.1:${port}`,
      "--key",
      "test-key",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(code).toBe(1);
  expect(stderr).toContain("verify failed:");
  expect(stderr).not.toContain("at async main");
});

test("standalone reports a configuration error without a stack", async () => {
  const proc = Bun.spawn([process.execPath, "run", "src/standalone.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MAGPIE_T3CODE_HUB_PORT: "-1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(code).toBe(1);
  expect(stderr).toContain("[t3code-hub] Invalid port -1");
  expect(stderr).not.toContain("at resolvePort");
});

test("token reports a token-file error without a stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-token-error-"));
  try {
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const proc = Bun.spawn([process.execPath, "run", "src/cli/token.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(dir, "xdg"),
        MAGPIE_T3CODE_HUB_HOME: join(blocker, "sub"),
        MAGPIE_T3CODE_HUB_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toContain("[t3code-hub] Cannot create the management key");
    expect(stderr).not.toContain("at tokenError");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify --json writes only the JSON report to stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-verify-json-"));
  const hub = await startHub({
    port: 0,
    managementKey: "verify-key",
    dataDir: dir,
    fetchQuotas: async () => fixture,
    logger: silent,
    now: () => NOW,
  });
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli/verify.ts",
        "--url",
        hub.url,
        "--key",
        "verify-key",
        "--data-dir",
        dir,
        "--json",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    // The fixture's cursor account has an error, so verify exits 1.
    expect(code).toBe(1);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
    expect(stderr).toContain("Cursor · cursor@example.com");
  } finally {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("borrows a hub that misses the first health probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-slow-probe-"));
  let healthCalls = 0;
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        healthCalls += 1;
        if (healthCalls === 1) await Bun.sleep(1_000);
        return Response.json({ ok: true, service: "magpie-t3code-hub", version: "test" });
      }
      if (path === "/v0/management/hub-info") {
        if (request.headers.get("authorization") !== "Bearer retry-key") {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({
          service: "magpie-t3code-hub",
          version: "test",
          magpieQuotaUrl: DEFAULT_MAGPIE_QUOTA_URL,
          dataDir: dir,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const borrowed = await startHub({
      port: fake.port!,
      managementKey: "retry-key",
      dataDir: dir,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => NOW,
    });
    expect(borrowed.server).toBeNull();
    expect(healthCalls).toBeGreaterThanOrEqual(2);
    await borrowed.stop();
  } finally {
    await fake.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token uses the running plugin's managementKey option", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-token-cli-"));
  try {
    mkdirSync(join(dir, "magpie"), { recursive: true });
    writeFileSync(
      join(dir, "magpie", "plugins.json"),
      JSON.stringify({
        plugins: [
          {
            spec: "/opt/magpie-t3code-hub",
            options: {
              managementKey: "plugin-key",
              dataDir: join(dir, "data"),
            },
          },
        ],
      }),
    );

    const proc = Bun.spawn([process.execPath, "run", "src/cli/token.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, XDG_CONFIG_HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("plugin-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
