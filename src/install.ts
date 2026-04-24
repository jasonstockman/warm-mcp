import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, platform } from 'os';

import { verifyWarmApiKey } from './server.js';
import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';

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

type ClientSetupState = 'configured' | 'missing' | 'needs_migration';

interface ClientStatus {
  client: Client;
  hasApiKeyFileOverride: boolean;
  inlineApiKey: string | null;
  state: ClientSetupState;
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
const MCP_PACKAGE_SPEC = '@warmio/mcp@latest';

const MCP_CONFIG =
  platform() === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', '-y', MCP_PACKAGE_SPEC, '--server'] }
    : { command: 'npx', args: ['-y', MCP_PACKAGE_SPEC, '--server'] };

const WARM_API_KEY_PATH = getWarmApiKeyPath();
const WARM_TOML_BLOCK_PATTERN = /\n?\[mcp_servers\.warm\][\s\S]*?(?=\n\[[^\n]+\]|\s*$)/g;
const WARM_TOML_ENV_BLOCK_PATTERN = /\n?\[mcp_servers\.warm\.env\][\s\S]*?(?=\n\[[^\n]+\]|\s*$)/g;

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

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isWarmPackageSpecifier(value: string): boolean {
  return /^@warmio\/mcp(?:@.+)?$/.test(value);
}

function isLegacyWarmPackageSpecifier(value: string): boolean {
  return /^@anthropic\/warm-mcp-server(?:@.+)?$/.test(value);
}

function normalizePathLikeValue(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function isLocalWarmMcpPath(value: string): boolean {
  const normalized = normalizePathLikeValue(value);
  return normalized.includes('/warm-mcp/dist/index.js') || normalized.endsWith('/warm-mcp');
}

function isSupportedWarmInvocation(command: string | undefined, args: string[]): boolean {
  return [command, ...args].some(
    (value): value is string =>
      typeof value === 'string' &&
      (isWarmPackageSpecifier(value) || isLocalWarmMcpPath(value))
  );
}

function isLegacyWarmInvocation(command: string | undefined, args: string[]): boolean {
  return [command, ...args].some(
    (value): value is string =>
      typeof value === 'string' && isLegacyWarmPackageSpecifier(value)
  );
}

function getJsonEnvStatus(server: Record<string, unknown> | undefined): {
  hasApiKeyFileOverride: boolean;
  inlineApiKey: string | null;
} {
  const env = isRecord(server?.env) ? server.env : undefined;
  const inlineApiKey =
    typeof env?.WARM_API_KEY === 'string' && env.WARM_API_KEY.trim()
      ? env.WARM_API_KEY.trim()
      : null;

  return {
    hasApiKeyFileOverride:
      typeof env?.WARM_API_KEY_FILE === 'string' && env.WARM_API_KEY_FILE.trim().length > 0,
    inlineApiKey,
  };
}

function getJsonStatus(client: Client, content: string): ClientStatus {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
    const server = isRecord(servers?.warm) ? servers.warm : undefined;
    const envStatus = getJsonEnvStatus(server);

    if (!server) {
      return { client, state: 'missing', ...envStatus };
    }

    const command = typeof server.command === 'string' ? server.command : undefined;
    const args = getStringArray(server.args);

    if (client.isProjectLevel && command && !isLegacyWarmInvocation(command, args)) {
      return { client, state: 'configured', ...envStatus };
    }

    if (isSupportedWarmInvocation(command, args)) {
      return { client, state: 'configured', ...envStatus };
    }

    return { client, state: 'needs_migration', ...envStatus };
  } catch {
    return { client, state: 'missing', hasApiKeyFileOverride: false, inlineApiKey: null };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTomlSection(content: string, sectionName: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(sectionName)}\\]\\n([\\s\\S]*?)(?=\\n\\[[^\\n]+\\]|\\s*$)`
  );
  const match = content.match(pattern);

  return match ? match[0].replace(/^\n/, '') : null;
}

function getTomlStringValue(block: string | null, key: string): string | undefined {
  if (!block) {
    return undefined;
  }

  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`, 'm');
  const match = block.match(pattern);

  return match?.[1] ?? match?.[2];
}

function getTomlStringArrayValue(block: string | null, key: string): string[] {
  if (!block) {
    return [];
  }

  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'm');
  const match = block.match(pattern);
  if (!match) {
    return [];
  }

  const values: string[] = [];
  const valuePattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/g;

  for (const item of match[1].matchAll(valuePattern)) {
    values.push(item[1] ?? item[2] ?? '');
  }

  return values;
}

function getTomlEnvStatus(content: string): {
  envLines: string[];
  hasApiKeyFileOverride: boolean;
  inlineApiKey: string | null;
} {
  const envBlock = getTomlSection(content, 'mcp_servers.warm.env');
  if (!envBlock) {
    return { envLines: [], hasApiKeyFileOverride: false, inlineApiKey: null };
  }

  const envLines = envBlock.split('\n').slice(1).filter((line) => line.trim().length > 0);
  const inlineApiKey = getTomlStringValue(envBlock, 'WARM_API_KEY')?.trim() || null;
  const apiKeyFile = getTomlStringValue(envBlock, 'WARM_API_KEY_FILE');

  return {
    envLines,
    hasApiKeyFileOverride: typeof apiKeyFile === 'string' && apiKeyFile.trim().length > 0,
    inlineApiKey,
  };
}

function getTomlStatus(client: Client, content: string): ClientStatus {
  const warmBlock = getTomlSection(content, 'mcp_servers.warm');
  const envStatus = getTomlEnvStatus(content);

  if (!warmBlock) {
    return { client, state: 'missing', ...envStatus };
  }

  const command = getTomlStringValue(warmBlock, 'command');
  const args = getTomlStringArrayValue(warmBlock, 'args');

  if (isSupportedWarmInvocation(command, args)) {
    return { client, state: 'configured', ...envStatus };
  }

  return { client, state: 'needs_migration', ...envStatus };
}

function getClientStatus(client: Client): ClientStatus {
  if (!existsSync(client.configPath)) {
    return { client, state: 'missing', hasApiKeyFileOverride: false, inlineApiKey: null };
  }

  const content = readFileSync(client.configPath, 'utf-8');

  if (client.format === 'toml') {
    return getTomlStatus(client, content);
  }

  return getJsonStatus(client, content);
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
  const existingCommand = typeof existing?.command === 'string' ? existing.command : undefined;
  const existingArgs = getStringArray(existing?.args);
  const preserveProjectCommand =
    client.isProjectLevel &&
    !!existingCommand &&
    !isLegacyWarmInvocation(existingCommand, existingArgs) &&
    !isWarmPackageSpecifier(existingCommand);

  delete nextEnv.WARM_API_KEY;

  if (preserveProjectCommand) {
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
      ? `["/c", "npx", "-y", "${MCP_PACKAGE_SPEC}", "--server"]`
      : `["-y", "${MCP_PACKAGE_SPEC}", "--server"]`;
  const warmBlock = `[mcp_servers.warm]\ncommand = "${tomlCommand}"\nargs = ${tomlArgs}\n`;
  const preservedEnvLines = getTomlEnvStatus(content).envLines.filter(
    (line) => !/^\s*WARM_API_KEY\s*=/.test(line)
  );
  let nextContent = content
    .replace(WARM_TOML_ENV_BLOCK_PATTERN, '')
    .replace(WARM_TOML_BLOCK_PATTERN, '')
    .trimEnd();
  if (nextContent.length > 0) {
    nextContent += '\n\n';
  }
  nextContent += warmBlock;
  if (preservedEnvLines.length > 0) {
    nextContent += `\n[mcp_servers.warm.env]\n${preservedEnvLines.join('\n')}\n`;
  }

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

function getStatusLabel(status: ClientSetupState, force: boolean): string {
  if (force) {
    return 'not configured';
  }

  if (status === 'configured') {
    return 'configured';
  }

  if (status === 'needs_migration') {
    return 'needs migration';
  }

  return 'not configured';
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
  const clientStatuses = allClients.map(getClientStatus);
  const needsSetup = clientStatuses.filter((status) => force || status.state !== 'configured');

  console.log('  MCP clients found:');
  clientStatuses.forEach((status) => {
    console.log(
      `    ${status.client.name.padEnd(22)} ${shortPath(status.client.configPath).padEnd(55)} ${getStatusLabel(status.state, force)}`
    );
  });
  console.log('');

  if (needsSetup.length === 0) {
    console.log('  All clients already configured!');
    console.log('  Run with --force to update the API key.');
    console.log('');
    return;
  }

  const storedApiKey = readConfigFile(WARM_API_KEY_PATH);
  const migratedApiKey =
    needsSetup.find((status) => typeof status.inlineApiKey === 'string' && status.inlineApiKey.length > 0)
      ?.inlineApiKey ?? null;
  const hasApiKeyFileOverride = needsSetup.some((status) => status.hasApiKeyFileOverride);

  let apiKeyToStore: string | null = null;
  let shouldStoreApiKey = false;
  let shouldPromptForApiKey = force;

  if (!shouldPromptForApiKey) {
    if (storedApiKey) {
      console.log('  Using stored Warm API key.');
      console.log('');
      apiKeyToStore = storedApiKey;
    } else if (migratedApiKey) {
      console.log('  Reusing Warm API key from existing client config.');
      console.log('');
      apiKeyToStore = migratedApiKey;
      shouldStoreApiKey = true;
    } else if (hasApiKeyFileOverride) {
      console.log('  Reusing existing WARM_API_KEY_FILE override.');
      console.log('');
    } else {
      shouldPromptForApiKey = true;
    }
  }

  if (shouldPromptForApiKey) {
    const apiKey = await prompt('  Warm API key: ');
    if (!apiKey) {
      console.log('');
      console.log('  No key provided. Get one at https://warm.io/settings');
      console.log('');
      return;
    }

    apiKeyToStore = apiKey;
    shouldStoreApiKey = true;
  }

  if (apiKeyToStore && shouldValidateApiKey && (shouldStoreApiKey || force)) {
    const isValid = await validateApiKey(apiKeyToStore);
    if (!isValid) {
      return;
    }
  }

  if (apiKeyToStore && shouldStoreApiKey) {
    storeApiKey(apiKeyToStore);
  }

  console.log('  Configuring...');
  console.log('');

  needsSetup.forEach((status) => {
    try {
      configure(status.client);
      console.log(`    ${status.client.name.padEnd(22)} done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    ${status.client.name.padEnd(22)} failed: ${message}`);
    }
  });

  console.log('');
  if (apiKeyToStore) {
    console.log(`  Stored API key at ${shortPath(WARM_API_KEY_PATH)}`);
  }
  console.log('  All set! Restart your MCP clients and try:');
  console.log('    "What\'s my net worth?"');
  console.log('');
}
