# Warm MCP Server

MCP server that gives Claude Code (or any MCP client) read-only access to your Warm financial data.

## Quick Start

```bash
npx @warmio/mcp
```

Detects installed MCP clients, prompts for your API key, and configures everything automatically.
Works on macOS, Linux, and Windows. Supports: Claude Code, Claude Desktop, Cursor, Windsurf, OpenCode, Codex CLI, Antigravity, Gemini CLI.

After setup, open your MCP client and ask:
- "What's my net worth?"
- "How much did I spend on restaurants last month?"
- "Show me my subscriptions"

## Options

| Command | Description |
|---------|-------------|
| `npx @warmio/mcp` | Run the installer / configurator |
| `npx @warmio/mcp --force` | Re-run installer (updates API key in all configs) |
| `npx @warmio/mcp --server` | Start the MCP server (used internally by clients) |

## Requirements

- **Pro subscription** — API access requires Warm Pro
- **API key** — Generate in [Settings → API Keys](https://warm.io/settings)
- **Node.js 18+** — For running the MCP server

## How It Works

1. You run `npx @warmio/mcp` once
2. It detects which MCP clients you have installed
3. Prompts for your Warm API key
4. Writes the server config into each client's settings
5. Each client is configured to run `npx -y @warmio/mcp --server` on demand

The MCP server starts automatically when your client needs it — you never run it manually.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_accounts` | List all connected bank accounts with balances |
| `get_transactions` | Get transactions with date/limit filters |
| `get_recurring` | Show subscriptions and recurring income/expenses |
| `get_snapshots` | Daily net worth history |
| `verify_key` | Check if API key is valid |

## Security

- **Read-only** — Cannot modify, delete, or transfer data
- **Scoped** — Key only accesses your accounts
- **Revocable** — Delete key in Settings to revoke instantly

## Development

```bash
cd mcp
npm install
npm run build
```

## License

MIT
