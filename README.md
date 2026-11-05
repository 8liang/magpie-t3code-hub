# magpie-t3code-hub

A Magpie Bun plugin that exposes [Magpie](https://usemagpie.ai)'s quota data as a
CLIProxyAPI-compatible usage hub for T3 Code.

```
Magpie gateway (:3425) ──GET /v1/magpie/quotas──▶ Magpie plugin host (Bun)
                                                      │
                                                      ▼
                                              T3 Code Hub (:4319)
                                                      ▲
                         GET  v0/management/auth-files │
                         POST v0/management/api-call  │
                                                      │
                                                  T3 Code
```

## Quick start

```bash
# 1. Run the tests
bun test

# 2. Run the hub without Magpie (reads the local Magpie gateway)
bun run dev

# 3. Print the management key T3 Code asks for
bun run token

# 4. Replay T3 Code's exact requests against the hub
bun run verify
```

If `bun` is not on your PATH, add it (`export PATH="$HOME/.real/.bin:$PATH"`)
or call the files directly with your Bun binary.

Then install the package as a Magpie plugin:

```bash
magpie plugin add /absolute/path/to/magpie-t3code-hub
```

In T3 Code: **Settings → Providers → Usage providers → Add a CLIProxyAPI hub**,
enter `http://127.0.0.1:4319` and the key from `bun run token`.

The full knowledge base starts at [docs/index.md](docs/index.md).

## Layout

| Path | Purpose |
|---|---|
| `src/plugin.ts` | Magpie plugin entry; starts the Bun HTTP listener |
| `src/hub/server.ts` | CLIProxyAPI management API consumed by T3 Code |
| `src/hub/mapping.ts` | Magpie quotas → CLIProxyAPI accounts and provider-native usage |
| `src/hub/magpie.ts` | Magpie `/v1/magpie/quotas` client with a short cache |
| `src/standalone.ts` | Development/standalone entry |
| `src/cli/` | `token` and `verify` helpers |
| `tests/` | Mapping and HTTP contract tests |
| `docs/` | Architecture, protocols, operations and decisions |
| `.mcp.json` | CodeGraph MCP server configuration |

## Status

Version `0.1.0`. Read [docs/index.md](docs/index.md) for limitations: T3 Code's
CLIProxyAPI adapter only understands `codex` and `claude` accounts, so other
Magpie providers are shown through the Claude adapter with scoped bars.
