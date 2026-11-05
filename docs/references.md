# 参考资料

## Magpie

- 官网：<https://usemagpie.ai>
- 插件文档：<https://usemagpie.ai/docs/plugins>
- 源码：<https://github.com/yetone/magpie>
- 参考手册：<https://github.com/yetone/magpie/blob/main/docs/reference.md>
- 本机 CLI：`magpie --help`、`magpie plugin --help`
- 额度端点：`GET http://127.0.0.1:3425/v1/magpie/quotas`

关键事实（来自插件文档与本机插件宿主）：

- OpenCode 风格插件在 Bun 插件宿主中运行；
- gateway middleware 在 moejs 中运行，无 `fetch` / 定时器 / Node API；
- gateway hooks 只能改写已有请求；
- 插件宿主通过 stdin/stdout 收发一行一条的 JSON-RPC，因此插件不能写 stdout；
- 插件日志应走 `client.app.log`。

## T3 Code

- 本机版本：T3 Code `0.1.7 (Beta)`（`/Applications/T3 Code (Beta).app`）
- 额度入口：**Settings → Providers → Usage providers → Add a CLIProxyAPI hub**
- 本机 T3 server：`127.0.0.1:3773`
- 相关本地文件：`~/.t3/userdata/settings.json`（`usageLimitSources` 在 T3 的 server config 中）

T3 的 CLIProxyAPI usage source 实际调用：

```text
GET  v0/management/auth-files
POST v0/management/api-call      # Anthropic / ChatGPT usage
POST v0/management/reset-quota   # 仅消费 reset credit 后
```

## CLIProxyAPI

- 源码：<https://github.com/router-for-me/CLIProxyAPI>
- T3 Code 兼容的只是其 management API 的最小子集；本项目不是完整的 CLIProxyAPI 实现。

## Bun

- 官网：<https://bun.sh>
- 本机开发：`~/.real/.bin/bun`（1.2.17）
- Magpie 内置：`~/.cache/magpie/bun/1.4.4/magpie-bun`

## CodeGraph

- 本机 CLI：`codegraph --help`
- 项目 MCP 配置：`.mcp.json` → `codegraph serve --mcp`
- 初始化与索引：

```bash
codegraph init
codegraph index
codegraph status
codegraph sync
```

## 本项目协议文档

- [Magpie 额度 HTTP API](protocol/magpie-quota-api.md)
- [T3 Code 的 CLIProxyAPI Hub 协议](protocol/t3-cliproxy-hub.md)
- [映射规则](mapping.md)
