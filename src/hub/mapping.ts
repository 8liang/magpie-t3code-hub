import { createHash } from "node:crypto";
import { apiReply } from "./replies";
import type {
  ClaudeUsage,
  ClaudeUsageLimit,
  CliproxyApiCallResponse,
  CliproxyAuthFile,
  CodexUsage,
  CodexUsageWindow,
  HubAccount,
  HubSnapshot,
  MagpieQuotaAccount,
  MagpieQuotaResponse,
  MagpieQuotaWindow,
} from "./types";

const SESSION_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Exact names Magpie uses for the all-models Claude/Codex buckets. */
function canonicalSessionName(name: string): boolean {
  return /^(5[\s-]*h(our)?s?|session)$/i.test(name.trim());
}

function canonicalWeekName(name: string): boolean {
  return /^(7[\s-]*d(ay)?s?|week(ly)?)$/i.test(name.trim());
}

/** Generic names a Codex account may use instead of 5h/7d, never model scopes. */
const GENERIC_PRIMARY_NAME = /^(primary|main|default)$/i;
const GENERIC_SECONDARY_NAME = /^(secondary|backup)$/i;

/** Magpie providers that T3 Code's cliproxy adapter knows natively. */
function isNativeProvider(provider: string): provider is "claude" | "codex" {
  return provider === "claude" || provider === "codex";
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Windows are expected to be an array, but the wire is untrusted. */
export function accountWindows(account: MagpieQuotaAccount): MagpieQuotaWindow[] {
  return Array.isArray(account.windows)
    ? account.windows.filter(
        (window): window is MagpieQuotaWindow => typeof window === "object" && window !== null,
      )
    : [];
}

/** Text windows are informational notes ("+$183.36 on us"), never quota bars. */
export function usableWindows(account: MagpieQuotaAccount): MagpieQuotaWindow[] {
  return accountWindows(account).filter(
    (window) => window.text !== true && windowUsed(window) !== undefined,
  );
}

/**
 * Magpie normally reports `used`, but some balance/credit providers only send
 * `remaining` or `amount` + `limit`. Derive the percentage rather than
 * dropping the window (and disabling the account).
 */
export function windowUsed(window: MagpieQuotaWindow): number | undefined {
  if (typeof window.used === "number" && Number.isFinite(window.used)) return window.used;
  if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
    return 100 - window.remaining;
  }
  if (
    typeof window.amount === "number" &&
    Number.isFinite(window.amount) &&
    typeof window.limit === "number" &&
    Number.isFinite(window.limit) &&
    window.limit > 0
  ) {
    return (window.amount / window.limit) * 100;
  }
  return undefined;
}

/** Window names are expected but not guaranteed by the wire. */
export function windowName(window: MagpieQuotaWindow): string {
  return typeof window.name === "string" && window.name.trim() ? window.name.trim() : "Quota";
}

/** T3 Code requires 0..100; Magpie already reports percentages. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * One source of truth for reset times: an absolute resetsAt wins, otherwise
 * resetSecs counts from the snapshot's reference time (never from "now").
 */
function resetAtMs(window: MagpieQuotaWindow, referenceMs: number): number | null {
  if (typeof window.resetsAt === "string" && window.resetsAt.length > 0) {
    const parsed = Date.parse(window.resetsAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (
    typeof window.resetSecs === "number" &&
    Number.isFinite(window.resetSecs) &&
    window.resetSecs > 0
  ) {
    return referenceMs + window.resetSecs * 1000;
  }
  return null;
}

function isoReset(window: MagpieQuotaWindow, referenceMs: number): string | null {
  const ms = resetAtMs(window, referenceMs);
  return ms === null ? null : new Date(ms).toISOString();
}

function epochSeconds(window: MagpieQuotaWindow, referenceMs: number): number | null {
  const ms = resetAtMs(window, referenceMs);
  return ms === null ? null : Math.floor(ms / 1000);
}

function windowLabel(account: MagpieQuotaAccount, window: MagpieQuotaWindow): string {
  const name = windowName(window);
  const base = `${accountDisplayName(account)} · ${name}`;
  return typeof window.pool === "string" && window.pool.trim() ? `${base} (${window.pool})` : base;
}

function uniqueLabel(base: string, seen: Set<string>): string {
  let label = base;
  let suffix = 2;
  while (seen.has(label)) {
    label = `${base} #${suffix}`;
    suffix += 1;
  }
  seen.add(label);
  return label;
}

/**
 * T3 Code's Claude adapter treats every `weekly_scoped` limit as a weekly bar.
 * That is the only bucket that can carry an arbitrary number of Magpie
 * windows, so non-Claude/Codex accounts use it for every window.
 */
export function claudeUsageFor(
  account: HubAccount,
  referenceMs = account.referenceAt,
): ClaudeUsage {
  const quota = account.quota;
  const native = isNativeProvider(quota.provider);
  const usage: ClaudeUsage = { five_hour: null, seven_day: null, limits: [] };
  const seen = new Set<string>();
  const limits: ClaudeUsageLimit[] = [];
  const windows = usableWindows(quota);
  // Only the exact all-models windows become five_hour/seven_day. A window
  // such as "Weekly Opus" is model-scoped and must stay a separate limit
  // instead of overwriting the account-wide weekly number.
  const session = native
    ? windows.find((window) => canonicalSessionName(windowName(window)))
    : undefined;
  const week = native ? windows.find((window) => canonicalWeekName(windowName(window))) : undefined;

  for (const window of windows) {
    const used = clampPercent(windowUsed(window) as number);
    const resetsAt = isoReset(window, referenceMs);

    if (window === session) {
      usage.five_hour = { utilization: used, resets_at: resetsAt };
      continue;
    }
    if (window === week) {
      usage.seven_day = { utilization: used, resets_at: resetsAt };
      continue;
    }

    const label = uniqueLabel(native ? windowName(window) : windowLabel(quota, window), seen);
    limits.push({
      kind: "weekly_scoped",
      percent: used,
      resets_at: resetsAt,
      scope: { model: { display_name: label } },
    });
  }

  usage.limits = limits;
  return usage;
}

function codexWindow(
  window: MagpieQuotaWindow | undefined,
  limitWindowSeconds: number,
  referenceMs: number,
): CodexUsageWindow | null {
  if (!window) return null;
  const used = windowUsed(window);
  if (used === undefined) return null;
  return {
    used_percent: clampPercent(used),
    reset_at: epochSeconds(window, referenceMs),
    limit_window_seconds: limitWindowSeconds,
  };
}

/** Codex only has two buckets; Magpie's Codex accounts always report 5h and 7d. */
function codexBars(quota: MagpieQuotaAccount): {
  session?: MagpieQuotaWindow;
  week?: MagpieQuotaWindow;
} {
  const windows = usableWindows(quota);
  // Exact account-wide names first. The generic primary/secondary fallback
  // exists for older Magpie shapes, but never treats a model-scoped name
  // ("GPT-5 Hours Mini", "Session (codex-mini)") as the account-wide bar.
  const session =
    windows.find((window) => canonicalSessionName(windowName(window))) ??
    windows.find((window) => GENERIC_PRIMARY_NAME.test(windowName(window)));
  const week =
    windows.find((window) => canonicalWeekName(windowName(window))) ??
    windows.find(
      (window) => window !== session && GENERIC_SECONDARY_NAME.test(windowName(window)),
    );
  return { session, week };
}

export function codexUsageFor(
  account: HubAccount,
  referenceMs = account.referenceAt,
): CodexUsage {
  const { session, week } = codexBars(account.quota);
  const plan = typeof account.quota.plan === "string" ? account.quota.plan.trim() : "";
  return {
    ...(plan ? { plan_type: plan } : {}),
    rate_limit: {
      primary_window: codexWindow(session, SESSION_SECONDS, referenceMs),
      secondary_window: codexWindow(week, WEEK_SECONDS, referenceMs),
    },
  };
}

/**
 * T3 Code sends the provider's native quota URL through `api-call` and parses
 * the reply itself. We answer in the provider's shape, using Magpie data.
 */
export function usageFor(account: HubAccount, url: string): CliproxyApiCallResponse {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return apiReply(400, "The api-call URL is not valid.");
  }

  // A stale snapshot must keep counting down from when Magpie read it, not
  // from this request; otherwise resetSecs would slide forward on every poll.
  const referenceMs = account.referenceAt;
  const provider = account.authFile.provider;

  // One table drives both the reply shape and the provider gate, so adding a
  // route cannot leave the gate behind.
  type Route = { provider: "claude" | "codex"; reply: () => CliproxyApiCallResponse };
  let route: Route | undefined;

  if (parsed.hostname === "api.anthropic.com" && parsed.pathname === "/api/oauth/usage") {
    route = {
      provider: "claude",
      reply: () => ({
        status_code: 200,
        body: JSON.stringify(claudeUsageFor(account, referenceMs)),
      }),
    };
  } else if (parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/wham/usage") {
    route = {
      provider: "codex",
      reply: () => ({
        status_code: 200,
        body: JSON.stringify(codexUsageFor(account, referenceMs)),
      }),
    };
  } else if (
    parsed.hostname === "chatgpt.com" &&
    parsed.pathname === "/backend-api/wham/rate-limit-reset-credits"
  ) {
    route = {
      provider: "codex",
      reply: () => ({ status_code: 200, body: JSON.stringify({ credits: [] }) }),
    };
  }

  if (!route) {
    return apiReply(400, `Unsupported usage URL: ${parsed.hostname}${parsed.pathname}`);
  }
  if (provider !== route.provider) {
    return apiReply(
      400,
      `This usage URL is for ${route.provider} accounts; this account is ${provider}.`,
    );
  }
  return route.reply();
}

function accountFingerprint(account: MagpieQuotaAccount): string {
  const fields = [
    account.provider,
    typeof account.name === "string" ? account.name : "",
    typeof account.user === "string" ? account.user : "",
    typeof account.plan === "string" ? account.plan : "",
    typeof account.kind === "string" ? account.kind : "",
  ];
  return stableHash(fields.join("\u0000")).slice(0, 8);
}

export function accountDisplayName(account: MagpieQuotaAccount): string {
  return typeof account.name === "string" && account.name.trim() ? account.name.trim() : account.provider;
}

function accountKey(account: MagpieQuotaAccount): string {
  const user = typeof account.user === "string" ? account.user.trim() : "";
  if (user) return `${account.provider}/${user}`;
  const name = typeof account.name === "string" ? account.name.trim() : "";
  return name ? `${account.provider}/${name}` : `${account.provider}/~${accountFingerprint(account)}`;
}

function accountReference(account: MagpieQuotaAccount, fallbackMs: number): number {
  if (typeof account.readAt === "string") {
    const parsed = Date.parse(account.readAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

/**
 * auth_index comes from the account's own identity (base key + stable fields),
 * never from whether a sibling with the same base key exists. Adding a second
 * account for the same user must not re-index the first one.
 */
function identityIndex(account: MagpieQuotaAccount, base: string): string {
  return stableHash(`${base}\u0000${accountFingerprint(account)}`);
}

function authFileFor(account: MagpieQuotaAccount, key: string, base: string): CliproxyAuthFile {
  const native = isNativeProvider(account.provider);
  const authIndex = identityIndex(account, base);
  const user = typeof account.user === "string" ? account.user.trim() : "";
  const name = accountDisplayName(account);
  const label = user ? `${name} · ${user}` : name;
  const bars = account.provider === "codex" ? codexBars(account) : undefined;
  const hasWindows = bars
    ? Boolean(bars.session || bars.week)
    : usableWindows(account).length > 0;
  const wasDisabled = Boolean(account.lapsed) || !hasWindows;

  const cliproxyProvider: "claude" | "codex" = account.provider === "codex" ? "codex" : "claude";
  const file: CliproxyAuthFile = {
    id: key,
    auth_index: authIndex,
    // T3 Code only reads accounts whose provider is `claude` or `codex`.
    // Everything else rides the Claude adapter so it can show many windows.
    provider: cliproxyProvider,
    disabled: wasDisabled,
  };

  if (native) {
    if (user) file.email = user;
  } else {
    file.email = label;
  }

  if (account.provider === "codex" && typeof account.plan === "string" && account.plan.trim()) {
    file.id_token = {
      plan_type: account.plan.trim(),
      chatgpt_plan_type: account.plan.trim(),
    };
  }

  return file;
}

export function buildSnapshot(
  upstream: MagpieQuotaResponse,
  options: { fetchedAt?: number; stale?: boolean } = {},
): HubSnapshot {
  const fetchedAt = options.fetchedAt ?? Date.now();
  const accounts: HubAccount[] = [];
  const byAuthIndex = new Map<string, HubAccount>();
  const seenKeys = new Set<string>();

  const candidates: Array<{ quota: MagpieQuotaAccount; base: string }> = [];
  for (const quota of upstream.data ?? []) {
    if (!quota || typeof quota.provider !== "string") continue;
    candidates.push({ quota, base: accountKey(quota) });
  }

  const baseCounts = new Map<string, number>();
  for (const { base } of candidates) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);

  for (const { quota, base } of candidates) {
    // A duplicate base key gets a fingerprint of stable account fields, not
    // its list position, so auth_index survives reordering by Magpie.
    let key = (baseCounts.get(base) ?? 0) > 1 ? `${base}~${accountFingerprint(quota)}` : base;
    if (seenKeys.has(key)) {
      let suffix = 2;
      while (seenKeys.has(`${key}#${suffix}`)) suffix += 1;
      key = `${key}#${suffix}`;
    }
    seenKeys.add(key);

    const authFile = authFileFor(quota, key, base);
    let authIndex = authFile.auth_index;
    let suffix = 2;
    while (byAuthIndex.has(authIndex)) {
      authIndex = stableHash(`${key}:${suffix}`);
      suffix += 1;
    }
    authFile.auth_index = authIndex;

    const account: HubAccount = {
      key,
      referenceAt: accountReference(quota, fetchedAt),
      authFile,
      quota,
    };
    accounts.push(account);
    byAuthIndex.set(authIndex, account);
  }

  return {
    fetchedAt,
    stale: options.stale ?? false,
    accounts,
    byAuthIndex,
    upstream,
  };
}

export function authFiles(snapshot: HubSnapshot): CliproxyAuthFile[] {
  return snapshot.accounts.map((account) => account.authFile);
}
