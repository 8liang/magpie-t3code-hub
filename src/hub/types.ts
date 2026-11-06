/**
 * Shared types for the Magpie → T3 Code quota hub.
 *
 * The wire shapes fall into three groups:
 * - Magpie `/v1/magpie/quotas` (source)
 * - CLIProxyAPI management API consumed by T3 Code (hub surface)
 * - provider-native usage replies that T3 Code's cliproxy adapter parses
 */

/** One quota window as Magpie reports it. `used` is a 0-100 percentage. */
export interface MagpieQuotaWindow {
  name: string;
  used?: number;
  remaining?: number;
  resetsAt?: string;
  resetSecs?: number;
  display?: string;
  amount?: number;
  limit?: number;
  unit?: string;
  holdsWhy?: string;
  text?: boolean;
  family?: string;
  pool?: string;
  runsOutAt?: string;
  runsOut?: number;
  aside?: boolean;
}

/** One account in Magpie's quota list. */
export interface MagpieQuotaAccount {
  provider: string;
  name: string;
  kind?: string;
  plan?: string;
  user?: string;
  windows?: MagpieQuotaWindow[];
  readAt?: string;
  error?: string;
  lapsed?: string;
  resets?: {
    count?: number;
    until?: string;
    each?: Array<{ until?: string; id?: string }>;
  };
  last?: boolean;
  lastServedAt?: string;
  until?: string;
  [key: string]: unknown;
}

export interface MagpieQuotaResponse {
  object?: string;
  data: MagpieQuotaAccount[];
}

/** CLIProxyAPI management `auth-files` entry, as parsed by T3 Code. */
export interface CliproxyAuthFile {
  id: string;
  auth_index: string;
  provider: "claude" | "codex";
  email?: string;
  disabled?: boolean;
  id_token?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    plan_type?: string;
  };
}

export interface CliproxyAuthFilesResponse {
  files: CliproxyAuthFile[];
}

/** CLIProxyAPI management `api-call` request. */
export interface CliproxyApiCallRequest {
  auth_index?: string;
  method?: string;
  url?: string;
  header?: Record<string, string>;
  data?: unknown;
}

export interface CliproxyApiCallResponse {
  status_code: number;
  body: string;
}

/** Anthropic OAuth usage reply, the subset T3 Code parses. */
export interface ClaudeUsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ClaudeUsageLimit {
  kind: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string } } | null;
}

export interface ClaudeUsage {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  limits?: ClaudeUsageLimit[];
  spend?: unknown;
  extra_usage?: unknown;
}

/** Codex ChatGPT usage reply, the subset T3 Code parses. */
export interface CodexUsageWindow {
  used_percent: number;
  reset_at?: number | null;
  limit_window_seconds?: number;
}

export interface CodexUsage {
  plan_type?: string;
  rate_limit: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  } | null;
}

/** A Magpie quota account plus the auth-file projection T3 Code sees. */
export interface HubAccount {
  key: string;
  /** When Magpie read this account's quota; used for resetSecs countdowns. */
  referenceAt: number;
  authFile: CliproxyAuthFile;
  quota: MagpieQuotaAccount;
  /** Non-native accounts drawn as scoped rows of this Claude account. */
  riders?: HubAccount[];
  /** Key of the account that carries this one (it is hidden from T3 itself). */
  carriedBy?: string;
}

export interface HubSnapshot {
  fetchedAt: number;
  stale: boolean;
  accounts: HubAccount[];
  byAuthIndex: Map<string, HubAccount>;
  upstream: MagpieQuotaResponse;
}

export interface HubConfig {
  version: string;
  host: string;
  port: number;
  magpieQuotaUrl: string;
  magpieManagementKey?: string;
  managementKey: string;
  dataDir: string;
  tokenPath?: string;
  fetchTimeoutMs: number;
  cacheTtlMs: number;
  /** After this long, a stale snapshot is no longer served as current usage. */
  maxStaleMs: number;
  backoffMs: number;
}

export interface HubLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Injectable quota reader, used by tests and the standalone server. */
export type QuotaFetcher = () => Promise<MagpieQuotaResponse>;
