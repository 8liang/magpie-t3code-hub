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

/**
 * The window that limits a non-native account first: the one with the
 * highest usage (ties keep Magpie's order).
 */
export function headlineWindow(account: MagpieQuotaAccount): MagpieQuotaWindow | undefined {
  let best: MagpieQuotaWindow | undefined;
  let bestUsed = -Infinity;
  for (const window of usableWindows(account)) {
    const used = windowUsed(window) as number;
    if (used > bestUsed) {
      best = window;
      bestUsed = used;
    }
  }
  return best;
}

/** T3 Code's row id for a scoped limit (`seven_day_<slug>`); labels must differ here. */
function scopedSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function uniqueScopedLabel(base: string, seenSlugs: Set<string>): string {
  let label = base;
  let suffix = 2;
  while (seenSlugs.has(scopedSlug(label))) {
    label = `${base} #${suffix}`;
    suffix += 1;
  }
  seenSlugs.add(scopedSlug(label));
  return label;
}

/**
 * Row name for a carried account: the provider name, plus the user when the
 * same provider has several carried accounts.
 */
function riderLabel(rider: MagpieQuotaAccount, sameNameCount: number): string {
  const name = accountDisplayName(rider);
  const user = typeof rider.user === "string" ? rider.user.trim() : "";
  return sameNameCount > 1 && user ? `${name} · ${user}` : name;
}

/**
 * T3 Code lays a driver's accounts out as grid columns (one per account) and
 * each window id as a row. A bar fills the row only when the pool has a
 * single account, so every non-native account rides on one Claude account
 * (`HubAccount.riders`) as a `weekly_scoped` row: one row per provider, its
 * tightest window. The carrier's own windows map to five_hour/seven_day.
 *
 * `include` lets the server drop riders whose Magpie read failed too long ago.
 */
export function claudeUsageFor(
  account: HubAccount,
  referenceMs = account.referenceAt,
  include: (rider: HubAccount) => boolean = () => true,
): ClaudeUsage {
  const usage: ClaudeUsage = { five_hour: null, seven_day: null, limits: [] };
  const seenSlugs = new Set<string>();
  const limits: ClaudeUsageLimit[] = [];
  const quota = account.quota;

  if (isNativeProvider(quota.provider)) {
    const windows = usableWindows(quota);
    // Only the exact all-models windows become five_hour/seven_day. A window
    // such as "Weekly Opus" is model-scoped and must stay a separate limit
    // instead of overwriting the account-wide weekly number.
    const session = windows.find((window) => canonicalSessionName(windowName(window)));
    const week = windows.find((window) => canonicalWeekName(windowName(window)));
    for (const window of windows) {
      const used = clampPercent(windowUsed(window) as number);
      const resetsAt = isoReset(window, referenceMs);
      if (window === session) {
        usage.five_hour = { utilization: used, resets_at: resetsAt };
      } else if (window === week) {
        usage.seven_day = { utilization: used, resets_at: resetsAt };
      } else {
        limits.push({
          kind: "weekly_scoped",
          percent: used,
          resets_at: resetsAt,
          scope: { model: { display_name: uniqueScopedLabel(windowName(window), seenSlugs) } },
        });
      }
    }
  }

  const riders = (account.riders ?? []).filter(include);
  const nameCounts = new Map<string, number>();
  for (const rider of riders) {
    const name = accountDisplayName(rider.quota);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const rider of riders) {
    const headline = headlineWindow(rider.quota);
    if (!headline) continue;
    const label = riderLabel(rider.quota, nameCounts.get(accountDisplayName(rider.quota)) ?? 1);
    limits.push({
      kind: "weekly_scoped",
      percent: clampPercent(windowUsed(headline) as number),
      resets_at: isoReset(headline, rider.referenceAt),
      scope: { model: { display_name: uniqueScopedLabel(label, seenSlugs) } },
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
export function usageFor(
  account: HubAccount,
  url: string,
  includeRider: (rider: HubAccount) => boolean = () => true,
): CliproxyApiCallResponse {
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
        body: JSON.stringify(claudeUsageFor(account, referenceMs, includeRider)),
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

  // Native accounts keep the email so T3 merges them with its own sign-in.
  // Non-native accounts are carried by a Claude account and never shown.
  if (native && user) file.email = user;

  if (account.provider === "codex" && typeof account.plan === "string" && account.plan.trim()) {
    file.id_token = {
      plan_type: account.plan.trim(),
      chatgpt_plan_type: account.plan.trim(),
    };
  }

  return file;
}

const CARRIER_KEY = "magpie/providers";

/**
 * Hand every drawable non-native account to one synthetic Claude account,
 * "Magpie" (see claudeUsageFor). It has no email on purpose: T3 merges hub
 * accounts with its own sign-ins by driver+email and keeps only the copy it
 * checked last, so riders on the native Claude account vanished whenever
 * T3's own Claude reading was newer (docs/mapping.md). Carried accounts
 * stay in the snapshot (and /v1/hub/status) but are disabled for T3.
 */
function attachRiders(
  accounts: HubAccount[],
  byAuthIndex: Map<string, HubAccount>,
  fetchedAt: number,
): void {
  const riders = accounts.filter(
    (account) => !isNativeProvider(account.quota.provider) && !account.authFile.disabled,
  );
  if (riders.length === 0) return;

  let authIndex = stableHash(CARRIER_KEY);
  let suffix = 2;
  while (byAuthIndex.has(authIndex)) {
    authIndex = stableHash(`${CARRIER_KEY}:${suffix}`);
    suffix += 1;
  }
  const carrier: HubAccount = {
    key: CARRIER_KEY,
    referenceAt: fetchedAt,
    authFile: { id: "Magpie", auth_index: authIndex, provider: "claude", disabled: false },
    quota: { provider: "magpie", name: "Magpie", windows: [] },
  };
  accounts.push(carrier);
  byAuthIndex.set(authIndex, carrier);

  carrier.riders = riders;
  for (const rider of riders) {
    rider.carriedBy = carrier.key;
    rider.authFile.disabled = true;
  }
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

  attachRiders(accounts, byAuthIndex, fetchedAt);

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
