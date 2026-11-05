import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedToken, resolveDataDir, resolveToken } from "../src/hub/auth";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-auth-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("management key", () => {
  test("creates one token, then all hosts agree on it", async () => {
    const dir = tempDir();
    const first = await resolveToken({ dataDir: dir, env: {} });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^mgt_/);
    expect(first.path).toBe(join(dir, "token"));

    const second = await resolveToken({ dataDir: dir, env: {} });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(readSavedToken(dir)).toBe(first.token);

    if (process.platform !== "win32") {
      expect(statSync(first.path!).mode & 0o777).toBe(0o600);
    }
  });

  test("option and environment keys win over the file and create nothing", async () => {
    const dir = tempDir();
    const fromOption = await resolveToken({
      optionToken: "option-key",
      dataDir: dir,
      env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" },
    });
    expect(fromOption).toEqual({ token: "option-key", path: undefined, created: false });
    expect(readSavedToken(dir)).toBeUndefined();

    const fromEnv = await resolveToken({ dataDir: dir, env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" } });
    expect(fromEnv.token).toBe("env-key");
    expect(readSavedToken(dir)).toBeUndefined();
  });

  test("repairs an empty or whitespace-only token file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "token"), "  \n", { mode: 0o600 });

    const repaired = await resolveToken({ dataDir: dir, env: {} });
    expect(repaired.created).toBe(true);
    expect(repaired.token).toMatch(/^mgt_/);
    expect(readSavedToken(dir)).toBe(repaired.token);

    const again = await resolveToken({ dataDir: dir, env: {} });
    expect(again.created).toBe(false);
    expect(again.token).toBe(repaired.token);
  });

  test("recovers a stale lock left by a dead owner", async () => {
    const dir = tempDir();
    const lock = join(dir, "token.lock.00000001");
    writeFileSync(lock, "dead-owner\n", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const result = await resolveToken({ dataDir: dir, env: {} });
    expect(result.created).toBe(true);
    expect(readSavedToken(dir)).toBe(result.token);
    expect(existsSync(lock)).toBe(false);
  });

  test("resolves relative data dirs against home, not cwd", () => {
    expect(resolveDataDir({ MAGPIE_T3CODE_HUB_HOME: "./hubdata" })).toBe(
      join(homedir(), "hubdata"),
    );
    expect(resolveDataDir({ MAGPIE_T3CODE_HUB_HOME: "/tmp/hubdata" })).toBe("/tmp/hubdata");
    expect(resolveDataDir({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/magpie-t3code-hub",
    );
    expect(resolveDataDir({ MAGPIE_T3CODE_HUB_HOME: "~/.magpie-hub" })).toBe(
      join(homedir(), ".magpie-hub"),
    );
    expect(resolveDataDir({}, "./tmp", { relativeTo: "cwd" })).toBe(
      join(process.cwd(), "tmp"),
    );
  });

  test("an unwritable data dir fails with a clear, actionable message", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const dir = tempDir();
    chmodSync(dir, 0o500);
    try {
      await expect(resolveToken({ dataDir: dir, env: {} })).rejects.toThrow(
        /Cannot create the management key.*MAGPIE_T3CODE_HUB_TOKEN/,
      );
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
