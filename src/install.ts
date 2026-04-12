import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, platform } from 'os';

import { verifyWarmApiKey } from './server.js';
import { getWarmApiKeyPath } from './config-paths.js';

const HOME = homedir();
const CWD = process.cwd();

export interface InstallOptions {
  force?: boolean;
  validateApiKey?: boolean;
}

interface Client {
  name: string;
  configPath: string;
  format: 'json' | 'toml';
  alwaysInclude?: boolean;
  isProjectLevel?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getClaudeDesktopPath(): string {
  if (platform() === 'win32') {
    return join(
      process.env.APPDATA || join(HOME, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json'
    );
  }

  if (platform() === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }

  return join(HOME, '.config', 'claude', 'claude_desktop_config.json');
}

const GLOBAL_CLIENTS: Client[] = [
  {
    name: 'Claude Code',
    configPath: join(HOME, '.claude.json'),
    format: 'json',
    alwaysInclude: true,
  },
  { name: 'Claude Desktop', configPath: getClaudeDesktopPath(), format: 'json' },
  { name: 'Cursor', configPath: join(HOME, '.cursor', 'mcp.json'), format: 'json' },
  {
    name: 'Windsurf',
    configPath: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
  },
  {
    name: 'OpenCode',
    configPath: join(HOME, '.config', 'opencode', 'opencode.json'),
    format: 'json',
  },
  { name: 'Codex CLI', configPath: join(HOME, '.codex', 'config.toml'), format: 'toml' },
  {
    name: 'Antigravity',
    configPath: join(HOME, '.gemini', 'antigravity', 'mcp_config.json'),
    format: 'json',
  },
  { name: 'Gemini CLI', configPath: join(HOME, '.gemini', 'settings.json'), format: 'json' },
];

const PROJECT_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'];

const MCP_CONFIG =
  platform() === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', '-y', '@warmio/mcp', '--server'] }
    : { command: 'npx', args: ['-y', '@warmio/mcp', '--server'] };

const WARM_API_KEY_PATH = getWarmApiKeyPath();

function detectProjectClients(): Client[] {
  const found: Client[] = [];
  for (const name of PROJECT_CONFIGS) {
    const configPath = resolve(CWD, name);
    if (existsSync(configPath)) {
      found.push({
        name: `Project (${name})`,
        configPath,
        format: 'json',
        isProjectLevel: true,
      });
    }
  }
  return found;
}

function isDetected(client: Client): boolean {
  if (client.alwaysInclude) {
    return true;
  }

  return existsSync(dirname(client.configPath));
}

function isConfigured(client: Client): boolean {
  if (!existsSync(client.configPath)) {
    return false;
  }

  try {
    const content = readFileSync(client.configPath, 'utf-8');
    if (client.format === 'toml') {
      return content.includes('[mcp_servers.warm]');
    }
    return !!JSON.parse(content)?.mcpServers?.warm;
  } catch {
    return false;
  }
}

function configureJson(client: Client): void {
  let config: Record<string, unknown> = {};
  if (existsSync(client.configPath)) {
    try {
      config = JSON.parse(readFileSync(client.configPath, 'utf-8'));
    } catch {
      // Start from an empty config if the existing file is invalid.
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const existing = isRecord(servers.warm) ? servers.warm : undefined;
  const existingEnv = isRecord(existing?.env) ? existing.env : {};
  const nextEnv = { ...existingEnv } as Record<string, unknown>;

  delete nextEnv.WARM_API_KEY;

  if (client.isProjectLevel && existing?.command) {
    servers.warm = {
      ...existing,
      ...(Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    };
  } else {
    servers.warm = {
      ...existing,
      ...MCP_CONFIG,
      ...(Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    };
  }

  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(client.configPath, JSON.stringify(config, null, 2) + '\n');
}

function configureToml(client: Client): void {
  let content = '';
  if (existsSync(client.configPath)) {
    content = readFileSync(client.configPath, 'utf-8');
    if (!content.endsWith('\n')) {
      content += '\n';
    }
  }

  const tomlCommand = platform() === 'win32' ? 'cmd' : 'npx';
  const tomlArgs =
    platform() === 'win32'
      ? '["/c", "npx", "-y", "@warmio/mcp", "--server"]'
      : '["-y", "@warmio/mcp", "--server"]';
  const warmBlock = `[mcp_servers.warm]\ncommand = "${tomlCommand}"\nargs = ${tomlArgs}\n`;
  const warmBlockPattern = /\n?\[mcp_servers\.warm\][\s\S]*?(?=\n\[[^\n]+\]|\s*$)/g;

  let nextContent = content.replace(warmBlockPattern, '').trimEnd();
  if (nextContent.length > 0) {
    nextContent += '\n\n';
  }
  nextContent += warmBlock;

  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(client.configPath, nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`);
}

function configure(client: Client): void {
  if (client.format === 'json') {
    configureJson(client);
    return;
  }

  configureToml(client);
}

function shortPath(filePath: string): string {
  return filePath.replace(HOME, '~').replace(CWD, '.');
}

function prompt(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

function isBlockingValidationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('invalid or expired api key') ||
    normalized.includes('pro subscription required')
  );
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  console.log('  Validating API key...');

  try {
    const result = await verifyWarmApiKey(apiKey);
    if (!result.valid) {
      console.log(`  Validation failed: ${result.status}`);
      console.log('  Check https://warm.io/settings and try again.');
      console.log('');
      return false;
    }

    console.log('  API key verified.');
    console.log('');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isBlockingValidationError(message)) {
      console.log(`  Validation failed: ${message}`);
      console.log('');
      return false;
    }

    console.log(`  Could not validate right now: ${message}`);
    console.log('  Continuing setup with the provided key.');
    console.log('');
    return true;
  }
}

function storeApiKey(apiKey: string): void {
  mkdirSync(dirname(WARM_API_KEY_PATH), { recursive: true });
  writeFileSync(WARM_API_KEY_PATH, `${apiKey}\n`, { mode: 0o600 });
}

export async function install(options: InstallOptions = {}): Promise<void> {
  const force = options.force ?? false;
  const shouldValidateApiKey = options.validateApiKey ?? true;

  console.log('');
  console.log('  Warm MCP Server Installer');
  console.log('  -------------------------');
  console.log('');

  const globalClients = GLOBAL_CLIENTS.filter(isDetected);
  const projectClients = detectProjectClients();
  const allClients = [...globalClients, ...projectClients];
  const needsSetup = allClients.filter((client) => !isConfigured(client) || force);

  console.log('  MCP clients found:');
  allClients.forEach((client) => {
    const configured = isConfigured(client);
    const status = configured && !force ? 'configured' : 'not configured';
    console.log(
      `    ${client.name.padEnd(22)} ${shortPath(client.configPath).padEnd(55)} ${status}`
    );
  });
  console.log('');

  if (needsSetup.length === 0) {
    console.log('  All clients already configured!');
    console.log('  Run with --force to update the API key.');
    console.log('');
    return;
  }

  const apiKey = await prompt('  Warm API key: ');
  if (!apiKey) {
    console.log('');
    console.log('  No key provided. Get one at https://warm.io/settings');
    console.log('');
    return;
  }

  if (shouldValidateApiKey) {
    const isValid = await validateApiKey(apiKey);
    if (!isValid) {
      return;
    }
  }

  storeApiKey(apiKey);

  console.log('  Configuring...');
  console.log('');

  needsSetup.forEach((client) => {
    try {
      configure(client);
      console.log(`    ${client.name.padEnd(22)} done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    ${client.name.padEnd(22)} failed: ${message}`);
    }
  });

  console.log('');
  console.log(`  Stored API key at ${shortPath(WARM_API_KEY_PATH)}`);
  console.log('  All set! Restart your MCP clients and try:');
  console.log('    "What\'s my net worth?"');
  console.log('');
}
