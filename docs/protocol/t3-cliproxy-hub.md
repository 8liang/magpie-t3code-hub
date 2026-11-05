# T3 Code 的 CLIProxyAPI Hub 协议

T3 Code 在 **Settings → Providers → Usage providers → Add a CLIProxyAPI hub** 中接入一个“额度来源”。它把 Hub 当成 CLIProxyAPI 的管理面，只调用两个核心端点。

本文按 T3 Code `0.1.7 (Beta)` 服务端实际实现整理；如果 T3 升级后行为变化，以实际请求为准并同步更新本文档。

## 接入参数

| 字段 | 示例 | 说明 |
|---|---|---|
| Hub URL | `http://127.0.0.1:4319` | T3 会在其后拼 `v0/management/...` |
| Management key | `mgt_…` | 以 `Authorization: Bearer …` 发送 |
| Label | `Magpie` | 可选，显示在额度页 |

T3 把 key 保存在自己的 server 侧，不写入浏览器。

## 端点一：`GET /v0/management/auth-files`

T3 用来列出 Hub 池中的账号。

### 请求

```http
GET /v0/management/auth-files HTTP/1.1
Host: 127.0.0.1:4319
Authorization: Bearer <management-key>
Accept: application/json
```

### 响应

```json
{
  "files": [
    {
      "id": "claude/user@example.com",
      "auth_index": "5b0f0f0c9d0b4d5e6a7b8c9d",
      "provider": "claude",
      "email": "user@example.com",
      "disabled": false
    },
    {
      "id": "codex/user@example.com",
      "auth_index": "9a8b7c6d5e4f30211f2e3d4c",
      "provider": "codex",
      "email": "user@example.com",
      "disabled": false,
      "id_token": {
        "plan_type": "plus",
        "chatgpt_plan_type": "plus"
      }
    }
  ]
}
```

T3 的解析器只要求：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 账号唯一 id |
| `auth_index` | 是 | T3 在后续 `api-call` 中原样带回 |
| `provider` | 是 | 只有 `claude` 和 `codex` 会进入后续探测 |
| `email` | 否 | 额度卡片的主标签 |
| `disabled` | 否 | `true` 的账号会被过滤掉 |
| `id_token` | 否 | Codex 用于读取 `chatgpt_account_id` / `plan_type` / `chatgpt_plan_type` |

额外字段会被忽略。

> **过滤规则**：`!disabled && (provider === "codex" || provider === "claude")`。其他 provider 即使返回了也不会显示。
>
> Hub 在 Magpie 不可用且没有快照时返回 HTTP 503；旧快照超过 `maxStaleMs` 时也返回 503。

## 端点二：`POST /v0/management/api-call`

T3 让 Hub 代为请求供应商的原生额度 URL。

### 请求

```http
POST /v0/management/api-call HTTP/1.1
Host: 127.0.0.1:4319
Authorization: Bearer <management-key>
Content-Type: application/json

{
  "auth_index": "5b0f0f0c9d0b4d5e6a7b8c9d",
  "method": "GET",
  "url": "https://api.anthropic.com/api/oauth/usage",
  "header": {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.273"
  }
}
```

- `header` 里的 `$TOKEN$` 是 CLIProxyAPI 的占位符；本 Hub 不需要真实上游 token，直接忽略。
- `data` 仅在 reset-credit 消费时出现。

### 响应

外层 HTTP 始终为 200（除非 Hub 自身/JWT 问题），内层用 `status_code` 表示“上游”的结果：

```json
{
  "status_code": 200,
  "body": "{\"five_hour\":{\"utilization\":11,\"resets_at\":\"2026-11-05T22:49:00+08:00\"},…}"
}
```

`body` 是**字符串**，内容是供应商原生的 JSON。T3 会：

1. 若 `status_code` 不在 200–299，抛出 “The provider refused the hub request (HTTP N).”；
2. 否则 `JSON.parse(body)` 并按 provider 的原生 schema 解析。

### T3 会请求哪些 URL

| 账号 provider | URL | Hub 返回 |
|---|---|---|
| `claude` | `https://api.anthropic.com/api/oauth/usage` | Anthropic OAuth usage JSON |
| `codex` | `https://chatgpt.com/backend-api/wham/usage` | Codex rate-limit JSON |
| `codex` | `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` | `{ "credits": [] }` |

## Claude usage 结构（T3 解析的子集）

```json
{
  "five_hour": { "utilization": 11, "resets_at": "2026-11-05T22:49:00+08:00" },
  "seven_day": { "utilization": 44, "resets_at": "2026-11-09T19:59:00+08:00" },
  "limits": [
    {
      "kind": "weekly_scoped",
      "percent": 49.5,
      "resets_at": "2026-11-24T13:33:18Z",
      "scope": { "model": { "display_name": "Qoder · Credits" } }
    }
  ],
  "spend": null,
  "extra_usage": null
}
```

T3 的转换规则：

- `five_hour` → `Session` 进度条（5 小时）
- `seven_day` → `Weekly` 进度条（7 天）
- `limits[kind="weekly_scoped"]` 且 `scope.model.display_name` 为字符串 → `Weekly · <display_name>` 进度条
- `spend` / `extra_usage` → `Monthly spend` 进度条（本 Hub 不使用）

**注意**：T3 对 Claude 账号的 plan 字段写死为 `Claude Subscription`。这是非 Claude 供应商借用 Claude 适配器时 plan 看起来不对的原因。

## Codex usage 结构（T3 解析的子集）

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "primary_window": {
      "used_percent": 0,
      "reset_at": 1762359121,
      "limit_window_seconds": 18000
    },
    "secondary_window": {
      "used_percent": 100,
      "reset_at": 1762728949,
      "limit_window_seconds": 604800
    }
  }
}
```

T3 的转换规则：

- `primary_window` → 第一条进度条（默认 5 小时；Free/Go 套餐默认按月）
- `secondary_window` → 第二条进度条（默认 7 天）
- `limit_window_seconds` 决定窗口类型与标签
- `plan_type` 映射为套餐名（`plus` → `ChatGPT Plus Subscription`；未知值不显示套餐）
- `rate-limit-reset-credits` 返回的 credits 会显示 reset 按钮；本 Hub 返回空数组，因此不显示

## 端点三：`GET /v0/management/hub-info`

Hub 用于在借用已有监听器前确认对方是同一配置（管理 key 由 401 隐式验证）：

```json
{
  "service": "magpie-t3code-hub",
  "version": "0.1.0",
  "magpieQuotaUrl": "http://127.0.0.1:3425/v1/magpie/quotas",
  "dataDir": "/Users/me/.config/magpie-t3code-hub"
}
```

`magpieQuotaUrl` 或 `dataDir` 不同、或管理 key 被拒绝时，新宿主会明确报错而不是静默复用。

## 端点四：`POST /v0/management/reset-quota`

T3 只在成功消费一个 reset credit 后调用，用于清掉 CLIProxyAPI 的冷却状态。本 Hub 不投放 reset credits，因此该端点只做安全 no-op：

```json
{ "ok": true }
```

## 鉴权

- T3 对每个 management 请求发送 `Authorization: Bearer <management-key>`。
- Hub 使用常量时间比较；不匹配返回 HTTP 401。
- 401 在 T3 侧显示为 “The hub answered with HTTP 401.”。
- `/healthz` 与 `/readyz` 不需要鉴权，但只返回 `ok` / `service` / `version`；详细诊断（上游 URL、错误、账号数）在需要 token 的 `/v1/hub/status`。
- 旧快照超过 `maxStaleMs`（默认 10 分钟）后，`auth-files` 返回 HTTP 503，`api-call` 返回内层 `status_code: 503`；无快照（Magpie 启动即不可用）时也是 503，而不是 500。

## 超时与并发

| 项目 | T3 Code 行为 | Hub 侧 |
|---|---|---|
| 单次 management 请求 | 15 秒超时 | Magpie 读取 10 秒（可配 1–14 秒） |
| 账号探测并发 | 4 | 共享 5 秒额度缓存，不放大上游请求 |
| 探测失败 | 账号显示 “The hub could not read this account's usage.” | `api-call` 返回非 2xx 内层状态，或 HTTP 错误 |

## T3 端展示的字段

T3 的额度页最终展示：

- `driver`：来自 `provider`（`claude` / `codex`）
- 主标签：有 `email` 时显示 `email`，否则显示 driver 名称
- plan：Claude 写死，Codex 由 `plan_type` 映射
- 进度条：由上面的转换规则生成
- 来源标签：T3 中配置的 Label（例如 `Magpie`）

## 兼容性检查清单

如果 T3 升级后额度不显示，按顺序检查：

1. `GET /v0/management/auth-files` 是否返回了 `files`，且 `provider` 是 `claude` / `codex`。
2. `disabled` 是否误把账号过滤掉。
3. `POST /v0/management/api-call` 的内层 `status_code` 是否 200。
4. `body` 是否是字符串形式的合法 JSON。
5. Claude 的 `limits[].kind` 是否为 `weekly_scoped`，`scope.model.display_name` 是否存在。
6. Codex 的 `used_percent` 是否在 0–100，`reset_at` 是否为 Unix 秒。
7. T3 的 Settings 中 Hub URL 是否带了多余路径（应为纯 origin，例如 `http://127.0.0.1:4319`）。
