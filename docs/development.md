# 开发与接入

## 前置条件

| 组件 | 版本 | 说明 |
|---|---|---|
| Bun | ≥ 1.2 | 插件宿主也使用 Bun；本机开发可用 `bun`、`~/.real/.bin/bun` 或 Magpie 内置的 `magpie-bun` |
| Magpie | 0.1.x | 提供 `/v1/magpie/quotas`，并运行插件宿主 |
| T3 Code | 0.1.7+ | 使用 CLIProxyAPI usage source 读取额度 |

如果 `bun` 不在 PATH：

```bash
export PATH="$HOME/.real/.bin:$PATH"
# 或使用 Magpie 内置的 Bun
~/.cache/magpie/bun/1.4.4/magpie-bun --version
```

## 本地命令

```bash
bun install            # 只装开发依赖（@types/bun、typescript）
bun test               # 93 个映射 / HTTP 契约测试
bun run typecheck      # tsc --noEmit
bun run dev            # 独立运行 Hub，默认 127.0.0.1:4319
bun run token          # 打印 management key；支持 --data-dir / --key
bun run verify         # 按 T3 的真实调用顺序回放；支持 --url / --key / --data-dir
```

`token` / `verify` 共用一条 key 解析链：`--key` → Magpie 插件选项（`plugins.json`）→ 运行中 Hub 的 `hub.json` token 文件 → `MAGPIE_T3CODE_HUB_TOKEN` → `<data-dir>/token`。`hub.json` 的 `pid` 已退出时会被当作陈旧文件忽略。插件用自定义 `dataDir` 或 `managementKey` 时无需再手动对齐；如果 `hub.json` 明确写的是 `tokenPath:null`（Hub 的 key 来自它自己的环境/选项），CLI 不会新建一个无关的 token，而是提示设置环境变量或 `--key`；如果 `tokenPath` 指向的文件丢失/为空，仍会回退到环境变量或 `--key`。

独立运行会读取本机 Magpie：

```bash
curl -s http://127.0.0.1:3425/v1/magpie/quotas | jq '.data | length'
bun run dev
curl -s http://127.0.0.1:4319/healthz | jq
```

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAGPIE_T3CODE_HUB_PORT` | `4319` | Hub 监听端口；`0` 表示随机端口（测试用）；负数/超过 65535 会直接报错，不会静默截断 |
| `MAGPIE_T3CODE_HUB_HOST` | `127.0.0.1` | 绑定地址；非回环会打 warn |
| `MAGPIE_T3CODE_HUB_HOME` | `<XDG_CONFIG_HOME>/magpie-t3code-hub` | token 与 `hub.json` 的目录；`~` 会展开；相对路径按**用户主目录**解析，不依赖 cwd。CLI 的 `--data-dir` 相对路径按 **cwd** 解析 |
| `MAGPIE_T3CODE_HUB_TOKEN` | 无 | 直接指定 management key，优先于 token 文件 |
| `MAGPIE_QUOTA_URL` | `http://127.0.0.1:3425/v1/magpie/quotas` | Magpie 额度端点 |
| `MAGPIE_GATEWAY_KEY` | 无 | 访问 Magpie 额度端点时的 Bearer key（通常本地不需要） |
| `MAGPIE_T3CODE_HUB_CACHE_TTL_MS` | `5000` | 额度缓存毫秒，0–60000 |
| `MAGPIE_T3CODE_HUB_FETCH_TIMEOUT_MS` | `10000` | 读 Magpie 的超时，1000–14000 |
| `MAGPIE_T3CODE_HUB_MAX_STALE_MS` | `600000` | 旧快照最多继续提供给 T3 多久（10 分钟），0–24h |
| `MAGPIE_T3CODE_HUB_BACKOFF_MS` | `10000` | 上游失败后的快速失败窗口，0–60s |

### Magpie 插件选项

插件安装后可用 `magpie plugin options` 设置，等价于环境变量：

```bash
magpie plugin options magpie-t3code-hub '{"port":4319,"dataDir":"/Users/me/.config/magpie-t3code-hub"}'
magpie plugin options magpie-t3code-hub off
```

支持的键：

| 键 | 说明 |
|---|---|
| `host` | 绑定地址 |
| `port` | 端口 |
| `magpieQuotaUrl` / `quotaUrl` | Magpie 额度端点 |
| `magpieManagementKey` / `magpieKey` | Magpie gateway key |
| `managementKey` / `token` | T3 使用的 management key；设置后不再读写 token 文件 |
| `dataDir` | token / 状态文件目录 |
| `cacheTtlMs` | 缓存毫秒 |
| `fetchTimeoutMs` | 上游超时毫秒 |
| `maxStaleMs` | 旧快照最长继续提供时间（默认 10 分钟） |
| `backoffMs` | 上游失败后的快速失败窗口（默认 10 秒） |

在 Magpie 里也可以点插件那一行的“选项”直接编辑。还没设置过选项时，编辑框里显示的是 `package.json` 中 `magpie.options` 给的示例：`managementKey`（留空表示用 token 文件里的 key）、`host`、`port`、`magpieQuotaUrl`、`cacheTtlMs`、`maxStaleMs`，值都是默认值，原样保存不会改变行为。设置 → 插件里的 T3 Code Hub 面板显示的就是这里的 `managementKey`。

## 安装为 Magpie 插件

```bash
# 在项目根目录
magpie plugin add /absolute/path/to/magpie-t3code-hub

# 查看是否加载
magpie plugin list --json | jq '.[] | select(.spec | contains("magpie-t3code-hub"))'

# 关闭 / 打开
magpie plugin off magpie-t3code-hub
magpie plugin on magpie-t3code-hub
```

加载成功后：

- Magpie 的插件宿主会启动一个 Bun 进程；
- Hub 监听 `127.0.0.1:4319`；
- Magpie 日志里会出现 `listening on http://127.0.0.1:4319`。

查看日志：

```bash
magpie log -n 120 | grep -i t3code
```

> 本地路径安装会把**绝对路径**写进 Magpie 的 `plugins.json`。移动或重命名项目目录后，需要重新执行 `magpie plugin add <新路径>`。
>
> 修改本地源码后，Magpie 可能缓存已加载的插件。关闭再打开插件，或重启 Magpie，让宿主重新加载。
>
> `magpie plugin list` 等 CLI 命令也会启动临时插件宿主。如果 Hub 已经在运行，新宿主会复用现有监听器，不会报端口冲突；日志里会看到 `a hub is already listening ...; reusing it`。

## T3 Code 接入

1. 打开 **Settings → Providers → Usage providers**。
2. 点击 **Add a CLIProxyAPI hub**。
3. 填写：
   - **Hub URL**：`http://127.0.0.1:4319`（只填 origin，不要带 `/v0/...`）
   - **Management key**：`bun run token` 的输出；或直接粘贴 `~/.config/magpie-t3code-hub/token`
   - **Label**：`Magpie`（可选）
4. 保存后打开额度页，应该看到 Magpie 的 Claude / Codex 账号，以及其他供应商的 scoped 进度条。

T3 会周期性刷新；Hub 侧 5 秒缓存，不会把 T3 的并发探测放大成大量 Magpie 请求。

> T3 Code 把 Hub 配置保存在自己的 server config（`usageLimitSources`）中，并通过 UI 的专用流程持久化；`~/.t3/userdata/settings.json` 通常看不到这一项。请用上面的 UI 添加，不要手改 T3 的配置文件。

### 验证接入

```bash
# 1. Hub 健康
curl -s http://127.0.0.1:4319/healthz | jq

# 2. 账号映射
curl -s -H "Authorization: Bearer $(bun run token)" \
  http://127.0.0.1:4319/v1/hub/status | jq '.accounts[] | {id, sourceProvider, cliproxyProvider, disabled}'

# 3. 完整回放 T3 的请求
bun run verify
```

`verify` 会：

- `GET v0/management/auth-files`
- 对每个可用账号 `POST v0/management/api-call`
- 打印 T3 将看到的 Session / Weekly / scoped 进度条
- 有失败时以退出码 1 结束

## 开发工作流

```bash
# 终端 A：独立运行 Hub（避开插件占用的端口）
MAGPIE_T3CODE_HUB_PORT=4319 MAGPIE_T3CODE_HUB_HOME=/tmp/magpie-t3hub-dev bun run dev

# 如果端口已被 Magpie 插件宿主占用，独立模式会保持进程存活并等待接管，
# 而不是打印一行后静默退出。

# 终端 B：改代码后跑测试
bun test
bun run typecheck

# 终端 C：回放
MAGPIE_T3CODE_HUB_HOME=/tmp/magpie-t3hub-dev bun run verify
```

插件模式和独立模式共用同一套 `src/hub/*`：

- 插件模式：`src/hooks.ts`（`magpie.hooks`）→ `ensureHub()` → `Bun.serve()`（`src/hub.middleware.js` 只是一个空中间件声明）
- 独立模式：`src/standalone.ts` → `startHub()` → `Bun.serve()`

## CodeGraph MCP

项目已配置 `.mcp.json`：

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

首次使用：

```bash
codegraph init
codegraph index
codegraph status
```

日常同步：

```bash
codegraph sync
codegraph query "usageFor"
codegraph context "修改 usage 映射"
```

说明：

- `.codegraph/` 的数据库文件已在 `.gitignore` 中忽略，索引是机器本地的。
- MCP 客户端启动时执行 `codegraph serve --mcp`，不需要手动常驻。
- 如果 MCP 没有生效，先确认 `codegraph --version` 可执行，再检查客户端是否加载了项目根目录的 `.mcp.json`。

## 项目结构

```text
src/
  hooks.ts               Magpie 插件入口（magpie.hooks，启动 Hub）
  hub.middleware.js      空 gateway middleware，让 Magpie 把插件标成中间件
ui/
  key.html / key.js      Magpie 设置面板：显示 Hub 地址和 management key
  standalone.ts          独立运行入口
  hub/
    server.ts            HTTP 路由、鉴权、健康检查、ensureHub
    mapping.ts           Magpie → CLIProxyAPI / Claude / Codex 映射
    magpie.ts            Magpie 额度客户端 + 缓存
    auth.ts              management key 与 Bearer
    status.ts            hub.json 读写与可连接 URL
    options.ts           插件/环境变量的严格数值解析
    constants.ts         默认 host/port/额度 URL
    replies.ts           api-call 错误信封
    types.ts             所有线协议类型
    version.ts           读取 package.json 版本
  cli/
    token.ts             打印 management key
    verify.ts            回放 T3 的调用序列
    args.ts              共享命令行参数解析
    config.ts            CLI 的 dataDir 与 Hub URL
    key.ts               token/verify 共用的 key 解析链
    plugin-options.ts    读取 Magpie 的 plugins.json
tests/
  fixtures.ts            脱敏的 Magpie 额度样本
  mapping.test.ts        账号/窗口映射
  auth.test.ts           token 创建、复用与只读目录
  magpie.test.ts         缓存、stale 与退避
  server.test.ts         HTTP 契约、借用/接管、ensureHub 串行化
  cli-config.test.ts     状态文件、插件选项与 key 解析
  cli.test.ts            token/verify/standalone 命令行行为
  options.test.ts        严格数值解析
docs/                    知识库（入口 docs/index.md）
```
