import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenFile } from "../src/hub/auth";
import { readHubStatus, writeHubStatus } from "../src/hub/status";
import { defaultHubUrl, pluginHubUrl } from "../src/cli/config";
import { resolveCliKey } from "../src/cli/key";
import { readPluginHubOptions } from "../src/cli/plugin-options";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "magpie-t3code-hub-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI configuration discovery", () => {
  test("reads managementKey/dataDir/port from Magpie plugin options", () => {
    const dir = tempDir();
    const file = join(dir, "plugins.json");
    writeFileSync(
      file,
      JSON.stringify({
        plugins: [
          { spec: "@magpie-community/opencode-qoder-auth@latest" },
          {
            spec: "/opt/magpie-t3code-hub",
            options: {
              managementKey: "plugin-key",
              dataDir: "/srv/hub",
              host: "192.168.1.5",
              port: "4321",
            },
          },
        ],
      }),
    );
    expect(readPluginHubOptions(file)).toEqual({
      managementKey: "plugin-key",
      token: undefined,
      dataDir: "/srv/hub",
      host: "192.168.1.5",
      port: 4321,
    });
  });

  test("reads the running hub's port, URL and token path", () => {
    const dir = tempDir();
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "mgt_file_token\n", { mode: 0o600 });
    writeFileSync(
      join(dir, "hub.json"),
      JSON.stringify({
        service: "magpie-t3code-hub",
        port: 4319,
        pid: process.pid,
        url: "http://127.0.0.1:4319",
        tokenPath,
        token: "must-not-be-read-from-here",
      }),
    );
    expect(readHubStatus(dir)).toEqual({
      port: 4319,
      pid: process.pid,
      url: "http://127.0.0.1:4319",
      tokenPath,
    });
    expect(readTokenFile(tokenPath)).toBe("mgt_file_token");
  });

  test("hub.json advertises a connectable URL for a wildcard bind", () => {
    const dir = tempDir();
    writeHubStatus(dir, {
      version: "test",
      host: "0.0.0.0",
      port: 4319,
      magpieQuotaUrl: "http://127.0.0.1:3425/v1/magpie/quotas",
      startedAt: new Date(0).toISOString(),
    });
    expect(readHubStatus(dir)?.url).toBe("http://127.0.0.1:4319");
    expect(readdirSync(dir)).toEqual(["hub.json"]);
  });

  test("derives a hub URL from host-only or port-only plugin options", () => {
    expect(pluginHubUrl({ host: "192.168.1.5" })).toBe("http://192.168.1.5:4319");
    expect(pluginHubUrl({ port: 4400 })).toBe("http://127.0.0.1:4400");
    expect(pluginHubUrl({})).toBeUndefined();
    expect(pluginHubUrl(undefined)).toBeUndefined();
    expect(defaultHubUrl()).toBe("http://127.0.0.1:4319");
  });

  test("uses a non-wildcard configured host", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "hub.json"),
      JSON.stringify({
        service: "magpie-t3code-hub",
        pid: process.pid,
        host: "192.168.1.5",
        port: 4400,
        tokenPath: null,
      }),
    );
    expect(readHubStatus(dir)?.url).toBe("http://192.168.1.5:4400");
  });

  test("prefers the persisted URL over host and port", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "hub.json"),
      JSON.stringify({
        service: "magpie-t3code-hub",
        pid: process.pid,
        host: "127.0.0.1",
        port: 4400,
        url: "http://10.0.0.5:4400",
        tokenPath: null,
      }),
    );
    expect(readHubStatus(dir)?.url).toBe("http://10.0.0.5:4400");
  });

  test("rejects an invalid plugin port instead of ignoring it", () => {
    const dir = tempDir();
    const file = join(dir, "plugins.json");
    writeFileSync(
      file,
      JSON.stringify({
        plugins: [{ spec: "/opt/magpie-t3code-hub", options: { port: "4319x" } }],
      }),
    );
    expect(() => readPluginHubOptions(file)).toThrow(/Invalid port/);
  });

  test("ignores hub.json left behind by a dead process", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "hub.json"),
      JSON.stringify({
        service: "magpie-t3code-hub",
        port: 4319,
        pid: 2_147_483_646,
        tokenPath: null,
      }),
    );
    expect(readHubStatus(dir)).toBeUndefined();
  });

  test("ignores hub.json without the service marker or a pid", () => {
    const dir = tempDir();
    const file = join(dir, "hub.json");
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, port: 4319, tokenPath: null }),
    );
    expect(readHubStatus(dir)).toBeUndefined();

    writeFileSync(
      file,
      JSON.stringify({ service: "magpie-t3code-hub", port: 4319, tokenPath: null }),
    );
    expect(readHubStatus(dir)).toBeUndefined();

    writeFileSync(
      file,
      JSON.stringify({
        service: "magpie-t3code-hub",
        pid: process.pid,
        port: 4319,
        tokenPath: null,
      }),
    );
    expect(readHubStatus(dir)?.port).toBe(4319);
  });
});

describe("CLI key precedence", () => {
  test("plugin option beats the shell environment", async () => {
    const result = await resolveCliKey({
      plugin: { managementKey: "plugin-key" },
      env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" },
      dataDir: tempDir(),
      allowCreate: false,
    });
    expect(result).toMatchObject({ key: "plugin-key", source: "plugin" });
  });

  test("the running hub's token file beats the shell environment", async () => {
    const dir = tempDir();
    const token = join(dir, "hub-token");
    writeFileSync(token, "hub-key\n", { mode: 0o600 });
    const result = await resolveCliKey({
      status: { tokenPath: token },
      env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" },
      dataDir: dir,
      allowCreate: false,
    });
    expect(result).toMatchObject({ key: "hub-key", source: "hub" });
  });

  test("a running hub whose token file vanished falls back to an explicit env key", async () => {
    const dir = tempDir();
    const result = await resolveCliKey({
      status: { tokenPath: join(dir, "token") },
      env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" },
      dataDir: dir,
      allowCreate: true,
    });
    expect(result).toMatchObject({ key: "env-key", source: "env" });
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  test("a vanished token file blocks only when no env key exists", async () => {
    const dir = tempDir();
    const result = await resolveCliKey({
      status: { tokenPath: join(dir, "token") },
      env: {},
      dataDir: dir,
      allowCreate: true,
    });
    expect(result.key).toBeUndefined();
    expect(result.blocked).toContain("missing or empty");
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  test("hub.json with tokenPath:null blocks instead of fabricating a token", async () => {
    const dir = tempDir();
    const result = await resolveCliKey({
      status: { tokenPath: null },
      env: {},
      dataDir: dir,
      allowCreate: true,
    });
    expect(result.key).toBeUndefined();
    expect(result.blocked).toContain("tokenPath:null");
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  test("hub.json with tokenPath:null still accepts an explicit env key", async () => {
    const result = await resolveCliKey({
      status: { tokenPath: null },
      env: { MAGPIE_T3CODE_HUB_TOKEN: "env-key" },
      dataDir: tempDir(),
      allowCreate: false,
    });
    expect(result).toMatchObject({ key: "env-key", source: "env" });
  });

  test("no hub and no key does not create when allowCreate is false", async () => {
    const dir = tempDir();
    const result = await resolveCliKey({ env: {}, dataDir: dir, allowCreate: false });
    expect(result.key).toBeUndefined();
    expect(result.blocked).toBeDefined();
  });

  test("no hub creates a file token when allowCreate is true", async () => {
    const dir = tempDir();
    const result = await resolveCliKey({ env: {}, dataDir: dir, allowCreate: true });
    expect(result.key).toMatch(/^mgt_/);
    expect(result.source).toBe("created");
    expect(existsSync(join(dir, "token"))).toBe(true);
  });
});

describe("plugin numeric options", () => {
  test("a present but invalid number is an error, not a silent default", async () => {
    const { strictOptionNumber } = await import("../src/hub/options");
    expect(strictOptionNumber(undefined, "port")).toBeUndefined();
    expect(strictOptionNumber("  ", "port")).toBeUndefined();
    expect(strictOptionNumber("4400", "port")).toBe(4400);
    expect(() => strictOptionNumber("4319x", "port")).toThrow("Invalid port");
    expect(() => strictOptionNumber({}, "cacheTtlMs")).toThrow("Invalid cacheTtlMs");
  });
});
