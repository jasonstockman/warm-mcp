export const WARM_MCP_PACKAGE_NAME = '@warmio/mcp' as const;
export const WARM_MCP_PACKAGE_SPEC = `${WARM_MCP_PACKAGE_NAME}@latest` as const;
export const WARM_MCP_INSTALL_COMMAND = `npx -y ${WARM_MCP_PACKAGE_SPEC}` as const;

export const WARM_MCP_CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', format: 'json' },
  { id: 'claude-desktop', name: 'Claude Desktop', format: 'json' },
  { id: 'cursor', name: 'Cursor', format: 'json' },
  { id: 'windsurf', name: 'Windsurf', format: 'json' },
  { id: 'opencode', name: 'OpenCode', format: 'json' },
  { id: 'codex-cli', name: 'Codex CLI', format: 'toml' },
  { id: 'antigravity', name: 'Antigravity', format: 'json' },
  { id: 'gemini-cli', name: 'Gemini CLI', format: 'json' },
] as const;

export type WarmMcpClientId = (typeof WARM_MCP_CLIENTS)[number]['id'];

export const WARM_MCP_PROJECT_CONFIGS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
] as const;

export const WARM_MCP_SERVER_COMMANDS = {
  automation: `${WARM_MCP_INSTALL_COMMAND} mcp --mode automation`,
  context: `${WARM_MCP_INSTALL_COMMAND} mcp --mode context`,
} as const;

export const WARM_MCP_MANIFEST = {
  clients: WARM_MCP_CLIENTS,
  installCommand: WARM_MCP_INSTALL_COMMAND,
  packageName: WARM_MCP_PACKAGE_NAME,
  packageSpec: WARM_MCP_PACKAGE_SPEC,
  projectConfigs: WARM_MCP_PROJECT_CONFIGS,
  serverCommands: WARM_MCP_SERVER_COMMANDS,
} as const;
