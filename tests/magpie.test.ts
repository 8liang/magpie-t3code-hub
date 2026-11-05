import { describe, expect, test } from "bun:test";
import { QuotaSource } from "../src/hub/magpie";
import { fixture, NOW } from "./fixtures";

const silent = { info() {}, warn() {}, error() {} };

describe("Magpie quota source", () => {
  test("serves a fresh cache, then a stale snapshot with a backoff", async () => {
    let now = NOW;
    let calls = 0;
    let fail = false;
    const source = new QuotaSource({
      url: "http://magpie.test/v1/magpie/quotas",
      timeoutMs: 1_000,
      cacheTtlMs: 1_000,
      backoffMs: 5_000,
      fetchQuotas: async () => {
        calls += 1;
        if (fail) throw new Error("magpie is down");
        return fixture;
      },
      logger: silent,
      now: () => now,
    });

    const first = await source.read();
    expect(first.stale).toBe(false);
    expect(calls).toBe(1);

    now += 500;
    expect((await source.read()).stale).toBe(false);
    expect(calls).toBe(1);

    now += 1_500;
    fail = true;
    const stale = await source.read();
    expect(stale.stale).toBe(true);
    expect(stale.upstream.data).toHaveLength(fixture.data.length);
    expect(source.cached?.stale).toBe(true);
    expect(source.lastError).toContain("magpie is down");
    expect(calls).toBe(2);

    // Within the backoff window: no upstream call, no timeout wait.
    const quickly = await source.read();
    expect(quickly.stale).toBe(true);
    expect(calls).toBe(2);

    now += 6_000;
    expect((await source.read()).stale).toBe(true);
    expect(calls).toBe(3);

    fail = false;
    now += 6_000;
    const recovered = await source.read();
    expect(recovered.stale).toBe(false);
    expect(source.cached?.stale).toBe(false);
    expect(source.lastError).toBeUndefined();
    expect(calls).toBe(4);
  });

  test("backs off even before any snapshot exists", async () => {
    let calls = 0;
    const source = new QuotaSource({
      url: "http://magpie.test/v1/magpie/quotas",
      timeoutMs: 1_000,
      cacheTtlMs: 1_000,
      backoffMs: 5_000,
      fetchQuotas: async () => {
        calls += 1;
        throw new Error("magpie is down");
      },
      logger: silent,
      now: () => NOW,
    });

    await expect(source.read()).rejects.toThrow("magpie is down");
    await expect(source.read()).rejects.toThrow("magpie is down");
    expect(calls).toBe(1);
  });

  test("logs the first upstream failure even with a small injected clock", async () => {
    const warnings: string[] = [];
    const source = new QuotaSource({
      url: "http://magpie.test/v1/magpie/quotas",
      timeoutMs: 1_000,
      cacheTtlMs: 1_000,
      backoffMs: 5_000,
      fetchQuotas: async () => {
        throw new Error("magpie is down");
      },
      logger: { ...silent, warn: (message: string) => warnings.push(message) },
      now: () => 1_000,
    });
    await source.read().catch(() => {});
    expect(warnings).toHaveLength(1);
  });
});
