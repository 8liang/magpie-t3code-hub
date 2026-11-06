# 0002：用 request hooks 启动 Hub，再加一个空中间件，去掉 Provider 标签

- 状态：已采纳（取代 0001 中“`main` 指向 `src/plugin.ts`、导出 `{ id, server }`”的部分）
- 日期：2026-11-06
- 相关文档：[0001](0001-run-as-magpie-bun-plugin.md)、[架构](../architecture.md)

## 背景

0001 只有 `main`（返回空 hooks），Magpie 的 Installed 列表因此把它标成 **Provider**。但它不登录任何账号，也不提供模型。

Magpie 的规则（源码 `internal/plugin/{middleware,gateway,agent,host}.go`、`internal/gui/plugins.go` 和界面代码）：

| `package.json` 声明 | 运行位置 | 标签 |
|---|---|---|
| `main` / `exports` | Bun 插件宿主 | Provider（除非 `gatewayOnly`、`middlewareOnly`、`inMagpieOnly` 之一成立，而这三项都要求没有 `main`/`exports`） |
| `magpie.hooks` | Bun 插件宿主，每个请求一次 RPC | Request hook（请求 Hook） |
| `magpie.middleware`（或 `magpie.gateway`） | 网关内的 moejs | Middleware（中间件） |

- 界面里显示 Provider 标签的条件是 `providers.length || !(gatewayOnly || middlewareOnly || inMagpieOnly || isAgent || toolsOnly || (mw && !isMiddleware) || (ag && !isAgent))`。只要有 `main`，就总会显示 Provider。
- 只有 middleware、没有 Bun 入口的包算 `InMagpieOnly`，`host.go` 根本不会把它交给 Bun 宿主，Hub 也就没地方跑。moejs 里不能起 HTTP 监听。
- 所以只要 Hub 在 Magpie 里运行，就一定会多一个 Provider 或 Request hook 标签；只显示“中间件”一个标签做不到。

## 决策

在“中间件 + 供应商”和“中间件 + 请求 Hook”之间选后者：

- 删除 `main`、`exports` 和 `src/plugin.ts`；`package.json` 声明 `"magpie": { "hooks": "./src/hooks.ts", "middleware": "./src/hub.middleware.js" }`。根目录不能有 `index.*`（否则 `GatewayOnly` 为 false，Provider 标签会回来）。
- `src/hooks.ts` 在模块顶层 `await ensureHub(...)`：宿主 import 时启动监听，失败会让 import 失败，Magpie 显示为插件加载错误。`onRequest` 只调用 `ctx.report("skipped")`，然后返回 `undefined`。
- hooks 模块在加载时拿不到选项，所以启动时从 `plugins.json` 读本插件条目的 `options`（`readPluginRawOptions`）。Magpie 修改选项后会重启宿主，这段代码会重新执行。
- 日志写 stderr（`console.error`），因为拿不到 `client.app.log`；stdout 仍然不能写。
- `src/hub.middleware.js` 是 moejs 空中间件，只用来显示“中间件”标签。

验证：`magpie plugin list` 对本插件显示 `async gateway hook  onRequest` 和 `gateway middleware  onRequest`，没有 provider 行；宿主加载 hooks 模块后启动（或接管）Hub。

## 后果

- 标签为“中间件 + 请求 Hook”，Hub 的行为、端口、key、T3 侧配置都不变。
- 每个 agent 请求多两次空调用：一次是到 Bun 的 `onRequest` RPC（立即返回，统计里结果为 `skipped`），一次是 moejs 中间件（约 1 微秒）。
- 日志不再经过 `client.app.log`，要在 `magpie log` 里看。
- 如果 Magpie 以后改成“插件没有提供 provider 时不显示 Provider 标签”，可以回到 `main` + 空中间件，只剩“中间件”一个标签。
