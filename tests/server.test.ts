import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHub, startHub, stopActiveHub, validateHubOptions, type HubHandle } from "../src/hub/server";
import type { ClaudeUsage, CliproxyApiCallResponse, CliproxyAuthFilesResponse, CodexUsage } from "../src/hub/types";
import { fixture, NOW } from "./fixtures";

const KEY = "test-management-key";
const silent = { info() {}, warn() {}, error() {} };

let handle: HubHandle;
let base: string;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-test-"));
  handle = await startHub({
    port: 0,
    managementKey: KEY,
    dataDir,
    fetchQuotas: async () => fixture,
    logger: silent,
    now: () => NOW,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  rmSync(handle.config.dataDir, { recursive: true, force: true });
});

function auth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  };
}

async function authFilesAt(hubUrl: string): Promise<CliproxyAuthFilesResponse> {
  const response = await fetch(`${hubUrl}/v0/management/auth-files`, auth());
  expect(response.status).toBe(200);
  return (await response.json()) as CliproxyAuthFilesResponse;
}

async function authFiles(): Promise<CliproxyAuthFilesResponse> {
  return authFilesAt(base);
}

async function apiCallAt(
  hubUrl: string,
  authIndex: string,
  url: string,
): Promise<CliproxyApiCallResponse> {
  const response = await fetch(
    `${hubUrl}/v0/management/api-call`,
    auth({
      method: "POST",
      body: JSON.stringify({ auth_index: authIndex, method: "GET", url }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CliproxyApiCallResponse;
}

async function apiCall(authIndex: string, url: string): Promise<CliproxyApiCallResponse> {
  return apiCallAt(base, authIndex, url);
}

async function waitForReady(hubUrl: string, expected: number, timeoutMs = 1_500): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  while (Date.now() < deadline) {
    status = (await fetch(`${hubUrl}/readyz`)).status;
    if (status === expected) return status;
    await Bun.sleep(10);
  }
  return status;
}

describe("hub HTTP surface", () => {
  test("health and readiness are minimal and unauthenticated", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      ok: boolean;
      service: string;
      accounts?: number;
      magpie?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("magpie-t3code-hub");
    // No upstream URL, error text or account data on the open endpoint.
    expect(body.accounts).toBeUndefined();
    expect(body.magpie).toBeUndefined();

    // startHub warms the cache, so readiness becomes 200 without T3.
    expect(await waitForReady(base, 200)).toBe(200);
    await authFiles();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  test("an account Magpie failed to read is served only while its readAt is fresh", async () => {
    const files = await authFilesAt(base);
    // The fixture's cursor account has an error and no readAt: its age is unknown.
    const cursor = files.files.find((file) => file.id === "cursor/cursor@example.com")!;
    const unknownAge = await apiCall(cursor.auth_index, "https://api.anthropic.com/api/oauth/usage");
    expect(unknownAge.status_code).toBe(503);
    expect(unknownAge.body).toContain("temporary upstream failure");

    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-account-error-"));
    const account = (readAt: string) => ({
      provider: "claude",
      name: "Claude Code",
      user: "err@example.com",
      error: "fetch failed",
      readAt,
      windows: [{ name: "5 hours", used: 20 }],
    });
    let readAt = new Date(NOW - 60_000).toISOString();
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      cacheTtlMs: 0,
      maxStaleMs: 10 * 60_000,
      fetchQuotas: async () => ({ data: [account(readAt)] }),
      logger: silent,
      now: () => NOW,
    });
    try {
      const index = (await authFilesAt(hub.url)).files[0]!.auth_index;
      const usage = "https://api.anthropic.com/api/oauth/usage";
      expect((await apiCallAt(hub.url, index, usage)).status_code).toBe(200);
      readAt = new Date(NOW - 60 * 60_000).toISOString();
      expect((await apiCallAt(hub.url, index, usage)).status_code).toBe(503);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("status reports lastOkAt even when the clock reads 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-zero-clock-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => 0,
    });
    try {
      const status = (await (await fetch(`${hub.url}/v1/hub/status`, auth())).json()) as {
        lastOkAt: string | null;
      };
      expect(status.lastOkAt).toBe(new Date(0).toISOString());
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bracketed IPv6 host binds as a bare address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-ipv6-"));
    const config = await validateHubOptions({ host: "[::1]", port: 0, managementKey: KEY, dataDir: dir });
    expect(config.host).toBe("::1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an invalid backoff is rejected by validation, before any listener is touched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-backoff-"));
    const previous = process.env.MAGPIE_T3CODE_HUB_BACKOFF_MS;
    process.env.MAGPIE_T3CODE_HUB_BACKOFF_MS = "abc";
    try {
      await expect(
        validateHubOptions({ port: 0, managementKey: KEY, dataDir: dir }),
      ).rejects.toThrow(/backoffMs/);
    } finally {
      if (previous === undefined) delete process.env.MAGPIE_T3CODE_HUB_BACKOFF_MS;
      else process.env.MAGPIE_T3CODE_HUB_BACKOFF_MS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a port-0 hub reports the actual port without rewriting its config", () => {
    expect(handle.config.port).toBe(0);
    expect(handle.port).toBeGreaterThan(0);
  });

  test("maxStaleMs=0 does not expire a just-fetched cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-zero-stale-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      maxStaleMs: 0,
      cacheTtlMs: 5_000,
      backoffMs: 1_000,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => NOW,
    });
    try {
      expect(await waitForReady(hub.url, 200)).toBe(200);
      expect(
        (await fetch(`${hub.url}/v0/management/auth-files`, auth())).status,
      ).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a slow successful Magpie read is not expired by maxStaleMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-slow-read-"));
    let now = NOW;
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      maxStaleMs: 0,
      cacheTtlMs: 5_000,
      backoffMs: 1_000,
      fetchQuotas: async () => {
        // A 6s upstream call is slower than cacheTtlMs but still succeeds.
        now += 6_000;
        return fixture;
      },
      logger: silent,
      now: () => now,
    });
    try {
      expect(
        (await fetch(`${hub.url}/v0/management/auth-files`, auth())).status,
      ).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zero stale and zero cache TTL still serve a just-fetched snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-zero-window-"));
    let now = NOW;
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      maxStaleMs: 0,
      cacheTtlMs: 0,
      fetchQuotas: async () => {
        now += 25;
        return fixture;
      },
      logger: silent,
      now: () => now,
    });
    try {
      expect(
        (await fetch(`${hub.url}/v0/management/auth-files`, auth())).status,
      ).toBe(200);
      // The minimum fresh window keeps readiness up briefly even with both
      // knobs at zero; otherwise it would flap 503 on every probe.
      now += 500;
      expect((await fetch(`${hub.url}/readyz`)).status).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects out-of-range ports instead of clamping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-bad-port-"));
    try {
      const options = {
        managementKey: KEY,
        dataDir: dir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      };
      await expect(startHub({ ...options, port: -1 })).rejects.toThrow(/Invalid port/);
      await expect(startHub({ ...options, port: 70_000 })).rejects.toThrow(/Invalid port/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid numeric timing options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-invalid-timing-"));
    try {
      await expect(
        startHub({
          port: 0,
          managementKey: KEY,
          dataDir: dir,
          cacheTtlMs: "5s" as any,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/Invalid cacheTtlMs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wildcard bind advertises a connectable URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-wildcard-"));
    const hub = await startHub({
      host: "0.0.0.0",
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => NOW,
    });
    try {
      expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`);
      expect((await fetch(`${hub.url}/healthz`)).status).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("status omits text-only windows like T3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-text-window-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => ({
        data: [
          {
            provider: "claude",
            name: "Claude Code",
            user: "notes@example.com",
            windows: [
              { name: "+$183 on us", text: true, used: 0 },
              { name: "5 hours", used: 10 },
            ],
          },
        ],
      }),
      logger: silent,
      now: () => NOW,
    });
    try {
      const response = await fetch(`${hub.url}/v1/hub/status`, auth());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        accounts: Array<{ windows: Array<{ name: string }> }>;
      };
      expect(body.accounts[0]?.windows).toEqual([
        expect.objectContaining({ name: "5 hours" }),
      ]);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("management routes reject a missing or wrong key", async () => {
    expect((await fetch(`${base}/v0/management/auth-files`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/v0/management/auth-files`, {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${base}/v1/hub/status`)).status).toBe(401);
  });

  test("auth-files matches what T3 Code parses", async () => {
    const body = await authFiles();
    expect(body.files).toHaveLength(fixture.data.length);
    for (const file of body.files) {
      expect(typeof file.id).toBe("string");
      expect(typeof file.auth_index).toBe("string");
      expect(["claude", "codex"]).toContain(file.provider);
    }
  });

  test("api-call answers Claude and Codex usage in provider-native shapes", async () => {
    const { files } = await authFiles();
    const claude = files.find((file) => file.id === "claude/claude@example.com");
    const codex = files.find((file) => file.id === "codex/codex@example.com");
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();

    const claudeReply = await apiCall(claude!.auth_index, "https://api.anthropic.com/api/oauth/usage");
    expect(claudeReply.status_code).toBe(200);
    const claudeUsage = JSON.parse(claudeReply.body) as ClaudeUsage;
    expect(claudeUsage.five_hour?.utilization).toBe(11);
    expect(claudeUsage.seven_day?.utilization).toBe(44);

    const codexReply = await apiCall(codex!.auth_index, "https://chatgpt.com/backend-api/wham/usage");
    expect(codexReply.status_code).toBe(200);
    const codexUsage = JSON.parse(codexReply.body) as CodexUsage;
    expect(codexUsage.plan_type).toBe("plus");
    expect(codexUsage.rate_limit?.primary_window?.used_percent).toBe(100);
  });

  test("api-call returns an inner 404 for an unknown or stale auth index", async () => {
    const reply = await apiCall("does-not-exist", "https://api.anthropic.com/api/oauth/usage");
    expect(reply.status_code).toBe(404);
    expect(JSON.parse(reply.body)).toHaveProperty("error");
  });

  test("api-call rejects malformed requests and unsupported URLs", async () => {
    const missing = await fetch(
      `${base}/v0/management/api-call`,
      auth({ method: "POST", body: JSON.stringify({ auth_index: "x" }) }),
    );
    expect(missing.status).toBe(400);

    const invalidJson = await fetch(
      `${base}/v0/management/api-call`,
      auth({ method: "POST", body: "{nope" }),
    );
    expect(invalidJson.status).toBe(400);

    const { files } = await authFiles();
    const reply = await apiCall(files[0]!.auth_index, "https://example.com/usage");
    expect(reply.status_code).toBe(400);
  });

  test("rejects request bodies by byte length, including multibyte JSON", async () => {
    const baseBody = {
      auth_index: "x",
      url: "https://api.anthropic.com/api/oauth/usage",
    };
    const big = JSON.stringify({ ...baseBody, padding: "a".repeat(70 * 1024) });
    expect(
      (
        await fetch(`${base}/v0/management/api-call`, auth({ method: "POST", body: big }))
      ).status,
    ).toBe(413);

    // 30k Chinese characters are ~90 KB even though text.length is under 64k.
    const multibyte = JSON.stringify({ ...baseBody, padding: "你".repeat(30_000) });
    expect(
      (
        await fetch(`${base}/v0/management/api-call`, auth({ method: "POST", body: multibyte }))
      ).status,
    ).toBe(413);
  });

  test("reset-quota is a safe no-op", async () => {
    const response = await fetch(
      `${base}/v0/management/reset-quota`,
      auth({ method: "POST", body: JSON.stringify({ auth_index: "x" }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("status exposes the mapping for debugging", async () => {
    const response = await fetch(`${base}/v1/hub/status`, auth());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stale: boolean;
      accounts: Array<{ id: string; sourceProvider: string; cliproxyProvider: string }>;
    };
    expect(body.stale).toBe(false);
    expect(body.accounts).toHaveLength(fixture.data.length);
    expect(body.accounts.find((entry) => entry.id === "qoder/qoder@example.com")).toMatchObject({
      sourceProvider: "qoder",
      cliproxyProvider: "claude",
    });
  });

  test("accepts a trailing slash on management routes", async () => {
    const response = await fetch(`${base}/v0/management/auth-files/`, auth());
    expect(response.status).toBe(200);
  });

  test("borrows a hub another plugin host already runs", async () => {
    const second = await startHub({
      port: handle.port,
      managementKey: KEY,
      dataDir: handle.config.dataDir,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => NOW,
    });
    expect(second.server).toBeNull();
    await second.stop();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("takes over after the borrowed hub's owner exits", async () => {
    const follower = await startHub({
      port: handle.port,
      managementKey: KEY,
      dataDir: handle.config.dataDir,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => NOW,
    });
    expect(follower.server).toBeNull();

    await handle.stop();
    await Bun.sleep(2_500);

    expect(follower.server).not.toBeNull();
    const health = (await (await fetch(`${follower.url}/healthz`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    await follower.stop();
  });

  test("refuses to borrow a hub with a different management key", async () => {
    await expect(
      startHub({
        port: handle.port,
        managementKey: "different-key",
        dataDir: handle.config.dataDir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      }),
    ).rejects.toThrow(/different management key/);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test("refuses to borrow a hub with a different Magpie URL", async () => {
    await expect(
      startHub({
        port: handle.port,
        managementKey: KEY,
        dataDir: handle.config.dataDir,
        magpieQuotaUrl: "http://127.0.0.1:3999/v1/magpie/quotas",
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      }),
    ).rejects.toThrow(/Magpie URL/);
  });

  test("refuses to borrow a hub with a different data directory", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-other-data-"));
    try {
      await expect(
        startHub({
          port: handle.port,
          managementKey: KEY,
          dataDir: otherDir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/different data directory/);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("startup fails quickly when the port is held by a non-hub", async () => {
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(2_000);
        return new Response("");
      },
    });
    try {
      const started = Date.now();
      await expect(
        startHub({
          port: slow.port!,
          managementKey: KEY,
          dataDir: handle.config.dataDir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/Could not listen/);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await slow.stop(true);
    }
  });

  test("refuses to borrow a hub that cannot prove its config", async () => {
    const oldHub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") {
          return Response.json({
            ok: true,
            service: "magpie-t3code-hub",
            version: "0.0.0",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await expect(
        startHub({
          port: oldHub.port!,
          managementKey: KEY,
          dataDir: handle.config.dataDir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/older version/);
    } finally {
      await oldHub.stop(true);
    }
  });

  test("status tolerates null window entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-null-window-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => ({
        data: [
          {
            provider: "claude",
            name: "Claude Code",
            user: "null-window@example.com",
            windows: [null, { name: "5 hours", used: 5 }] as any,
          },
        ],
      }),
      logger: silent,
      now: () => NOW,
    });
    try {
      const response = await fetch(`${hub.url}/v1/hub/status`, auth());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        accounts: Array<{ windows: Array<{ name: string }> }>;
      };
      expect(body.accounts[0]?.windows).toHaveLength(1);
      expect(body.accounts[0]?.windows[0]?.name).toBe("5 hours");
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 503, not 500, when Magpie is unreachable before any snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-unavailable-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => {
        throw new Error("magpie is down");
      },
      logger: silent,
      now: () => NOW,
      cacheTtlMs: 1_000,
      backoffMs: 1_000,
    });
    try {
      expect((await fetch(`${hub.url}/v0/management/auth-files`, auth())).status).toBe(503);
      const reply = await apiCallAt(
        hub.url,
        "missing",
        "https://api.anthropic.com/api/oauth/usage",
      );
      expect(reply.status_code).toBe(503);
      expect((await fetch(`${hub.url}/v1/hub/status`, auth())).status).toBe(503);
      expect((await fetch(`${hub.url}/readyz`)).status).toBe(503);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readiness drops when a cached snapshot ages past maxStaleMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-old-cache-"));
    let now = NOW;
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      maxStaleMs: 1_000,
      cacheTtlMs: 1_000,
      backoffMs: 1_000,
      fetchQuotas: async () => fixture,
      logger: silent,
      now: () => now,
    });
    try {
      expect(await waitForReady(hub.url, 200)).toBe(200);
      now += 5_000;
      // No management request has run; the cache is still stale:false but old.
      // readyz returns 503 and kicks a background refresh; the next poll is 200.
      expect((await fetch(`${hub.url}/readyz`)).status).toBe(503);
      expect(await waitForReady(hub.url, 200)).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("status reports the same derived used percentage T3 sees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-derived-"));
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => ({
        data: [
          {
            provider: "qoder-cn",
            name: "Qoder CN",
            user: "derived@example.com",
            windows: [{ name: "Credits", amount: 1_395, limit: 3_000 }],
          },
        ],
      }),
      logger: silent,
      now: () => NOW,
    });
    try {
      const response = await fetch(`${hub.url}/v1/hub/status`, auth());
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        accounts: Array<{ windows: Array<{ used: number | null }> }>;
      };
      expect(body.accounts[0]?.windows[0]?.used).toBeCloseTo(46.5, 5);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health reports stale data after Magpie starts failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-stale-"));
    let now = NOW;
    let failing = false;
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      fetchQuotas: async () => {
        if (failing) throw new Error("magpie is down");
        return fixture;
      },
      logger: silent,
      now: () => now,
    });
    try {
      await fetch(`${hub.url}/v0/management/auth-files`, auth());
      failing = true;
      now += 6_000;
      await fetch(`${hub.url}/v0/management/auth-files`, auth());

      const status = (await (
        await fetch(`${hub.url}/v1/hub/status`, auth())
      ).json()) as {
        stale: boolean;
        staleForMs: number;
        expired: boolean;
        lastError: string | null;
      };
      expect(status.stale).toBe(true);
      expect(status.staleForMs).toBeGreaterThan(0);
      expect(status.expired).toBe(false);
      expect(status.lastError).toContain("magpie is down");
      // Still inside maxStaleMs: readiness stays 200 during the grace window.
      expect((await fetch(`${hub.url}/readyz`)).status).toBe(200);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stops serving a snapshot after maxStaleMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-expired-"));
    let now = NOW;
    let failing = false;
    const hub = await startHub({
      port: 0,
      managementKey: KEY,
      dataDir: dir,
      maxStaleMs: 60_000,
      fetchQuotas: async () => {
        if (failing) throw new Error("magpie is down");
        return fixture;
      },
      logger: silent,
      now: () => now,
      cacheTtlMs: 1_000,
      backoffMs: 1_000,
    });
    try {
      const files = await authFilesAt(hub.url);
      failing = true;
      now += 120_000;

      const stale = await fetch(`${hub.url}/v0/management/auth-files`, auth());
      expect(stale.status).toBe(503);

      const reply = await apiCallAt(
        hub.url,
        files.files.find((file) => file.provider === "claude")!.auth_index,
        "https://api.anthropic.com/api/oauth/usage",
      );
      expect(reply.status_code).toBe(503);

      expect((await fetch(`${hub.url}/readyz`)).status).toBe(503);
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes overlapping ensureHub calls and keeps the last listener", async () => {
    const firstDir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-ensure-a-"));
    const secondDir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-ensure-b-"));
    try {
      const [first, second] = await Promise.all([
        ensureHub({
          port: 0,
          managementKey: KEY,
          dataDir: firstDir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
        ensureHub({
          port: 0,
          managementKey: KEY,
          dataDir: secondDir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ]);

      expect(second.server).not.toBeNull();
      expect((await fetch(`${second.url}/healthz`)).status).toBe(200);
      await expect(fetch(`${first.url}/healthz`)).rejects.toThrow();
    } finally {
      await stopActiveHub();
      rmSync(firstDir, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  test("a fresh module instance replaces the listener through the global singleton", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-reimport-"));
    try {
      const first = await ensureHub({
        port: 0,
        managementKey: KEY,
        dataDir: dir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      });
      const fresh = (await import(
        `../src/hub/server.ts?fresh=${Date.now()}`
      )) as typeof import("../src/hub/server");
      const second = await fresh.ensureHub({
        port: 0,
        managementKey: KEY,
        dataDir: dir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      });

      expect(second).not.toBe(first);
      await expect(fetch(`${first.url}/healthz`)).rejects.toThrow();
      expect((await fetch(`${second.url}/healthz`)).status).toBe(200);
      await fresh.stopActiveHub();
    } finally {
      await stopActiveHub();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the old hub when a reload's config is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-invalid-"));
    try {
      const first = await ensureHub({
        port: 0,
        managementKey: KEY,
        dataDir: dir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      });
      await expect(
        ensureHub({
          port: 0,
          managementKey: KEY,
          dataDir: dir,
          magpieQuotaUrl: "::::",
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/not a valid URL/);
      expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
    } finally {
      await stopActiveHub();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores the previous hub when a reload cannot bind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-rollback-"));
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not the hub"),
    });
    try {
      await ensureHub({
        port: 0,
        managementKey: KEY,
        dataDir: dir,
        fetchQuotas: async () => fixture,
        logger: silent,
        now: () => NOW,
      });
      await expect(
        ensureHub({
          port: blocker.port!,
          managementKey: KEY,
          dataDir: dir,
          fetchQuotas: async () => fixture,
          logger: silent,
          now: () => NOW,
        }),
      ).rejects.toThrow(/Could not listen/);

      // The rollback started a new listener and wrote its port to hub.json.
      const status = JSON.parse(readFileSync(join(dir, "hub.json"), "utf8")) as {
        port: number;
      };
      expect((await fetch(`http://127.0.0.1:${status.port}/healthz`)).status).toBe(200);
    } finally {
      await blocker.stop(true);
      await stopActiveHub();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
