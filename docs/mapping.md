# 映射规则：Magpie → T3 Code

本文说明 Magpie 的账号和额度窗口如何变成 T3 Code 能显示的账号与进度条。实现位于 `src/hub/mapping.ts`。

## 账号映射

| Magpie `provider` | auth-files `provider` | 卡片主标签（`email`） | plan | usage 结构 |
|---|---|---|---|---|
| `claude` | `claude` | `user` | T3 写死 `Claude Subscription` | Claude：5h / 7d / scoped |
| `codex` | `codex` | `user` | `plan_type`（如 `plus`） | Codex：primary / secondary |
| 其他（`cursor`、`qoder`、`qoder-cn`、`workbuddy-ai`、`antigravity`……） | `claude` | `<name> · <user>` | T3 写死 `Claude Subscription` | Claude：全部窗口进 scoped |
| `kind: "balance"` 且无窗口 | — | — | — | 不返回（disabled） |
| 无任何带 `used` 的窗口 | — | — | — | 不返回（disabled） |
| `lapsed` 非空 | — | — | — | 不返回（disabled） |

`id` 规则：

```text
provider/user                       # 有 user
provider/name                       # 无 user（如 DeepSeek）
provider/~<fingerprint>             # 无 user 且无 name
provider/user~<fingerprint>         # 基础 key 重复时追加稳定指纹
provider/user~<fingerprint>#2       # 连指纹都相同时的最后兜底
```

`fingerprint` 是 `provider + name + user + plan + kind` 的 SHA-256 前 8 位。基础 key 重复时使用它而不是列表下标，因此 Magpie 调整账号顺序不会让 `auth_index` 指向另一个账号。只有两个账号在所有这些字段上都相同时，才退化到下标兜底。

`auth_index`：`sha256(基础 key + fingerprint)` 的前 24 位十六进制。它只取决于账号自身的字段，后来出现一个同 provider/user 的账号不会改变已有账号的 `auth_index`（`id` 会加上 `~fingerprint` 后缀，但 T3 带回的是 `auth_index`）。T3 把它当作不透明字符串，在 `api-call` 中原样带回。

## 窗口映射

### 原生 Claude 账号

| Magpie 窗口名 | T3 结果 |
|---|---|
| 恰为 `5 hours` / `5h` / `Session` | `Session` 进度条（`five_hour`） |
| 恰为 `7 days` / `7d` / `Week` / `Weekly` | `Weekly` 进度条（`seven_day`） |
| 其他（包括 `Weekly Opus` 这类模型级窗口） | `Weekly · <窗口名>` 进度条（`weekly_scoped`） |

只有**第一个**精确匹配的整体窗口会成为 `five_hour` / `seven_day`；同一账号里后续匹配的窗口（例如 `Weekly Opus`）会保留为 scoped 进度条，不会覆盖整体数值。

示例（真实 Magpie 数据，已脱敏）：

```text
Claude Code · user@example.com
  5 hours   11%   → Session 11%
  7 days    44%   → Weekly 44%
  Opus       7%   → Weekly · Opus 7%
```

### 原生 Codex 账号

| Magpie 窗口名 | T3 结果 |
|---|---|
| 5 小时窗口 | primary → `Session`（`limit_window_seconds: 18000`） |
| 7 天窗口 | secondary → `Weekly`（`limit_window_seconds: 604800`） |
| 通用 `Primary` / `Secondary`（没有精确 5h/7d 时） | primary / secondary |
| 其他窗口（如 `Credits`、`Weekly Opus`、`GPT-5 Hours Mini`、`Session (codex-mini)`） | 忽略（避免把模型级额度显示成账户级） |

示例：

```text
Codex · user@example.com
  5 hours   0%    → Session 0%
  7 days    100%  → Weekly 100%
  plan: plus      → ChatGPT Plus Subscription
  resets: 2       → 不显示 reset 按钮（Hub 不投放 credits）
```

### 非原生供应商

所有带 `used` 的窗口都放进 Claude 的 `limits[]`：

```json
{
  "kind": "weekly_scoped",
  "percent": 49.46666666666667,
  "resets_at": "2026-11-24T13:33:18Z",
  "scope": { "model": { "display_name": "Qoder · Credits" } }
}
```

T3 最终显示：

```text
Qoder · user@example.com        [Claude 图标]
  Weekly · Qoder · Total credits    24.7%
  Weekly · Qoder · Credits          49.5%
  Weekly · Qoder · Shared credits    0.0%
```

补充规则：

- 标签前缀是 `<account.name> · <window.name>`。
- 有 `pool` 时追加 ` (<pool>)`，例如 `Antigravity · Gemini 3 Pro (Gemini)`。
- 同一账号内标签重复时追加 ` #2`、` #3`。
- `windows` 不是数组时视为空；数组里的 `null` 或其他非对象条目会被跳过。
- 百分比直接取 Magpie 的 `used` 并裁剪到 0–100。
- 百分比优先取 `used`；缺失时用 `100 - remaining`；再缺失时用 `amount / limit × 100`。
- 重置时间优先 `resetsAt`；没有则用该账号的 `readAt`（缺失时用快照的 `fetchedAt`）加 `resetSecs`；都没有就省略。**不会**用 api-call 的当前时间，否则旧快照里的倒计时会随每次轮询向后滑动。

## 禁用规则

Hub 不把以下账号放进 T3 的探测列表：

| 条件 | 原因 |
|---|---|
| `lapsed` 非空 | 登录已过期，数据不可信 |
| 没有任何可推导百分比的窗口（`used`、`remaining` 或 `amount` + `limit`），或窗口全部是 `text: true` 的说明文本 | T3 画不出进度条 |
| Codex 账号没有任何可映射的 5h/7d 或 Primary/Secondary 窗口 | 避免 T3 显示空卡片 |
| `kind: "balance"` 且无窗口 | 余额是文本，不是百分比 |

注意：**有 `error` 但仍有旧窗口**的账号不会被禁用。Magpie 可能暂时读不到上游，但旧窗口仍有参考价值。不过 `api-call` 只在该账号的 `readAt` 存在、且距现在不超过 `maxStaleMs` 时返回这些旧窗口；否则返回内层 `status_code: 503`。

## 为什么非原生账号要借用 Claude 适配器

T3 Code `0.1.7` 的 CLIProxyAPI usage source 在 `readAccounts` 中硬编码：

```ts
accounts.filter((account) =>
  !account.disabled && (account.provider === "codex" || account.provider === "claude")
)
```

并且：

- Claude 账号的 plan 写死为 `Claude Subscription`；
- Claude usage 支持 `five_hour`、`seven_day` 和任意数量的 `weekly_scoped`；
- Codex usage 只有 primary / secondary 两个桶。

因此：

- 非原生供应商用 `claude` 作为 cliproxy provider，才能容纳任意数量的窗口；
- 代价是进度条统一显示为 `Weekly · ...`，plan 显示为 `Claude Subscription`；
- 真实供应商标识放在账号主标签（`email` 字段）里，例如 `Cursor · user@example.com`。

如果 T3 未来支持任意 `driver` 或自定义窗口类型，可以移除这层借用，直接映射成更准确的 driver 与窗口 kind。

## 可调整点

| 需求 | 修改位置 |
|---|---|
| 增加/修改窗口名匹配 | `src/hub/mapping.ts` 的 `canonicalSessionName()` / `canonicalWeekName()` |
| 改变账号 id / auth index | `accountKey()` / `stableHash()` |
| 改变 disabled 规则 | `authFileFor()` |
| 改变非原生账号的承载方式 | `authFileFor()` 的 `cliproxyProvider` 与 `claudeUsageFor()` |
| 改变返回给 T3 的窗口顺序 | `claudeUsageFor()` 的遍历顺序（当前保持 Magpie 顺序） |
| 暴露 reset credits | `usageFor()` 的 credits 分支 + `readAccount` 消费路径（需要 Magpie 支持） |

修改后至少运行：

```bash
bun test
bun run typecheck
bun run verify
```
