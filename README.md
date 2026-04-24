# Warm MCP

Read-only MCP server for Warm financial data.

This package starts in local `stdio` mode by default and also supports optional Streamable HTTP.

## Install

```bash
npx -y @warmio/mcp@latest
```

The installer detects supported MCP clients, prompts for your Warm API key, and writes the local
`stdio` server config automatically. The key is stored once in your local Warm profile instead of
being duplicated into every MCP client config.

Use `@latest` when you want the newest published package. Bare `npx @warmio/mcp` can reuse a
cached or local copy and leave you on an older version. If you want a deterministic install,
replace `@latest` with an exact version such as `@warmio/mcp@4.3.1`.

When launched without arguments in a non-interactive context, the binary automatically starts the
`stdio` server instead of the installer. This keeps MCP clients that invoke the package directly
from falling into the interactive setup flow.

## Requirements

- Warm Pro
- A Warm API key from [Settings -> API Keys](https://warm.io/settings)
- Node.js 18+

## Manual `stdio` Config

The installer stores your API key in the Warm config directory and generated MCP client configs can
stay secret-free:

```json
{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "--server"]
    }
  }
}
```

If you already have a client config that uses bare `@warmio/mcp`, update it to `@warmio/mcp@latest`
or an exact version and restart the client.

Optional auth overrides:

- `WARM_API_KEY`
- `WARM_API_KEY_FILE`

On Windows, prefer:

```json
{
  "mcpServers": {
    "warm": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@warmio/mcp@latest", "--server"]
    }
  }
}
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
