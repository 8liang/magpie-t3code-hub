import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./auth";
import { DEFAULT_HUB_HOST } from "./constants";
import { optionString } from "./options";
import type { HubConfig } from "./types";

/**
 * hub.json: the running hub's address and key location, written by the hub
 * and read by the token/verify CLIs. Its schema lives only in this module.
 */
export interface HubStatusFile {
  url?: string;
  port?: number;
  pid?: number;
  /** null means the hub got its key from an option/environment, not a file. */
  tokenPath?: string | null;
}

export type HubStatusInput = Pick<
  HubConfig,
  "version" | "host" | "port" | "magpieQuotaUrl" | "tokenPath"
> & { startedAt: string };

function statusPath(dataDir: string): string {
  return join(dataDir, "hub.json");
}

export function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function hubUrl(host: string, port: number): string {
  return `http://${formatHost(host)}:${port}`;
}

/** A wildcard bind address is not something a client can connect to. */
export function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

/** The URL a local client should use to reach a hub bound to host:port. */
export function clientUrl(host: string, port: number): string {
  return hubUrl(probeHost(host), port);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return errorCode(error) === "EPERM";
  }
}

export function writeHubStatus(dataDir: string, input: HubStatusInput): void {
  const target = statusPath(dataDir);
  const temp = `${target}.tmp.${process.pid}`;
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const status = {
      service: "magpie-t3code-hub",
      version: input.version,
      pid: process.pid,
      host: input.host,
      port: input.port,
      url: clientUrl(input.host, input.port),
      magpieQuotaUrl: input.magpieQuotaUrl,
      tokenPath: input.tokenPath ?? null,
      startedAt: input.startedAt,
    };
    // Readers must never see a truncated status file.
    writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } catch {
    // Status is diagnostic only; a read-only data dir must not stop the hub.
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up.
    }
  }
}

/** Reads the running hub's hub.json so the CLIs use its actual port/key. */
export function readHubStatus(dataDir: string): HubStatusFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(statusPath(dataDir), "utf8")) as Record<string, unknown>;
    // Only trust a status file this hub wrote, and only while its process is
    // alive. A missing marker or pid means an old/foreign file, not a hub.
    if (raw.service !== "magpie-t3code-hub") return undefined;
    const port =
      typeof raw.port === "number" && Number.isFinite(raw.port) ? raw.port : undefined;
    const pid =
      typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0
        ? raw.pid
        : undefined;
    if (pid === undefined || !processAlive(pid)) return undefined;
    const host = optionString(raw.host);
    let url = optionString(raw.url);
    if (url !== undefined) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") url = undefined;
      } catch {
        url = undefined;
      }
    }
    const validPort =
      port !== undefined && Number.isInteger(port) && port >= 0 && port <= 65_535;
    if (url === undefined && validPort) url = clientUrl(host ?? DEFAULT_HUB_HOST, port);
    return {
      url,
      port,
      ...(pid === undefined ? {} : { pid }),
      tokenPath: raw.tokenPath === null ? null : optionString(raw.tokenPath),
    };
  } catch {
    return undefined;
  }
}

/** Removes hub.json only when this process wrote it. */
export function removeHubStatus(dataDir: string): void {
  if (readHubStatus(dataDir)?.pid !== process.pid) return;
  try {
    rmSync(statusPath(dataDir), { force: true });
  } catch {
    // Already gone.
  }
}
