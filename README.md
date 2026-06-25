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

## Universal copy/paste setup prompt

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
- What’s my net worth?
- Summarize my recent transactions.
- What changed recently?
- What recurring charges do I have?
```

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

Warm's published/documented MCP surface is the following four-tool core:

| Tool                  | Description                                     |
| --------------------- | ----------------------------------------------- |
| `get_accounts`        | List connected accounts with current balances   |
| `get_transactions`    | Page through transactions with an opaque cursor |
| `get_financial_state` | Return the current typed financial state bundle |
| `verify_key`          | Validate the configured API key                 |

## Strict Contract

- Every tool takes a JSON object input and returns a JSON object output.
- Treat the contracts as closed and typed. Do not depend on undocumented fields.
- Calendar dates use `YYYY-MM-DD`. Incremental sync timestamps use ISO 8601 datetimes.
- Amounts are numbers, never formatted strings.
- Transaction amounts follow the Plaid sign convention:
  positive = expense/debit, negative = income/credit.
- Pagination cursors are opaque strings. Do not parse them or mix them with changed filters.

### `get_accounts`

Input:

```json
{}
```

Returns:

```json
{
  "accounts": [
    {
      "name": "Primary Checking",
      "type": "depository",
      "subtype": "checking",
      "balance": 2450.12,
      "institution": "Chase",
      "mask": "1234"
    }
  ]
}
```

### `get_transactions`

Input:

```json
{
  "limit": 100,
  "cursor": "opaque-cursor-from-a-prior-page",
  "last_knowledge": "2026-03-11T00:00:00.000Z",
  "search": "coffee"
}
```

Returns:

```json
{
  "generated_at": "2026-03-11T12:00:00.000Z",
  "next_knowledge": "2026-03-11T12:00:00.000Z",
  "txns": [
    {
      "id": "txn_123",
      "date": "2026-01-15",
      "amount": 12.34,
      "merchant": "Coffee Shop",
      "description": "COFFEE SHOP",
      "category": "FOOD_AND_DRINK",
      "detailed_category": "FOOD_AND_DRINK_COFFEE"
    }
  ],
  "pagination": {
    "limit": 100,
    "next_cursor": "opaque-next-cursor",
    "has_more": true
  }
}
```

Cursor model:

1. Omit `cursor` on the first call.
2. Keep `limit` and any filters such as `search` fixed while following a cursor chain.
3. If `pagination.next_cursor` is non-null, pass it unchanged to fetch the next page.
4. Stop when `next_cursor` is `null`.
5. Do not combine `cursor` with `last_knowledge`.

### `get_financial_state`

Input:

```json
{}
```

Returns:

```json
{
  "generated_at": "2026-03-11T12:00:00.000Z",
  "snapshots": [
    {
      "date": "2026-03-11",
      "net_worth": 125430.55,
      "total_assets": 168210.77,
      "total_liabilities": 42780.22
    }
  ],
  "recurring": [
    {
      "merchant": "Netflix",
      "amount": 15.49,
      "frequency": "MONTHLY",
      "next_date": "2026-03-18",
      "type": "subscription",
      "active": true
    }
  ],
  "budgets": [
    {
      "name": "Dining Out",
      "amount": 400,
      "spent": 182.55,
      "remaining": 217.45,
      "percent_used": 45.64,
      "period": "monthly",
      "status": "on_track"
    }
  ],
  "goals": [
    {
      "name": "Emergency Fund",
      "target": 10000,
      "current": 4200,
      "progress_percent": 42,
      "target_date": null,
      "status": "active",
      "category": "safety",
      "monthly_contribution_needed": 400
    }
  ],
  "health": {
    "score": 78,
    "label": "Good",
    "data_completeness": 94,
    "pillars": {
      "spend": 20,
      "save": 23,
      "borrow": 15,
      "build": 20
    },
    "message": null
  },
  "liabilities": [
    {
      "account_id": "acc_loan_1",
      "type": "student",
      "balance": 12450.22,
      "apr_percentage": 5.2,
      "minimum_payment": 145,
      "next_payment_due_date": "2026-03-22",
      "is_overdue": false
    }
  ],
  "holdings": [
    {
      "account_id": "acc_inv_1",
      "security_name": "Vanguard Total Stock Market ETF",
      "symbol": "VTI",
      "type": "etf",
      "quantity": 12.5,
      "value": 3541.25,
      "cost_basis": 3010
    }
  ],
  "category_spending": [
    {
      "category": "FOOD_AND_DRINK",
      "amount": 182.55
    }
  ]
}
```

If Warm does not have enough state data yet, nullable fields remain `null`.

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

## Security

- Read-only: no write, delete, transfer, or mutation tools
- Scoped: the key only reads the owner's Warm data
- Revocable: delete the key in Settings to revoke access immediately

## Development

```bash
npm install
npm run build
```

## License

MIT
