# Warmio

Warmio is the one-command CLI with separate compact MCP modes for financial context and supported automations.

## Install

```bash
npx -y @warmio/mcp@latest
```

The installer detects supported MCP clients, prompts for a mode-specific Warm API key, validates
its audience, and writes the local `stdio` MCP config automatically. Context and automation keys
are stored separately and are never shared between modes.

## Requirements

- Any paid Warm plan (Plus or Pro)
- A context key or an automation key from [Settings -> API Keys](https://warm.io/settings)
- Node.js 18+

## Manual MCP Config

Context is the default read-only mode. Install it with its own key:

```bash
npx -y @warmio/mcp@latest install --mode context
```

Use this when a client asks you to paste a context MCP JSON config:

```json
{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "mcp", "--mode", "context"]
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
      "args": ["/c", "npx", "-y", "@warmio/mcp@latest", "mcp", "--mode", "context"]
    }
  }
}
```

Context credential overrides:

- `WARM_CONTEXT_API_KEY`
- `WARM_CONTEXT_API_KEY_FILE`

Automation is intentionally opt-in and must use a distinct automation key:

```bash
npx -y @warmio/mcp@latest install --mode automation
```

```json
{
  "mcpServers": {
    "warm-automation": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "mcp", "--mode", "automation"]
    }
  }
}
```

Automation credential overrides are `WARM_AUTOMATION_API_KEY` and
`WARM_AUTOMATION_API_KEY_FILE`. The default key files are `${WARM_CONFIG_DIR}/context_api_key`
and `${WARM_CONFIG_DIR}/automation_api_key`; `WARM_API_KEY` and `WARM_API_KEY_FILE` are not read.
The API verifies the key audience before every MCP tool call, so a context key cannot operate the
automation server and an automation key cannot operate the context server.

Installer validation fails closed for API responses `401` and `403`. A `429` rate limit or a
temporary network failure remains a soft validation failure so setup can finish; the MCP server
will still validate the key audience before serving tools.

Both modes send API requests to `https://app.warm.io` by default. Set `WARM_API_URL` only when an
explicit API base URL override is required.

## Universal Copy/Paste Setup Prompt

```text
I want to connect Warm to this AI app using MCP.

Use this MCP server config:

{
  "mcpServers": {
    "warm": {
      "command": "npx",
      "args": ["-y", "@warmio/mcp@latest", "mcp", "--mode", "context"]
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
npx -y @warmio/mcp@latest http --mode context --host 127.0.0.1 --port 3000 --path /mcp
```

Relevant optional environment variables:

- `WARM_MCP_HTTP_HOST`
- `WARM_MCP_HTTP_PORT`
- `WARM_MCP_HTTP_PATH`
- `WARM_MCP_ALLOWED_HOSTS`
- `WARM_MCP_AUTH_TOKEN`

`WARM_MCP_AUTH_TOKEN` is a separate bearer token for the MCP HTTP transport, never a Warm API
key. Automation HTTP always requires it, including on loopback. Context HTTP requires it whenever
the server binds anything other than the exact SDK-protected loopback hosts `127.0.0.1`,
`localhost`, or `::1`. Send it on every request as
`Authorization: Bearer <WARM_MCP_AUTH_TOKEN>`.

## MCP Tools

Context mode remains exactly three read-only tools:

| Tool                    | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `get_financial_context` | Return compact `FinancialContext` JSON           |
| `get_transactions`      | Return one month page or the fixed latest window |
| `verify_key`            | Validate the configured API key                  |

Automation mode is also exactly three tools:

| Tool                 | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `search_operations`  | Find supported operations without loading the full catalog         |
| `describe_operation` | Read an operation schema and request approval for a write input       |
| `invoke_operation`   | Invoke the operation; every write requires an `approval_id`           |

## Parameter Contract

- Every tool takes a JSON object input and returns a JSON object output.
- `get_financial_context` takes `{}` and returns compact context JSON without transaction items.
- `get_transactions` takes one required `period` string: `{ "period": "latest" }` or `{ "period": "YYYY-MM" }`.
- `period: "latest"` returns a fixed 10-day window anchored to the current artifact; the caller cannot configure the window.
- A month period must use `YYYY-MM` format, for example `2026-07`.
- A malformed month returns an error.
- A well-formed month outside the covered range returns an error.
- A well-formed month inside the covered range with no transactions returns `count: 0` and `items: []`.
- Transaction amounts follow the Plaid sign convention: positive = expense/debit, negative = income/credit.
- `describe_operation` returns `approval: { id, status, approval_url, expires_at }` for every write operation.
- `invoke_operation` accepts that approval as `approval_id`; confirmation tokens are not supported.
- Tool and Warm API failures return structured MCP results with `isError: true`; malformed MCP input remains a protocol error.

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
{ "period": "2026-07" }
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
{ "period": "latest" }
```

Latest response:

```json
{
  "since": "2026-06-26",
  "window_days": 10,
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

- Context mode is read-only and uses a context-only key.
- Automation mode uses a separate automation-only key and a curated server-side operation allowlist.
- Streamable HTTP is bearer-protected with an independent `WARM_MCP_AUTH_TOKEN` where required.
- Write operations return an approval `{ id, status, approval_url, expires_at }`; invoke the exact input with its `approval_id`.
- Revocable: delete the key in Settings to revoke access immediately

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
