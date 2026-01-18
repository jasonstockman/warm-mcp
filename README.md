# Warm MCP Server

MCP server that gives Claude Code (or any MCP client) read-only access to your Warm financial data.

## Quick Install

```bash
curl -fsSL https://warm.io/install | bash
```

Auto-configures: Claude Code, Cursor, Windsurf, Claude Desktop, OpenCode, Codex CLI, Antigravity, Gemini CLI.

## Manual Installation

### Claude Code (easiest)

```bash
claude mcp add --scope user --env WARM_API_KEY=your-key warm -- npx -y @anthropic/warm-mcp-server
```

### Other Tools

Add to your tool's MCP config file:

| Tool | Config Path | Format |
|------|-------------|--------|
| Claude Code | `~/.claude.json` | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON |
| OpenCode | `~/.config/opencode/opencode.json` | JSON |
| Codex CLI | `~/.codex/config.toml` | TOML |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | JSON |
| Gemini CLI | `~/.gemini/settings.json` | JSON |

**JSON format** (most tools):
```json
{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@anthropic/warm-mcp-server"],
      "env": { "WARM_API_KEY": "your-api-key" }
    }
  }
}
```

**TOML format** (Codex CLI):
```toml
[mcp_servers.warm]
command = "npx"
args = ["-y", "@anthropic/warm-mcp-server"]

[mcp_servers.warm.env]
WARM_API_KEY = "your-api-key"
```

Get your API key from [warm.io/settings](https://warm.io/settings) → API Keys.

## Requirements

- **Pro subscription** — API access requires Warm Pro
- **API key** — Generate in Settings → API Keys
- **Node.js 18+** — For running the MCP server

## Available Tools

| Tool | Description |
|------|-------------|
| `get_accounts` | List all connected bank accounts with balances |
| `get_transactions` | Get transactions with date/limit filters |
| `get_recurring` | Show subscriptions and recurring payments |
| `get_snapshots` | Net worth history (daily or monthly) |
| `verify_key` | Check if API key is valid |

## Usage

Once configured, just ask Claude naturally:

- "How much did I spend on restaurants last month?"
- "What's my net worth?"
- "Show my subscriptions"
- "What are my biggest expenses?"

Claude will automatically use the MCP tools to query your data.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `WARM_API_KEY` | Your Warm API key (required) | — |
| `WARM_API_URL` | API base URL | `https://warm.io` |

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
