# Magpie 额度 HTTP API

Hub 的唯一数据源是 Magpie Gateway 的额度端点。

## 端点

```http
GET http://127.0.0.1:3425/v1/magpie/quotas
Accept: application/json
```

- 默认端口 `3425` 是 Magpie Gateway 的默认值；以本机实际 `served` 端口为准。
- 在本机回环访问时，当前 Magpie 版本不要求额外鉴权。
- 如果 Magpie 部署在远端或开启了 gateway key，Hub 会带上：

```http
Authorization: Bearer <MAGPIE_GATEWAY_KEY>
```

对应环境变量：`MAGPIE_GATEWAY_KEY`。

> Magpie 的 `GET /` 会列出自己提供的 API，其中包含 `/v1/magpie/quotas`、`/v1/magpie/usage`。本 Hub 只使用额度端点。

## 响应结构

顶层是 OpenAI list 风格：

```json
{
  "object": "list",
  "data": [
    {
      "provider": "claude",
      "name": "Claude Code",
      "kind": "subscription",
      "plan": "pro",
      "user": "user@example.com",
      "windows": [
        {
          "name": "5 hours",
          "used": 11,
          "remaining": 89,
          "resetsAt": "2026-11-05T22:49:00+08:00",
          "holdsWhy": "none"
        },
        {
          "name": "7 days",
          "used": 44,
          "remaining": 56,
          "resetsAt": "2026-11-09T19:59:00+08:00",
          "holdsWhy": "none"
        }
      ],
      "readAt": "2026-11-05T18:14:43.865049+08:00"
    }
  ]
}
```

带 credits 的窗口可能长这样：

```json
{
  "name": "Credits",
  "used": 46.5,
  "remaining": 53.5,
  "resetsAt": "2026-11-26T16:00:00Z",
  "display": "1395 / 3000 credits",
  "amount": 1395,
  "limit": 3000,
  "unit": "credits",
  "holdsWhy": "clock"
}
```

Codex 账号可能带 reset credits：

```json
{
  "resets": {
    "count": 2,
    "until": "2026-11-30T19:07:07.723834Z",
    "each": [
      { "until": "2026-11-30T19:07:07.723834Z", "id": "RateLimitResetCredit_…" }
    ]
  }
}
```

## 字段语义

### 账号级

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 供应商标识，如 `claude`、`codex`、`cursor`、`qoder`、`workbuddy-ai` |
| `name` | string | 展示名，如 `Claude Code`、`Qoder CN` |
| `kind` | string | `subscription` 或 `balance` |
| `plan` | string? | 套餐名，如 `pro`、`plus`、`teams`、`Free plan` |
| `user` | string? | 账号邮箱、用户名或 `API key`；余额型账号可能缺失 |
| `windows` | array | 额度窗口；余额型账号可能为空 |
| `readAt` | ISO string? | Magpie 读取上游额度的时间 |
| `error` | string? | 读取失败原因；可能仍有旧窗口。Hub 仍按 `readAt` 提供这些旧窗口，但超过 `maxStaleMs` 或没有 `readAt` 时 api-call 返回 503 |
| `lapsed` | string? | 登录过期；这些账号在本 Hub 中直接 disabled |
| `resets` | object? | Codex reset credits 信息 |
| `last` / `lastServedAt` | bool / ISO? | Magpie 的路由辅助字段，Hub 不使用 |

### 窗口级

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 窗口名，如 `5 hours`、`7 days`、`Credits`、`Cursor Models` |
| `used` | number? | **已用百分比 0–100**（可能带小数） |
| `remaining` | number? | 剩余百分比 0–100 |
| `resetsAt` | ISO string? | 重置时间；部分 credits 窗口没有 |
| `resetSecs` | number? | 距重置的秒数；`resetsAt` 缺失时使用 |
| `display` | string? | 人类可读的数量，如 `1484 / 6000 credits` |
| `amount` / `limit` / `unit` | number / number / string? | 原始用量、上限、单位 |
| `holdsWhy` | string? | Magpie 路由判断（`none` / `low` / `clock`），Hub 不使用 |
| `pool` / `family` | string? | Antigravity 等账号的分池/家族信息 |
| `text` | bool? | 该窗口更像文本说明而非进度条（例如 `+$183.36 on us`） |
| `runsOutAt` / `runsOut` | ISO / number? | Magpie 的耗尽预测，Hub 不使用 |
| `aside` | bool? | Magpie 内部标记，Hub 不使用 |

## Hub 如何使用这些字段

| Hub 行为 | 依据 |
|---|---|
| 账号 key | `provider/user`；无 `user` 时用 `provider/name`，重名再加 `#2` |
| auth index | `sha256(基础 key + 账号指纹)` 取前 24 位十六进制；指纹取 provider/name/user/plan/kind，与是否出现同名账号无关 |
| disabled | `lapsed` 存在，或没有任何可推导百分比的窗口 |
| Claude 原生桶 | 窗口名精确为 5 小时 / 7 天 / Session / Weekly |
| Codex 原生桶 | 精确 5 小时 / 7 天；否则接受通用 `Primary` / `Secondary`；都不匹配则账号 disabled |
| 其他窗口 | 统一转成 `weekly_scoped`，标签带 `account.name` |
| 重置时间 | 优先 `resetsAt`，否则账号 `readAt`（或快照 `fetchedAt`）+ `resetSecs` |
| 百分比 | `used`；缺失时 `100 - remaining`；再缺失时 `amount / limit × 100`；裁剪到 0–100 |

## 稳定性与排查

- 该端点是 Magpie 的内部 HTTP API，字段可能随 Magpie 版本增加；未知字段会被忽略。
- 如果 Magpie 改字段名，修改 `src/hub/mapping.ts` 并更新本文档。
- 直接查看原始数据：

```bash
curl -s http://127.0.0.1:3425/v1/magpie/quotas | jq
```

- 查看 Hub 的映射结果：

```bash
bun run token
curl -s -H "Authorization: Bearer $(bun run token)" \
  http://127.0.0.1:4319/v1/hub/status | jq
```

## 已知差异

- `used` 是百分比，不是原始次数；缺失时 Hub 可以从 `remaining` 或 `amount` / `limit` 推导。
- `windows` 不是数组时按空处理；数组里的 `null` 或其他非对象条目会被跳过，不会让整个 Hub 报错。
- `kind: "balance"` 的账号（DeepSeek、OpenCode Zen）没有百分比窗口，Hub 不向 T3 展示。
- `resets` 里的 reset credits 不会转发给 T3；Magpie 没有给插件提供消费这些额度的接口。
