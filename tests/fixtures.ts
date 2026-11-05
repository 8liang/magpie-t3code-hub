import type { MagpieQuotaResponse } from "../src/hub/types";

export const NOW = Date.parse("2026-11-05T10:00:00.000Z");

export const fixture: MagpieQuotaResponse = {
  object: "list",
  data: [
    {
      provider: "claude",
      name: "Claude Code",
      kind: "subscription",
      plan: "pro",
      user: "claude@example.com",
      windows: [
        { name: "5 hours", used: 11, resetsAt: "2026-11-05T14:49:00+08:00" },
        { name: "7 days", used: 44, resetsAt: "2026-11-09T11:59:00+08:00" },
        { name: "Opus", used: 7, resetSecs: 3600 },
      ],
      readAt: "2026-11-05T09:59:00.000Z",
    },
    {
      provider: "codex",
      name: "Codex",
      kind: "subscription",
      plan: "plus",
      user: "codex@example.com",
      windows: [
        { name: "5 hours", used: 100, resetSecs: 10_000 },
        { name: "7 days", used: 16, resetsAt: "2026-11-09T06:55:49Z" },
      ],
      resets: {
        count: 2,
        each: [{ id: "credit-1", until: "2026-11-30T19:07:07.723834Z" }],
      },
    },
    {
      provider: "qoder",
      name: "Qoder",
      kind: "subscription",
      plan: "teams",
      user: "qoder@example.com",
      windows: [
        { name: "Total credits", used: 24.733333333333334, resetsAt: "2026-11-24T13:33:18Z" },
        { name: "Credits", used: 49.46666666666667, resetsAt: "2026-11-24T13:33:18Z" },
        { name: "Shared credits", used: 0 },
      ],
    },
    {
      provider: "workbuddy-ai",
      name: "WorkBuddy AI",
      kind: "subscription",
      plan: "Free plan",
      user: "workbuddy@example.com",
      windows: [{ name: "Credits", used: 0.06, limit: 100, unit: "credits" }],
    },
    {
      provider: "deepseek",
      name: "DeepSeek",
      kind: "balance",
      windows: [],
    },
    {
      provider: "opencode-zen-free",
      name: "OpenCode Zen Free",
      kind: "subscription",
      plan: "OpenCode Zen Free",
      user: "API key",
      windows: [],
    },
    {
      provider: "workbuddy",
      name: "WorkBuddy",
      kind: "subscription",
      user: "lapsed@example.com",
      lapsed: "sign-in expired",
      windows: [{ name: "Credits", used: 10 }],
    },
    {
      provider: "cursor",
      name: "Cursor",
      kind: "subscription",
      plan: "Team",
      user: "cursor@example.com",
      error: "temporary upstream failure",
      windows: [{ name: "Total", used: 81.344 }],
    },
  ],
};
