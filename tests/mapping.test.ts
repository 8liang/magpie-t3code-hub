import { describe, expect, test } from "bun:test";
import {
  authFiles,
  buildSnapshot,
  claudeUsageFor,
  codexUsageFor,
  usageFor,
} from "../src/hub/mapping";
import type { ClaudeUsage, CodexUsage } from "../src/hub/types";
import { fixture, NOW } from "./fixtures";

const snapshot = buildSnapshot(fixture, { fetchedAt: NOW });
const account = (key: string) => {
  const found = snapshot.accounts.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing fixture account ${key}`);
  return found;
};

describe("auth-files projection", () => {
  test("exposes native providers unchanged and puts the others on the Claude adapter", () => {
    const files = authFiles(snapshot);
    const byId = new Map(files.map((file) => [file.id, file]));

    const claude = byId.get("claude/claude@example.com");
    expect(claude?.provider).toBe("claude");
    expect(claude?.email).toBe("claude@example.com");
    expect(claude?.disabled).toBe(false);

    const codex = byId.get("codex/codex@example.com");
    expect(codex?.provider).toBe("codex");
    expect(codex?.id_token?.plan_type).toBe("plus");
    expect(codex?.id_token?.chatgpt_plan_type).toBe("plus");

    // Carried by the synthetic "Magpie" account, so hidden as its own column.
    const qoder = byId.get("qoder/qoder@example.com");
    expect(qoder?.provider).toBe("claude");
    expect(qoder?.email).toBeUndefined();
    expect(qoder?.disabled).toBe(true);
    expect(snapshot.accounts.find((entry) => entry.key === "qoder/qoder@example.com")?.carriedBy).toBe(
      "magpie/providers",
    );
    // The carrier has no email, so T3 never merges it with its own Claude
    // sign-in (a merge keeps only the newer copy and drops the riders).
    const carrier = byId.get("Magpie");
    expect(carrier?.provider).toBe("claude");
    expect(carrier?.email).toBeUndefined();
    expect(carrier?.disabled).toBe(false);
  });

  test("hides accounts T3 Code cannot draw: balances, empty windows and lapsed sign-ins", () => {
    const disabled = new Map(
      snapshot.accounts.map((entry) => [entry.key, entry.authFile.disabled]),
    );
    expect(disabled.get("deepseek/DeepSeek")).toBe(true);
    expect(disabled.get("opencode-zen-free/API key")).toBe(true);
    expect(disabled.get("workbuddy/lapsed@example.com")).toBe(true);
    // A stale snapshot with windows is still useful: carried, not dropped.
    const carrier = snapshot.accounts.find((entry) => entry.key === "magpie/providers");
    expect(carrier?.riders?.map((rider) => rider.key)).toEqual([
      "qoder/qoder@example.com",
      "workbuddy-ai/workbuddy@example.com",
      "cursor/cursor@example.com",
    ]);
  });

  test("auth indexes are stable, unique and round-trip through the snapshot", () => {
    const indexes = new Set(authFiles(snapshot).map((file) => file.auth_index));
    // Every Magpie account plus the synthetic carrier.
    expect(indexes.size).toBe(fixture.data.length + 1);
    for (const hubAccount of snapshot.accounts) {
      expect(snapshot.byAuthIndex.get(hubAccount.authFile.auth_index)).toBe(hubAccount);
    }
    const rebuilt = buildSnapshot(fixture, { fetchedAt: NOW });
    expect(authFiles(rebuilt).map((file) => file.auth_index)).toEqual(
      authFiles(snapshot).map((file) => file.auth_index),
    );
  });
});

describe("usage translation", () => {
  test("maps native Claude windows to five_hour, seven_day and scoped limits", () => {
    const usage = claudeUsageFor(account("claude/claude@example.com"), NOW) as ClaudeUsage;
    expect(usage.five_hour?.utilization).toBe(11);
    expect(usage.seven_day?.utilization).toBe(44);
    // Only its own scoped window: riders live on the Magpie carrier.
    expect(usage.limits).toHaveLength(1);
    const limit = usage.limits?.[0];
    expect(limit?.kind).toBe("weekly_scoped");
    expect(limit?.percent).toBe(7);
    expect(limit?.scope?.model?.display_name).toBe("Opus");
    expect(limit?.resets_at).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  test("the Magpie account carries one full-width row per provider", () => {
    const usage = claudeUsageFor(account("magpie/providers"), NOW) as ClaudeUsage;
    expect(usage.five_hour).toBeNull();
    expect(usage.seven_day).toBeNull();
    expect(usage.limits).toEqual([
      // Qoder's tightest window (Credits 49.5%), not the first one.
      {
        kind: "weekly_scoped",
        percent: 49.46666666666667,
        resets_at: "2026-11-24T13:33:18.000Z",
        scope: { model: { display_name: "Qoder" } },
      },
      {
        kind: "weekly_scoped",
        percent: 0.06,
        resets_at: null,
        scope: { model: { display_name: "WorkBuddy AI" } },
      },
      {
        kind: "weekly_scoped",
        percent: 81.344,
        resets_at: null,
        scope: { model: { display_name: "Cursor" } },
      },
    ]);
    // A rider the server considers unservable just loses its row.
    const filtered = claudeUsageFor(
      account("magpie/providers"),
      NOW,
      (rider) => rider.quota.provider !== "cursor",
    ) as ClaudeUsage;
    expect(filtered.limits?.map((limit) => limit.scope?.model?.display_name)).toEqual([
      "Qoder",
      "WorkBuddy AI",
    ]);
  });

  test("names rows by user when a provider has several accounts, with distinct row ids", () => {
    const make = (user: string) => ({
      provider: "qoder-cn",
      name: "Qoder CN",
      user,
      windows: [{ name: "Credits", used: 1 }],
    });
    const built = buildSnapshot(
      { data: [make("a@x.com"), make("a.x.com"), { provider: "cursor", name: "Cursor", windows: [{ name: "Total", used: 2 }] }] },
      { fetchedAt: NOW },
    );
    // A synthetic "Magpie" account carries them all.
    const visible = authFiles(built).filter((file) => !file.disabled);
    expect(visible).toEqual([
      expect.objectContaining({ id: "Magpie", provider: "claude", disabled: false }),
    ]);
    const carrier = built.byAuthIndex.get(visible[0]!.auth_index)!;
    const usage = claudeUsageFor(carrier, NOW) as ClaudeUsage;
    expect(usage.five_hour).toBeNull();
    expect(usage.seven_day).toBeNull();
    // "a@x.com" and "a.x.com" share T3's row slug, so the second gets "#2".
    expect(usage.limits?.map((limit) => limit.scope?.model?.display_name)).toEqual([
      "Qoder CN · a@x.com",
      "Qoder CN · a.x.com #2",
      "Cursor",
    ]);
  });

  test("keeps the account-wide weekly window when a model-scoped weekly window follows it", () => {
    const account: Parameters<typeof claudeUsageFor>[0] = {
      key: "claude/scoped@example.com",
      referenceAt: NOW,
      authFile: {
        id: "claude/scoped@example.com",
        auth_index: "x",
        provider: "claude",
        email: "scoped@example.com",
      },
      quota: {
        provider: "claude",
        name: "Claude Code",
        windows: [
          { name: "7 days", used: 44 },
          { name: "Weekly Opus", used: 90 },
        ],
      },
    };
    const usage = claudeUsageFor(account, NOW) as ClaudeUsage;
    expect(usage.seven_day?.utilization).toBe(44);
    expect(usage.limits).toHaveLength(1);
    expect(usage.limits?.[0]?.scope?.model?.display_name).toBe("Weekly Opus");
    expect(usage.limits?.[0]?.percent).toBe(90);
  });

  test("maps Codex 5h/7d to primary/secondary and keeps the plan", () => {
    const usage = codexUsageFor(account("codex/codex@example.com"), NOW) as CodexUsage;
    expect(usage.plan_type).toBe("plus");
    expect(usage.rate_limit?.primary_window?.used_percent).toBe(100);
    expect(usage.rate_limit?.primary_window?.limit_window_seconds).toBe(18_000);
    expect(usage.rate_limit?.primary_window?.reset_at).toBe(
      Math.floor(NOW / 1000) + 10_000,
    );
    expect(usage.rate_limit?.secondary_window?.used_percent).toBe(16);
    expect(usage.rate_limit?.secondary_window?.reset_at).toBe(
      Math.floor(Date.parse("2026-11-09T06:55:49Z") / 1000),
    );
  });

  test("puts a lone Codex weekly window in secondary instead of labelling it Session", () => {
    const lone: Parameters<typeof codexUsageFor>[0] = {
      key: "codex/lone@example.com",
      referenceAt: NOW,
      authFile: {
        id: "codex/lone@example.com",
        auth_index: "x",
        provider: "codex",
        email: "lone@example.com",
      },
      quota: {
        provider: "codex",
        name: "Codex",
        windows: [{ name: "7 days", used: 50 }],
      },
    };
    const usage = codexUsageFor(lone) as CodexUsage;
    expect(usage.rate_limit?.primary_window).toBeNull();
    expect(usage.rate_limit?.secondary_window?.used_percent).toBe(50);
    expect(usage.rate_limit?.secondary_window?.limit_window_seconds).toBe(604_800);
  });

  test("dispatches by the provider-native URL T3 Code sends", () => {
    const claude = account("claude/claude@example.com");
    const codex = account("codex/codex@example.com");

    const anthropic = usageFor(claude, "https://api.anthropic.com/api/oauth/usage");
    expect(anthropic.status_code).toBe(200);
    expect((JSON.parse(anthropic.body) as ClaudeUsage).five_hour?.utilization).toBe(11);

    const chatgpt = usageFor(codex, "https://chatgpt.com/backend-api/wham/usage");
    expect(chatgpt.status_code).toBe(200);
    expect((JSON.parse(chatgpt.body) as CodexUsage).plan_type).toBe("plus");

    const credits = usageFor(
      codex,
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    );
    expect(credits.status_code).toBe(200);
    expect(JSON.parse(credits.body)).toEqual({ credits: [] });

    const unknown = usageFor(codex, "https://example.com/usage");
    expect(unknown.status_code).toBe(400);
  });

  test("refuses a usage URL that belongs to the other provider", () => {
    const claude = account("claude/claude@example.com");
    const codex = account("codex/codex@example.com");
    expect(usageFor(codex, "https://api.anthropic.com/api/oauth/usage").status_code).toBe(400);
    expect(usageFor(claude, "https://chatgpt.com/backend-api/wham/usage").status_code).toBe(400);
    expect(
      usageFor(claude, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")
        .status_code,
    ).toBe(400);
  });

  test("text windows are notes, not quota bars", () => {
    const built = buildSnapshot(
      {
        data: [
          {
            provider: "claude",
            name: "Claude Code",
            user: "notes@example.com",
            windows: [
              { name: "5 hours", used: 10 },
              { name: "+$183.36 on us", text: true, used: 0 },
            ],
          },
          {
            provider: "qoder",
            name: "Qoder",
            user: "only-notes@example.com",
            windows: [{ name: "+$5 on us", text: true, used: 0 }],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const usage = claudeUsageFor(built.accounts[0]);
    expect(usage.five_hour?.utilization).toBe(10);
    expect(usage.limits).toEqual([]);
    expect(built.accounts[1].authFile.disabled).toBe(true);
  });

  test("counts resetSecs from the snapshot reference, not the api-call time", () => {
    const built = buildSnapshot(
      {
        data: [
          {
            provider: "claude",
            name: "Claude Code",
            user: "stable@example.com",
            readAt: "2026-11-05T09:00:00Z",
            windows: [{ name: "7 days", used: 10, resetSecs: 3_600 }],
          },
        ],
      },
      { fetchedAt: Date.parse("2026-11-05T09:00:01Z") },
    );
    const stable = built.accounts[0]!;
    const usage = claudeUsageFor(stable) as ClaudeUsage;
    expect(usage.seven_day?.resets_at).toBe("2026-11-05T10:00:00.000Z");

    // The same applies to Codex's reset_at, even if the api-call comes later.
    const codex = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "stable@example.com",
            readAt: "2026-11-05T09:00:00Z",
            windows: [{ name: "5 hours", used: 10, resetSecs: 3_600 }],
          },
        ],
      },
      { fetchedAt: Date.parse("2026-11-05T09:00:01Z") },
    ).accounts[0]!;
    const reply = usageFor(codex, "https://chatgpt.com/backend-api/wham/usage");
    const codexUsage = JSON.parse(reply.body) as CodexUsage;
    expect(codexUsage.rate_limit?.primary_window?.reset_at).toBe(
      Math.floor(Date.parse("2026-11-05T10:00:00Z") / 1000),
    );
  });

  test("tolerates windows without a usable name", () => {
    const built = buildSnapshot(
      {
        data: [
          {
            provider: "claude",
            name: "Claude Code",
            user: "noname@example.com",
            windows: [{ used: 30 } as any, { name: 123, used: 40 } as any],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const usage = claudeUsageFor(built.accounts[0]!, NOW) as ClaudeUsage;
    expect(usage.limits?.map((limit) => limit.scope?.model?.display_name)).toEqual([
      "Quota",
      "Quota #2",
    ]);
  });

  test("derives used from remaining or amount/limit for credit windows", () => {
    const built = buildSnapshot(
      {
        data: [
          {
            provider: "workbuddy-ai",
            name: "WorkBuddy AI",
            user: "credits@example.com",
            windows: [
              { name: "Credits", remaining: 53.5 },
              { name: "Extra", amount: 25, limit: 100 },
            ],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const credits = built.accounts[0]!;
    expect(credits.carriedBy).toBe("magpie/providers");
    const usage = claudeUsageFor(built.accounts.at(-1)!, NOW) as ClaudeUsage;
    // remaining 53.5 → 46.5 used; amount/limit 25% is lower, so Credits wins.
    expect(usage.limits?.[0]?.percent).toBe(46.5);
  });

  test("a new same-user account does not re-index the existing one", () => {
    const make = (plan: string) => ({
      provider: "claude",
      name: "Claude Code",
      user: "same@example.com",
      plan,
      windows: [{ name: "5 hours", used: 1 }],
    });
    const alone = buildSnapshot({ data: [make("pro")] }, { fetchedAt: NOW });
    const paired = buildSnapshot({ data: [make("pro"), make("max")] }, { fetchedAt: NOW });
    const pro = (snap: typeof alone) =>
      snap.accounts.find((entry) => entry.quota.plan === "pro")!.authFile.auth_index;
    expect(pro(paired)).toBe(pro(alone));
  });

  test("keeps duplicate-account auth indexes stable across reordering", () => {
    const make = (plan: string) => ({
      provider: "claude",
      name: "Claude Code",
      user: "same@example.com",
      plan,
      windows: [{ name: "5 hours", used: 1 }],
    });
    const first = buildSnapshot({ data: [make("pro"), make("max")] }, { fetchedAt: NOW });
    const second = buildSnapshot({ data: [make("max"), make("pro")] }, { fetchedAt: NOW });
    const indexFor = (snapshot: typeof first, plan: string) =>
      snapshot.accounts.find((entry) => entry.quota.plan === plan)?.authFile.auth_index;
    expect(indexFor(first, "pro")).toBe(indexFor(second, "pro"));
    expect(indexFor(first, "max")).toBe(indexFor(second, "max"));
    expect(indexFor(first, "pro")).not.toBe(indexFor(first, "max"));
  });

  test("tolerates a non-array windows field and null window entries", () => {
    const nonArray = buildSnapshot(
      {
        data: [
          {
            provider: "deepseek",
            name: "DeepSeek",
            windows: {} as any,
          },
        ],
      },
      { fetchedAt: NOW },
    );
    expect(nonArray.accounts).toHaveLength(1);
    expect(nonArray.accounts[0]?.authFile.disabled).toBe(true);

    const withNull = buildSnapshot(
      {
        data: [
          {
            provider: "workbuddy-ai",
            name: "WorkBuddy AI",
            user: "null@example.com",
            windows: [null, { name: "Credits", used: 5 }] as any,
          },
        ],
      },
      { fetchedAt: NOW },
    );
    expect(withNull.accounts[0]?.carriedBy).toBe("magpie/providers");
    const usage = claudeUsageFor(withNull.accounts.at(-1)!, NOW) as ClaudeUsage;
    expect(usage.limits?.[0]?.percent).toBe(5);
  });

  test("does not put non-Codex windows into primary/secondary", () => {
    const built = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "codex-credits@example.com",
            windows: [
              { name: "Weekly", used: 50 },
              { name: "Credits", used: 10 },
            ],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const usage = codexUsageFor(built.accounts[0]!, NOW) as CodexUsage;
    expect(usage.rate_limit?.primary_window).toBeNull();
    expect(usage.rate_limit?.secondary_window?.used_percent).toBe(50);

    const sessionOnly = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "codex-session@example.com",
            windows: [
              { name: "5 hours", used: 25 },
              { name: "Credits", used: 10 },
            ],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const sessionUsage = codexUsageFor(sessionOnly.accounts[0]!, NOW) as CodexUsage;
    expect(sessionUsage.rate_limit?.primary_window?.used_percent).toBe(25);
    expect(sessionUsage.rate_limit?.secondary_window).toBeNull();

    const modelScoped = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "codex-model-scoped@example.com",
            windows: [
              { name: "GPT-5 Hours Mini", used: 80 },
              { name: "Session (codex-mini)", used: 70 },
              { name: "Weekly", used: 50 },
            ],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const scopedUsage = codexUsageFor(modelScoped.accounts[0]!, NOW) as CodexUsage;
    expect(scopedUsage.rate_limit?.primary_window).toBeNull();
    expect(scopedUsage.rate_limit?.secondary_window?.used_percent).toBe(50);

    const generic = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "codex-generic@example.com",
            windows: [
              { name: "Primary", used: 40 },
              { name: "Secondary", used: 60 },
            ],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    const genericUsage = codexUsageFor(generic.accounts[0]!, NOW) as CodexUsage;
    expect(genericUsage.rate_limit?.primary_window?.used_percent).toBe(40);
    expect(genericUsage.rate_limit?.secondary_window?.used_percent).toBe(60);

    const creditsOnly = buildSnapshot(
      {
        data: [
          {
            provider: "codex",
            name: "Codex",
            user: "codex-credits-only@example.com",
            windows: [{ name: "Credits", used: 10 }],
          },
        ],
      },
      { fetchedAt: NOW },
    );
    expect(creditsOnly.accounts[0]?.authFile.disabled).toBe(true);
    expect(
      (codexUsageFor(creditsOnly.accounts[0]!, NOW) as CodexUsage).rate_limit?.primary_window,
    ).toBeNull();
  });
});
