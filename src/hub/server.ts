import { bearerToken, resolveDataDir, resolveToken, tokenMatches } from "./auth";
import {
  optionPresent,
  optionString,
  strictBoundedNumber,
  strictOptionNumber,
} from "./options";
import { QuotaSource, QuotaUnavailableError, type QuotaResult } from "./magpie";
import {
  accountDisplayName,
  authFiles,
  buildSnapshot,
  clampPercent,
  usageFor,
  usableWindows,
  windowName,
  windowUsed,
} from "./mapping";
import type {
  CliproxyApiCallRequest,
  HubConfig,
  HubLogger,
  HubSnapshot,
  QuotaFetcher,
} from "./types";
import { clientUrl, removeHubStatus, writeHubStatus } from "./status";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, DEFAULT_MAGPIE_QUOTA_URL } from "./constants";
import { apiReply } from "./replies";
import { packageVersion } from "./version";

type BunServer = ReturnType<typeof Bun.serve>;

class ExistingHubConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExistingHubConflict";
  }
}

export interface StartHubOptions {
  host?: string;
  port?: number;
  magpieQuotaUrl?: string;
  magpieManagementKey?: string;
  managementKey?: string;
  dataDir?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  maxStaleMs?: number;
  backoffMs?: number;
  /** Keep the process alive while waiting to take over a borrowed hub. */
  keepAliveOnBorrow?: boolean;
  fetchQuotas?: QuotaFetcher;
  logger?: HubLogger;
  /** Injected clock, mainly for tests. */
  now?: () => number;
}

export interface HubHandle {
  /** Null when this process borrowed a hub another plugin host already runs. */
  server: BunServer | null;
  port: number;
  url: string;
  config: HubConfig;
  stop(): Promise<void>;
}

const DEFAULT_CACHE_TTL_MS = 5_000;
/** A just-fetched snapshot is always servable, whatever the age limits say. */
const MIN_FRESH_MS = 1_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STALE_MS = 10 * 60_000;
const DEFAULT_BACKOFF_MS = 10_000;
const MAX_REQUEST_BODY = 64 * 1024;
const PROBE_BUDGET_MS = 2_000;
const MAX_PROBES = 2;

function defaultLogger(): HubLogger {
  const write = (level: string) => (message: string) => {
    // stdout belongs to Magpie's plugin host JSON-RPC protocol. Never use it.
    console.error(`[t3code-hub] ${level} ${message}`);
  };
  return { info: write("INFO"), warn: write("WARN"), error: write("ERROR") };
}

function resolvePort(value: unknown): number {
  if (!optionPresent(value)) return DEFAULT_HUB_PORT;
  const parsed = strictOptionNumber(value, "port");
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port ${String(value)}: expected an integer from 0 to 65535.`);
  }
  return parsed;
}

/** Bun.serve wants a bare address; accept the URL-style "[::1]" too. */
function bindHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function resolveConfig(options: StartHubOptions): Promise<HubConfig> {
  const env = process.env;
  const dataDir = resolveDataDir(env, options.dataDir);

  const magpieQuotaUrl =
    optionString(options.magpieQuotaUrl) ?? optionString(env.MAGPIE_QUOTA_URL) ?? DEFAULT_MAGPIE_QUOTA_URL;
  try {
    // Fail at startup, not on T3 Code's first probe.
    new URL(magpieQuotaUrl);
  } catch {
    throw new Error(`MAGPIE_QUOTA_URL is not a valid URL: ${magpieQuotaUrl}`);
  }

  const port = resolvePort(options.port ?? env.MAGPIE_T3CODE_HUB_PORT);

  const token = await resolveToken({
    optionToken: options.managementKey,
    dataDir,
    env,
  });

  return {
    version: packageVersion(),
    host: bindHost(optionString(options.host) ?? optionString(env.MAGPIE_T3CODE_HUB_HOST) ?? DEFAULT_HUB_HOST),
    port,
    magpieQuotaUrl,
    magpieManagementKey: optionString(options.magpieManagementKey) ?? optionString(env.MAGPIE_GATEWAY_KEY),
    managementKey: token.token,
    dataDir,
    tokenPath: token.path,
    fetchTimeoutMs: strictBoundedNumber(
      options.fetchTimeoutMs ?? env.MAGPIE_T3CODE_HUB_FETCH_TIMEOUT_MS,
      "fetchTimeoutMs",
      DEFAULT_FETCH_TIMEOUT_MS,
      1_000,
      14_000,
    ),
    cacheTtlMs: strictBoundedNumber(
      options.cacheTtlMs ?? env.MAGPIE_T3CODE_HUB_CACHE_TTL_MS,
      "cacheTtlMs",
      DEFAULT_CACHE_TTL_MS,
      0,
      60_000,
    ),
    maxStaleMs: strictBoundedNumber(
      options.maxStaleMs ?? env.MAGPIE_T3CODE_HUB_MAX_STALE_MS,
      "maxStaleMs",
      DEFAULT_MAX_STALE_MS,
      0,
      24 * 60 * 60_000,
    ),
    // Validated here with everything else, so a bad value fails before
    // ensureHub stops the running listener.
    backoffMs: strictBoundedNumber(
      options.backoffMs ?? env.MAGPIE_T3CODE_HUB_BACKOFF_MS,
      "backoffMs",
      DEFAULT_BACKOFF_MS,
      0,
      60_000,
    ),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function normalizePath(pathname: string): string {
  if (pathname.length <= 1) return "/";
  return pathname.replace(/\/+$/, "");
}

/**
 * Magpie's CLI starts a temporary plugin host to inspect installed plugins.
 * If the app's host already owns the port, that second load must borrow the
 * running hub instead of failing (and polluting `magpie plugin list`).
 */
async function existingHub(config: HubConfig): Promise<boolean> {
  if (config.port === 0) return false;
  const base = clientUrl(config.host, config.port);

  let health: Response;
  try {
    health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(750) });
  } catch {
    return false;
  }
  if (!health.ok) return false;
  try {
    const body = (await health.json()) as { service?: unknown };
    if (body.service !== "magpie-t3code-hub") return false;
  } catch {
    return false;
  }

  // The key is verified by the authenticated round trip. A different URL or
  // data dir means this is not our hub, even if the process is the same kind.
  let infoResponse: Response;
  try {
    infoResponse = await fetch(`${base}/v0/management/hub-info`, {
      headers: { authorization: `Bearer ${config.managementKey}` },
      signal: AbortSignal.timeout(750),
    });
  } catch {
    return false;
  }
  if (infoResponse.status === 404) {
    // Older hub without hub-info: we cannot verify key/URL/dataDir, so do
    // not adopt it silently. Restarting the old host is the safe fix.
    throw new ExistingHubConflict(
      `A magpie-t3code-hub is already listening on ${base} but does not expose hub-info ` +
        "(older version). Restart it or change MAGPIE_T3CODE_HUB_PORT.",
    );
  }
  if (infoResponse.status === 401 || infoResponse.status === 403) {
    throw new ExistingHubConflict(
      `A magpie-t3code-hub is already listening on ${base} with a different management key. ` +
        "Stop it, change MAGPIE_T3CODE_HUB_PORT, or use the same key.",
    );
  }
  if (!infoResponse.ok) return false;

  let info: { magpieQuotaUrl?: unknown; dataDir?: unknown };
  try {
    info = (await infoResponse.json()) as typeof info;
  } catch {
    return false;
  }
  if (info.magpieQuotaUrl !== config.magpieQuotaUrl) {
    throw new ExistingHubConflict(
      `A magpie-t3code-hub is already listening on ${base} with Magpie URL ` +
        `${String(info.magpieQuotaUrl)}. Stop it or use the same MAGPIE_QUOTA_URL.`,
    );
  }
  if (info.dataDir !== config.dataDir) {
    throw new ExistingHubConflict(
      `A magpie-t3code-hub is already listening on ${base} with a different data directory. ` +
        "Stop it or use the same MAGPIE_T3CODE_HUB_HOME.",
    );
  }
  return true;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY) {
    throw httpError(413, "Request body is too large.");
  }

  const reader = request.body?.getReader();
  if (!reader) throw httpError(400, "Request body is empty.");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY) {
      await reader.cancel().catch(() => {});
      throw httpError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  if (total === 0) throw httpError(400, "Request body is empty.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw httpError(400, "Request body is empty.");
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body is not valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Starts the hub. The caller owns the returned handle; `ensureHub` keeps the
 * process-wide singleton on `globalThis` so a Magpie re-import can replace the
 * listener cleanly.
 */
export async function startHub(
  options: StartHubOptions = {},
  resolvedConfig?: HubConfig,
): Promise<HubHandle> {
  const config = resolvedConfig ?? (await resolveConfig(options));
  const logger = options.logger ?? defaultLogger();
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const quotaSource = new QuotaSource({
    url: config.magpieQuotaUrl,
    managementKey: config.magpieManagementKey,
    timeoutMs: config.fetchTimeoutMs,
    cacheTtlMs: config.cacheTtlMs,
    backoffMs: config.backoffMs,
    fetchQuotas: options.fetchQuotas,
    logger,
    now,
  });

  let snapshotCache: { result: QuotaResult; snapshot: HubSnapshot } | undefined;

  async function snapshot(): Promise<HubSnapshot> {
    const result = await quotaSource.read();
    // T3 probes every account concurrently. Reuse the projection while the
    // QuotaSource returns the same object instead of re-hashing every account.
    if (snapshotCache?.result === result) return snapshotCache.snapshot;
    const built = buildSnapshot(result.upstream, {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
    });
    snapshotCache = { result, snapshot: built };
    return built;
  }

  async function snapshotOrUnavailable(): Promise<HubSnapshot | null> {
    try {
      return await snapshot();
    } catch (error) {
      if (error instanceof QuotaUnavailableError) return null;
      throw error;
    }
  }

  /** The one rule for "can this snapshot be served", shared by every route. */
  async function servableSnapshot(): Promise<{ snapshot: HubSnapshot } | { error: string }> {
    const current = await snapshotOrUnavailable();
    if (!current) return { error: "Magpie's quota API is unavailable." };
    if (isExpired(current.fetchedAt, current.stale)) {
      return { error: "Magpie's quota snapshot is too old; check Magpie's health." };
    }
    return { snapshot: current };
  }

  function ageMs(fetchedAt: number): number {
    return Math.max(0, now() - fetchedAt);
  }

  function isExpired(fetchedAt: number, stale: boolean): boolean {
    // A fresh cache keeps a short minimum window, so maxStaleMs=0 (or even
    // cacheTtlMs=0) cannot reject data that was just read from Magpie.
    const limit = stale
      ? config.maxStaleMs
      : Math.max(config.maxStaleMs, config.cacheTtlMs, MIN_FRESH_MS);
    return ageMs(fetchedAt) > limit;
  }

  function staleForMs(current: HubSnapshot): number {
    return current.stale ? ageMs(current.fetchedAt) : 0;
  }

  function authorized(request: Request): boolean {
    return tokenMatches(config.managementKey, bearerToken(request));
  }

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    try {
      if (request.method === "GET" && path === "/healthz") {
        // Liveness only: no upstream URL, errors or account data on an
        // unauthenticated endpoint that may be bound beyond loopback.
        return json({ ok: true, service: "magpie-t3code-hub", version: config.version });
      }

      if (request.method === "GET" && path === "/readyz") {
        const cached = quotaSource.cached;
        // Do not stay unready forever just because T3 stopped polling: an
        // expired/absent cache kicks a background refresh (deduped/backed off
        // by QuotaSource), and the next probe sees the result.
        if (cached === undefined || isExpired(cached.fetchedAt, cached.stale)) {
          void quotaSource.read().catch(() => {});
        }
        // Same expiry rule as auth-files/api-call. A stale snapshot within
        // maxStaleMs is still serviceable; an old cache that was never
        // re-probed is not.
        const ready = cached !== undefined && !isExpired(cached.fetchedAt, cached.stale);
        return json(
          { ok: ready, service: "magpie-t3code-hub", version: config.version },
          ready ? 200 : 503,
        );
      }

      if (path.startsWith("/v0/management/") || path === "/v1/hub/status") {
        if (!authorized(request)) {
          return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
        }
      } else {
        return json({ error: "not found" }, 404);
      }

      if (request.method === "GET" && path === "/v0/management/hub-info") {
        return json({
          service: "magpie-t3code-hub",
          version: config.version,
          magpieQuotaUrl: config.magpieQuotaUrl,
          dataDir: config.dataDir,
        });
      }

      if (request.method === "GET" && path === "/v0/management/auth-files") {
        const gate = await servableSnapshot();
        if ("error" in gate) return json({ error: gate.error }, 503);
        return json({ files: authFiles(gate.snapshot) });
      }

      if (request.method === "POST" && path === "/v0/management/api-call") {
        const body = await readBody(request);
        if (!isRecord(body)) return json({ error: "api-call expects an object." }, 400);
        const call = body as CliproxyApiCallRequest;
        const authIndex = typeof call.auth_index === "string" ? call.auth_index.trim() : "";
        const upstreamUrl = typeof call.url === "string" ? call.url.trim() : "";
        if (!authIndex || !upstreamUrl) {
          return json({ error: "api-call needs auth_index and url." }, 400);
        }

        const gate = await servableSnapshot();
        if ("error" in gate) return json(apiReply(503, gate.error));
        const account = gate.snapshot.byAuthIndex.get(authIndex);
        if (!account) {
          return json(apiReply(404, "Unknown or stale hub account. Read auth-files again."));
        }
        // Magpie's own read of this account failed. Its old windows (as of
        // readAt) are still served, but no longer than the hub serves a stale
        // snapshot; without a readAt their age is unknown.
        const accountError = optionString(account.quota.error);
        if (
          accountError &&
          (optionString(account.quota.readAt) === undefined ||
            isExpired(account.referenceAt, true))
        ) {
          return json(apiReply(503, `Magpie could not read this account: ${accountError}`));
        }

        const reply = usageFor(account, upstreamUrl);
        return json(reply);
      }

      if (request.method === "POST" && path === "/v0/management/reset-quota") {
        // T3 Code only calls this after redeeming a reset credit. The hub
        // advertises none, but answer cleanly for CLIProxyAPI compatibility.
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/v1/hub/status") {
        const current = await snapshotOrUnavailable();
        if (!current) {
          return json(
            {
              error: "Magpie's quota API is unavailable.",
              lastError: quotaSource.lastError ?? null,
              cachedAt: quotaSource.cached
                ? new Date(quotaSource.cached.fetchedAt).toISOString()
                : null,
            },
            503,
          );
        }
        return json({
          fetchedAt: new Date(current.fetchedAt).toISOString(),
          stale: current.stale,
          staleForMs: staleForMs(current),
          expired: isExpired(current.fetchedAt, current.stale),
          maxStaleMs: config.maxStaleMs,
          lastOkAt: quotaSource.lastOkAt !== undefined ? new Date(quotaSource.lastOkAt).toISOString() : null,
          lastError: quotaSource.lastError ?? null,
          upstream: {
            url: config.magpieQuotaUrl,
            accounts: current.upstream.data.length,
          },
          accounts: current.accounts.map((account) => ({
            id: account.key,
            authIndex: account.authFile.auth_index,
            cliproxyProvider: account.authFile.provider,
            sourceProvider: account.quota.provider,
            name: accountDisplayName(account.quota),
            user: typeof account.quota.user === "string" ? account.quota.user : null,
            plan: typeof account.quota.plan === "string" ? account.quota.plan : null,
            disabled: account.authFile.disabled === true,
            windows: usableWindows(account.quota).map((window) => {
              const used = windowUsed(window);
              return {
                name: windowName(window),
                used: used === undefined ? null : clampPercent(used),
                remaining: typeof window.remaining === "number" ? window.remaining : null,
                resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
              };
            }),
          })),
        });
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected hub error.";
      if (status >= 500) logger.error(`${request.method} ${path}: ${message}`);
      return json({ error: message }, status);
    }
  };

  let ownedServer: BunServer | undefined;
  let ownsStatus = false;
  let stopped = false;
  let takeoverTimer: ReturnType<typeof setInterval> | undefined;

  let stopPromise: Promise<void> | undefined;
  function handleStop(): Promise<void> {
    stopPromise ??= (async () => {
      stopped = true;
      if (takeoverTimer) {
        clearInterval(takeoverTimer);
        takeoverTimer = undefined;
      }
      try {
        await ownedServer?.stop(true);
      } finally {
        if (ownsStatus) removeHubStatus(config.dataDir);
      }
    })();
    return stopPromise;
  }

  const handle: HubHandle = {
    server: null,
    port: config.port,
    url: clientUrl(config.host, config.port),
    config,
    stop: handleStop,
  };

  function serve(): BunServer {
    return Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: handler,
      error: (error) => {
        logger.error(`Unhandled request error: ${error instanceof Error ? error.message : String(error)}`);
        return json({ error: "internal hub error" }, 500);
      },
    });
  }

  function startOwned(server: BunServer): void {
    if (stopped) {
      void server.stop(true);
      return;
    }
    if (takeoverTimer) {
      clearInterval(takeoverTimer);
      takeoverTimer = undefined;
    }
    ownedServer = server;
    const actualPort = server.port ?? config.port;
    const actualHost = config.host;
    handle.server = server;
    handle.port = actualPort;
    handle.url = clientUrl(actualHost, actualPort);
    writeHubStatus(config.dataDir, {
      version: config.version,
      host: actualHost,
      port: actualPort,
      magpieQuotaUrl: config.magpieQuotaUrl,
      tokenPath: config.tokenPath,
      startedAt,
    });
    ownsStatus = true;

    logger.info(
      `listening on ${handle.url} · Magpie ${config.magpieQuotaUrl} · management key ${
        config.tokenPath ?? "from option/environment"
      }`,
    );
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    if (!loopbackHosts.has(actualHost)) {
      logger.warn(`bound to ${actualHost}; the hub is reachable beyond loopback and still requires its token`);
    }

    // Warm the cache so /readyz is meaningful before T3's first request.
    // QuotaSource throttles its own failure log.
    void quotaSource.read().catch(() => {});
  }

  let takeoverWarned = false;

  async function takeOver(): Promise<void> {
    if (stopped || ownedServer) return;
    let occupied: boolean;
    try {
      occupied = await existingHub(config);
      if (stopped) return;
    } catch (error) {
      if (stopped) return;
      // Keep watching, but do not log the same config conflict every 2 s.
      if (!takeoverWarned) {
        takeoverWarned = true;
        logger.warn(
          `not taking over ${clientUrl(config.host, config.port)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }
    if (occupied) {
      takeoverWarned = false;
      return;
    }
    let server: BunServer;
    try {
      server = serve();
    } catch {
      // Another follower won the race, or the port is still occupied.
      return;
    }
    startOwned(server);
    if (handle.server === server) {
      logger.info(`the previous hub on ${clientUrl(config.host, config.port)} is gone; took over`);
    }
  }

  /**
   * A borrowed hub is not ours: the host that owns the port may be a
   * short-lived Magpie CLI host. Keep watching and bind as soon as it exits,
   * otherwise the hub would disappear with the owner.
   */
  function watchBorrowed(): void {
    if (takeoverTimer) return;
    const timer = setInterval(() => {
      void takeOver().catch((error) => {
        logger.warn(`takeover check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 2_000);
    // A temporary CLI host must still be able to exit while another hub runs;
    // a standalone process opts in to staying alive as a takeover standby.
    if (!options.keepAliveOnBorrow) timer.unref?.();
    takeoverTimer = timer;
  }

  let lastError: unknown;
  // Re-probe on every failed bind, because a busy owner may miss one probe's
  // timeout, but only within a time budget: an unrelated process that accepts
  // TCP and never answers HTTP must not stretch startup indefinitely.
  const probeDeadline = Date.now() + PROBE_BUDGET_MS;
  let probes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let server: BunServer;
    try {
      server = serve();
    } catch (error) {
      lastError = error;
      if (probes < MAX_PROBES && Date.now() < probeDeadline) {
        probes += 1;
        // A second Magpie plugin host (the CLI's temporary host, or a reload
        // overlap) can race us for the port. Reuse the owner and watch it.
        if (await existingHub(config)) {
          logger.info(`a hub is already listening on ${clientUrl(config.host, config.port)}; reusing it`);
          watchBorrowed();
          return handle;
        }
      }
      if (attempt < 3) await Bun.sleep(200);
      continue;
    }
    startOwned(server);
    return handle;
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Could not listen on ${config.host}:${config.port} (${detail}). ` +
      "Check MAGPIE_T3CODE_HUB_PORT or stop the process using that port.",
  );
}

interface HubSingleton {
  handle?: HubHandle;
  options?: StartHubOptions;
  config?: HubConfig;
  queue: Promise<void>;
}

const SINGLETON_KEY = Symbol.for("magpie-t3code-hub.singleton");
const singleton = (((globalThis as { [key: symbol]: unknown })[SINGLETON_KEY] ??= {
  queue: Promise.resolve(),
}) as HubSingleton);

/**
 * Resolves and validates options (URL, token, numeric ranges) once, without
 * binding a port. The returned config can be handed to `startHub` so a reload
 * does not read the token/package metadata twice.
 */
export async function validateHubOptions(options: StartHubOptions = {}): Promise<HubConfig> {
  return resolveConfig(options);
}

/**
 * Starts a hub and replaces the one this process started before it, if any.
 * Calls are serialized. Validation happens before the old listener is stopped,
 * and a failed start rolls the previous configuration back.
 *
 * The singleton lives on globalThis: Magpie can re-import the plugin module,
 * and a fresh module instance must still stop the old listener.
 */
export function ensureHub(options: StartHubOptions = {}): Promise<HubHandle> {
  const run = async (): Promise<HubHandle> => {
    const config = await validateHubOptions(options);
    const previous = singleton.handle;
    const previousOptions = singleton.options;
    const previousConfig = singleton.config;
    await stopActiveHub();
    try {
      const handle = await startHub(options, config);
      singleton.handle = handle;
      singleton.options = { ...options };
      singleton.config = config;
      return handle;
    } catch (error) {
      if (previous && previousOptions) {
        try {
          const restored = await startHub(previousOptions, previousConfig);
          singleton.handle = restored;
          singleton.options = previousOptions;
          singleton.config = previousConfig;
          // The old listener is back; the new config's error still reaches
          // the caller, so Magpie can show why the reload failed.
        } catch {
          singleton.handle = undefined;
          singleton.options = undefined;
          singleton.config = undefined;
        }
      }
      throw error;
    }
  };
  const result = singleton.queue.then(run, run);
  singleton.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function stopActiveHub(): Promise<void> {
  const handle = singleton.handle;
  singleton.handle = undefined;
  singleton.options = undefined;
  singleton.config = undefined;
  await handle?.stop();
}
