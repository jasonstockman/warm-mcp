# @warmio/mcp

`@warmio/mcp` is Warm's local stdio MCP server. Run the interactive installer to validate and store one full-access `WARM_API_KEY`, then configure detected supported clients:

```sh
npx -y @warmio/mcp@latest install
```

Each client starts the server with:

```sh
npx -y @warmio/mcp@latest mcp
```

The server exposes financial-context read tools plus the automation operation catalog.
