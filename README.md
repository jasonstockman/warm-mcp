# Warm MCP

Read-only MCP server for Warm financial data.

## Install

```bash
npx @warmio/mcp
```

The installer detects supported clients, prompts for your Warm API key, and writes a local
`stdio` config.

## Manual `stdio` Config

```json
{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp", "--server"],
      "env": {
        "WARM_API_KEY": "your_warm_api_key"
      }
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "warm": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@warmio/mcp", "--server"],
      "env": {
        "WARM_API_KEY": "your_warm_api_key"
      }
    }
  }
}
```

## Tool Surface

Warm exposes three MCP tools:

| Tool | Description |
|------|-------------|
| `get_state` | GraphQL-like flexible query over `accounts` and `financial_state` |
| `get_transactions` | Cursor-paginated transaction ledger export |
| `verify_key` | Validate the configured Warm API key |

## Contract

- Every tool takes JSON input and returns JSON output.
- Calendar dates are normalized to `YYYY-MM-DD`.
- Incremental sync timestamps use ISO 8601 datetimes.
- Amounts are numbers, never formatted strings.
- Transaction amounts follow the Plaid sign convention:
  positive = expense/debit, negative = income/credit.

## `get_state`

Input:

```json
{
  "query": "{ accounts { account_id name subtype balance available_balance institution mask } financial_state { generated_at health { score label data_completeness } snapshots { date net_worth total_assets total_liabilities } recurring { merchant amount frequency next_date type active } budgets { name amount spent remaining percent_used period status } goals { name target current progress_percent target_date status category monthly_contribution_needed } liabilities { account_id type balance apr_percentage minimum_payment next_payment_due_date is_overdue } holdings { account_id security_name symbol type quantity value cost_basis } category_spending { category amount } } }"
}
```

Output:

```json
{
  "data": {
    "accounts": [
      {
        "account_id": "acc_123",
        "name": "Primary Checking",
        "subtype": "checking",
        "balance": 2450.12,
        "available_balance": 2315.42,
        "institution": "Chase",
        "mask": "1234"
      }
    ],
    "financial_state": {
      "health": {
        "score": 78,
        "label": "Good",
        "data_completeness": 94
      },
      "snapshots": [
        {
          "date": "2026-03-11",
          "net_worth": 125430.55,
          "total_assets": 168210.77,
          "total_liabilities": 42780.22
        }
      ]
    }
  }
}
```

Rules:

1. Supported root fields are `accounts` and `financial_state`.
2. Supported syntax is selection sets only: field names plus nested `{ ... }`.
3. Aliases, arguments, fragments, and variables are intentionally unsupported.
4. Use `get_transactions` for ledger pagination.

## `get_transactions`

Input:

```json
{
  "limit": 100,
  "cursor": "opaque-cursor-from-a-prior-page",
  "last_knowledge": "2026-03-11T00:00:00.000Z"
}
```

Output:

```json
{
  "generated_at": "2026-03-11T12:00:00.000Z",
  "next_knowledge": "2026-03-11T12:00:00.000Z",
  "txns": [
    {
      "id": "txn_123",
      "account_id": "acc_123",
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

Cursor rules:

1. Omit `cursor` on the first call.
2. Keep `limit` fixed while following a cursor chain.
3. Stop when `next_cursor` is `null`.
4. Do not combine `cursor` with `last_knowledge`.

For account-level cash-flow analysis, join `txns[].account_id` to `data.accounts[].account_id`
and prefer `available_balance` over `balance` when it is present.

## `verify_key`

Input:

```json
{}
```

Output:

```json
{
  "valid": true,
  "status": "ok"
}
```

## Security

- Read-only only
- Scoped to the owner of the API key
- Revocable immediately from Warm settings
