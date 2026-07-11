# Warmio

Warmio is the one-command CLI and read-only MCP server for Warm financial data.

## Install

```bash
npx -y @warmio/mcp@latest
```

The installer detects supported MCP clients, prompts for your Warm API key, validates it, and
writes the local `stdio` MCP config automatically. The key is stored once in your local Warm
profile instead of being duplicated into every MCP client config.

## Requirements

- Warm Pro
- A Warm API key from [Settings -> API Keys](https://warm.io/settings)
- Node.js 18+

## Manual MCP Config

Use this when a client asks you to paste an MCP JSON config:

```json
{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "mcp"]
    }
  }
}
```

On Windows, prefer:

```json
{
  "mcpServers": {
    "warm": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@warmio/mcp@latest", "mcp"]
    }
  }
}
```

Optional auth overrides:

- `WARM_API_KEY`
- `WARM_API_KEY_FILE`

## Universal Copy/Paste Setup Prompt

```text
I want to connect Warm to this AI app using MCP.

Use this MCP server config:

{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "mcp"]
    }
  }
}

If this app supports MCP configuration, add a server named "warm" with that command.

Do not ask me to paste my Warm API key into this chat. Help me store it locally using Warm's setup
flow, then test the connection by calling Warm's verify_key tool.

After setup, I should be able to ask:
- What is my net worth?
- Summarize my recent transactions.
- What changed recently?
- What recurring charges do I have?
```

## CLI

```bash
npx -y @warmio/mcp@latest context get
npx -y @warmio/mcp@latest context meta
npx -y @warmio/mcp@latest transactions get --month 2026-07
npx -y @warmio/mcp@latest transactions get --latest
```

All CLI read commands print JSON.

## Optional Streamable HTTP

If your MCP client supports Streamable HTTP, you can run:

```bash
npx -y @warmio/mcp@latest http --host 127.0.0.1 --port 3000 --path /mcp
```

Relevant optional environment variables:

- `WARM_MCP_HTTP_HOST`
- `WARM_MCP_HTTP_PORT`
- `WARM_MCP_HTTP_PATH`
- `WARM_MCP_ALLOWED_HOSTS`

## Core Tools

Warm's v6 MCP surface is exactly three tools:

| Tool                    | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `get_financial_context` | Return compact `FinancialContext` JSON           |
| `get_transactions`      | Return one month page or the fixed latest window |
| `verify_key`            | Validate the configured API key                  |

## Parameter Contract

- Every tool takes a JSON object input and returns a JSON object output.
- `get_financial_context` takes `{}` and returns compact context JSON without transaction items.
- `get_transactions` takes either `{ "month": "YYYY-MM" }`, `{ "latest": true }`, or `{}`.
- A bare `get_transactions` call with no arguments defaults to `{ "latest": true }`.
- `month` must use `YYYY-MM` format, for example `2026-07`.
- `latest` is a fixed 10-day window anchored to the current artifact; the caller cannot configure the window.
- `month` and `latest` are mutually exclusive.
- A malformed month returns an error.
- A well-formed month outside the covered range returns an error.
- A well-formed month inside the covered range with no transactions returns `count: 0` and `items: []`.
- Transaction amounts follow the Plaid sign convention: positive = expense/debit, negative = income/credit.

## Shapes

### `get_financial_context`

Input:

```json
{}
```

Returns compact `FinancialContext`:

```json
{
  "version": "v1",
  "updated_at": "2026-07-06T11:58:41.000Z",
  "currency": "USD",
  "status": {
    "position": {
      "date": "2026-07-06",
      "net_worth": 84500,
      "cash": 18200,
      "debt": 6400,
      "investments": 72700,
      "other_assets": 0,
      "total_assets": 90900
    },
    "accounts": []
  },
  "transactions": {
    "total": 2,
    "months": [{ "month": "2026-07", "count": 2 }]
  },
  "recurring": [],
  "budgets": [],
  "goals": [],
  "snapshots": [],
  "liabilities": [],
  "holdings": [],
  "health": null
}
```

### `get_transactions`

Month input:

```json
{ "month": "2026-07" }
```

Month response:

```json
{
  "month": "2026-07",
  "start_date": "2026-07-01",
  "end_date": "2026-07-31",
  "count": 1,
  "items": [
    {
      "id": "txn_1",
      "account_id": "acct_1",
      "date": "2026-07-05",
      "amount": 42.18,
      "merchant": "Whole Foods",
      "name": "WHOLE FOODS",
      "category": "FOOD_AND_DRINK",
      "subcategory": "FOOD_AND_DRINK_GROCERIES",
      "pending": false,
      "currency": "USD"
    }
  ]
}
```

Latest input:

```json
{ "latest": true }
```

Latest response:

```json
{
  "since": "2026-06-26",
  "window_days": 10,
  "count": 1,
  "items": []
}
```

### `verify_key`

Input:

```json
{}
```

Returns:

```json
{
  "valid": true,
  "status": "ok"
}
```

## v6 Breaking Changes

v6 is a clean break with no backwards compatibility and no alias window.

- `get_accounts` is removed. Use `get_financial_context.status.accounts`.
- `get_financial_state` is removed. Use `get_financial_context`.
- `get_transactions` no longer supports `cursor`, `search`, or `last_knowledge`.
- The old `txns` transaction array is gone. Transaction responses use `items`.
- Renamed fields follow the FinancialContext contract, including `subcategory`, `used_percent`,
  `status`, `due_date`, and `other_assets`.

## Security

- Read-only: no write, delete, transfer, or mutation tools
- Scoped: the key only reads the owner's Warm data
- Revocable: delete the key in Settings to revoke access immediately

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
