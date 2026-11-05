import type { HubLogger, MagpieQuotaResponse, QuotaFetcher } from "./types";

/** Magpie could not be read and there is no snapshot to serve. */
export class QuotaUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "QuotaUnavailableError";
  }
}

export interface QuotaSourceOptions {
  url: string;
  managementKey?: string;
  timeoutMs: number;
  cacheTtlMs: number;
  /** How long to fail fast after an upstream error before trying again. */
  backoffMs?: number;
  fetchQuotas?: QuotaFetcher;
  logger: HubLogger;
  now?: () => number;
}

export interface QuotaResult {
  upstream: MagpieQuotaResponse;
  fetchedAt: number;
  /** True when a fresh read failed and the last good value was served. */
  stale: boolean;
}

/**
 * Reads Magpie's quota HTTP API and keeps a short-lived cache. T3 Code probes
 * every account concurrently; one Magpie read serves the whole probe.
 */
export class QuotaSource {
  readonly #options: QuotaSourceOptions;
  #cached?: QuotaResult;
  #inflight?: Promise<QuotaResult>;
  // -Infinity so the first failure is always logged, whatever the clock.
  #lastErrorLogAt = Number.NEGATIVE_INFINITY;
  #lastError?: string;
  #lastOkAt?: number;
  #backoffUntil = 0;

  constructor(options: QuotaSourceOptions) {
    this.#options = options;
  }

  get cached(): QuotaResult | undefined {
    return this.#cached;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get lastOkAt(): number | undefined {
    return this.#lastOkAt;
  }

  async read(): Promise<QuotaResult> {
    const now = this.#options.now ?? Date.now;
    const cached = this.#cached;

    if (cached?.stale && now() < this.#backoffUntil) return cached;
    if (cached && !cached.stale && now() - cached.fetchedAt < this.#options.cacheTtlMs) return cached;
    if (!cached && now() < this.#backoffUntil) {
      throw new QuotaUnavailableError(
        this.#lastError ?? "Magpie's quota API is backing off after an error.",
      );
    }
    if (this.#inflight) return this.#inflight;

    const task = this.#fetch(now)
      .then((result) => {
        this.#cached = result;
        this.#lastOkAt = result.fetchedAt;
        this.#lastError = undefined;
        this.#backoffUntil = 0;
        return result;
      })
      .catch((error: unknown) => {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#backoffUntil = now() + (this.#options.backoffMs ?? 10_000);
        if (cached) {
          // Keep serving the last good snapshot and mark it stale so
          // /healthz and /v1/hub/status tell the truth.
          const stale = { ...cached, stale: true };
          this.#cached = stale;
          this.#logFailure(error, "serving the last good Magpie snapshot");
          return stale;
        }
        this.#logFailure(error, "no snapshot to serve");
        throw new QuotaUnavailableError(
          this.#lastError ?? "Magpie's quota API is unavailable.",
        );
      })
      .finally(() => {
        this.#inflight = undefined;
      });

    this.#inflight = task;
    return task;
  }

  async #fetch(now: () => number): Promise<QuotaResult> {
    const upstream = this.#options.fetchQuotas
      ? await this.#options.fetchQuotas()
      : await this.#fetchHttp();

    if (!upstream || !Array.isArray(upstream.data)) {
      throw new Error("Magpie's quota reply has no account list.");
    }

    // Timestamp after the read completes: a slow but successful Magpie call
    // must not look old the moment it arrives.
    return { upstream, fetchedAt: now(), stale: false };
  }

  async #fetchHttp(): Promise<MagpieQuotaResponse> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#options.managementKey) {
      headers.authorization = `Bearer ${this.#options.managementKey}`;
    }

    const response = await fetch(this.#options.url, {
      headers,
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    });
    if (!response.ok) {
      const detail = response.status === 401 || response.status === 403 ? " (set a Magpie gateway key)" : "";
      throw new Error(`Magpie's quota API answered HTTP ${response.status}${detail}.`);
    }
    return (await response.json()) as MagpieQuotaResponse;
  }

  #logFailure(error: unknown, note: string): void {
    const now = (this.#options.now ?? Date.now)();
    // One warning a minute is enough: T3 Code polls the hub continuously.
    if (now - this.#lastErrorLogAt < 60_000) return;
    this.#lastErrorLogAt = now;
    const message = error instanceof Error ? error.message : String(error);
    this.#options.logger.warn(`Magpie quota read failed: ${message} — ${note}.`);
  }
}
