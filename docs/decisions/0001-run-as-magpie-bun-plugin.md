# 0001：作为 Magpie Bun 插件运行，并在插件宿主内启动 HTTP 监听

- 状态：已采纳；入口声明方式已由 [0002](0002-declare-as-gateway-middleware.md) 取代
- 日期：2026-11-05
- 相关文档：[架构](../architecture.md)、[T3 协议](../protocol/t3-cliproxy-hub.md)

## 背景

需求是：

1. 给 T3 Code 提供额度查询 Hub；
2. 数据来源是 Magpie；
3. 以 Magpie 插件形式运行；
4. 数据流向为：Magpie Bun 插件 → 本地 HTTP 监听 → T3 Code Hub。

约束：

- T3 Code 支持接入 **CLIProxyAPI Hub**，其 usage source 只调用 management 端点；
- Magpie 的插件系统支持 OpenCode 风格 provider 插件、pi package、gateway middleware / hooks、agent/tool/page 插件；
- Magpie **没有**“插件注册任意 HTTP 路由”的 API；
- gateway middleware 运行在 moejs 中，不能使用 `fetch`、定时器或 Node API，也不能新增路由；
- gateway hooks 只能改写已有模型请求，不能提供新的管理端点；
- Magpie 的 provider 插件宿主是一个长期存活的 Bun 进程。

## 决策

把 Hub 做成一个 **OpenCode 风格的 Magpie 插件**：

- `package.json` 的 `main` 指向 `src/plugin.ts`；
- 入口使用 `export default { id, server }`，让插件宿主只调用 `server`；
- `server()` 读取 Magpie 插件选项，调用 `ensureHub()`；
- `ensureHub()` 在插件宿主进程内用 `Bun.serve()` 启动一个只监听 `127.0.0.1` 的 HTTP 服务；
- 插件返回空 hooks（`{}`），不参与模型请求；
- Hub 读取 Magpie 的 `/v1/magpie/quotas`，按 T3 的 CLIProxyAPI 契约转换数据。

## 为什么可行

1. **插件宿主是 Bun 进程**，`Bun.serve` 可用。
2. **宿主长期存活**，监听器随宿主生命周期存在，不需要额外的守护进程。
3. **不污染 Magpie 协议**：所有日志走 `client.app.log`，不使用 stdout。
4. **T3 只要求 HTTP 端点**：Hub 不需要是原生 CLIProxyAPI，只要实现 `auth-files` / `api-call` 的最小契约。
5. **重启可控**：插件关闭/宿主重启时监听器消失；重新加载时 `ensureHub()` 先停旧 handle 再绑定端口。

## 后果

### 正面

- 满足“作为 Magpie 插件运行”的要求。
- 不需要 fork Magpie，也不需要在 Magpie 网关里加路由。
- 不需要单独安装/守护一个后台服务。
- 代码量小：一个入口 + 一个 HTTP 服务器 + 一个映射层。
- 插件被禁用时 Hub 自动消失，不会留下孤儿进程。

### 负面 / 风险

- **生命周期耦合**：Magpie 退出或插件宿主重启时，Hub 短暂不可用；T3 会显示连接失败，恢复后自动重连。
- **端口冲突**：插件宿主 reload 时新旧进程可能短暂重叠；`startHub` 已做 4 次重试，仍失败会让插件加载失败。
- **不支持路由注册的“非官方”用法**：Magpie 文档没有承诺插件可以启动监听器；如果未来插件沙箱收紧（例如禁止 `Bun.serve`），需要迁移到独立 daemon 或请求 Magpie 提供官方 sidecar API。
- **stdout 不能随便写**：任何 `console.log` 都会破坏 JSON-RPC；已通过 logger 约束。
- **调试不如独立进程方便**：需要看 Magpie 日志；提供 `src/standalone.ts` 作为开发替代。

## 备选方案

### A. 独立 Bun/Node daemon

**优点**：生命周期独立、调试简单、可用 systemd/launchd 管理。

**缺点**：不满足“作为 Magpie 插件运行”；需要额外安装、启动、守护；Magpie 退出后仍运行，可能读到过期配置。

**结论**：保留 `src/standalone.ts` 仅用于开发，不作为部署形态。

### B. Magpie gateway middleware

**优点**：官方插件类型，运行在网关进程内。

**缺点**：moejs 运行时无 `fetch`、无定时器、无 Node API；只能改写模型请求/响应，不能注册管理端点；无法读取 Magpie 的额度 HTTP API。

**结论**：不可行。

### C. Magpie gateway hooks

**优点**：Bun 运行，可 `fetch`，可异步。

**缺点**：只覆盖已有模型请求的 `onRequest` / `onResponse`；不能新增 `v0/management/*` 路由；返回值不能改 model/stream/tools。

**结论**：不可行。

### D. 修改 T3 Code

**优点**：可以直接支持任意 driver/窗口，UI 最自然。

**缺点**：超出本项目范围；需要维护 T3 fork；升级成本高。

**结论**：不做。当前映射层已经能在不修改 T3 的前提下展示数据。

### E. 写一个真正的 CLIProxyAPI 实例

**优点**：协议天然兼容，T3 直接可用。

**缺点**：CLIProxyAPI 的账号模型与 Magpie 不同；需要伪造 auth 文件或维护两套账号；引入一个 Go 服务。

**结论**：用一个轻量兼容层更合适。

## 复审触发条件

出现以下情况时重新评估本决策：

- Magpie 插件沙箱禁止 `Bun.serve` 或限制宿主进程网络；
- Magpie 提供官方的“插件 sidecar / 自定义 HTTP 路由”机制；
- T3 Code 改变 CLIProxyAPI usage source 契约，或支持任意 driver；
- 需要跨机器共享 Hub（此时应改用独立服务 + TLS/认证）。
