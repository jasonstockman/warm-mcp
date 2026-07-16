import { createInterface } from 'readline';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, platform } from 'os';
import {
  WARM_MCP_CLIENTS,
  WARM_MCP_CREDENTIALS,
  WARM_MCP_PROJECT_CONFIGS,
  WARM_MCP_SERVER_CONFIGS,
  type PrivateMcpMode,
  type WarmMcpClientId,
  type WarmMcpConfigPath,
} from '@warmio/contracts/mcp';

import { verifyWarmApiKey, WarmApiError } from './server.js';
import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';

const HOME = homedir();
const CWD = process.cwd();

export interface InstallOptions {
  force?: boolean;
  mode?: PrivateMcpMode;
  validateApiKey?: boolean;
}

interface Client {
  name: string;
  configPath: string;
  format: 'json' | 'toml';
  alwaysInclude?: boolean;
  isProjectLevel?: boolean;
}

type ClientSetupState = 'configured' | 'missing' | 'needs_setup';

interface ClientStatus {
  apiKeyFileOverride: string | null;
  client: Client;
  credentialApiKey: string | null;
  inlineApiKey: string | null;
  state: ClientSetupState;
}

interface ClientEnvStatus {
  apiKeyFileOverride: string | null;
  hasIrrelevantCredential: boolean;
  inlineApiKey: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveClientConfigPath(configPath: WarmMcpConfigPath): string {
  const root =
    configPath.root === 'appData' ? process.env.APPDATA || join(HOME, 'AppData', 'Roaming') : HOME;
  return join(root, ...configPath.segments);
}

function getClientConfigPath(clientId: WarmMcpClientId): string {
  const client = WARM_MCP_CLIENTS.find((candidate) => candidate.id === clientId);
  if (!client) {
    throw new Error(`Unsupported MCP client: ${clientId}`);
  }

  const currentPlatform = platform();
  const configPath =
    currentPlatform === 'darwin'
      ? client.configPaths.darwin
      : currentPlatform === 'win32'
        ? client.configPaths.win32
        : client.configPaths.linux;
  return resolveClientConfigPath(configPath);
}

const GLOBAL_CLIENTS: Client[] = WARM_MCP_CLIENTS.map((client) => ({
  name: client.name,
  format: client.format,
  configPath: getClientConfigPath(client.id),
  alwaysInclude: 'alwaysInclude' in client && client.alwaysInclude,
}));

function getServerName(mode: PrivateMcpMode): string {
  return WARM_MCP_SERVER_CONFIGS[mode].serverName;
}

function getCredential(mode: PrivateMcpMode) {
  return WARM_MCP_CREDENTIALS[mode];
}

function getOppositeCredential(mode: PrivateMcpMode) {
  return WARM_MCP_CREDENTIALS[mode === 'automation' ? 'context' : 'automation'];
}

function getMcpConfig(mode: PrivateMcpMode) {
  const serverConfig = WARM_MCP_SERVER_CONFIGS[mode];
  return platform() === 'win32'
    ? { command: 'cmd', args: ['/c', serverConfig.command, ...serverConfig.args] }
    : { command: serverConfig.command, args: [...serverConfig.args] };
}

function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function detectProjectClients(): Client[] {
  const found: Client[] = [];
  for (const name of WARM_MCP_PROJECT_CONFIGS) {
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

function isSupportedWarmInvocation(
  command: string | undefined,
  args: string[],
  mode: PrivateMcpMode
): boolean {
  if (command !== 'npx' && command !== 'cmd') {
    return false;
  }

  return (
    args.some((value) => isWarmPackageSpecifier(value)) &&
    args.includes('mcp') &&
    args.includes('--mode') &&
    args.includes(mode)
  );
}

function getJsonEnvStatus(
  server: Record<string, unknown> | undefined,
  mode: PrivateMcpMode
): ClientEnvStatus {
  const env = isRecord(server?.env) ? server.env : undefined;
  const credential = getCredential(mode);
  const oppositeCredential = getOppositeCredential(mode);
  const apiKeyName = credential.apiKeyEnv;
  const apiKeyFileName = credential.apiKeyFileEnv;
  const inlineApiKey =
    typeof env?.[apiKeyName] === 'string' && env[apiKeyName].trim() ? env[apiKeyName].trim() : null;

  return {
    apiKeyFileOverride:
      typeof env?.[apiKeyFileName] === 'string' && env[apiKeyFileName].trim().length > 0
        ? env[apiKeyFileName].trim()
        : null,
    hasIrrelevantCredential: [
      'WARM_API_KEY',
      'WARM_API_KEY_FILE',
      oppositeCredential.apiKeyEnv,
      oppositeCredential.apiKeyFileEnv,
    ].some((name) => typeof env?.[name] === 'string' && env[name].trim().length > 0),
    inlineApiKey,
  };
}

function resolveApiKeyFileOverride(filePath: string): string {
  if (filePath === '~') {
    return HOME;
  }
  if (filePath.startsWith('~/')) {
    return join(HOME, filePath.slice(2));
  }
  return resolve(filePath);
}

function createClientStatus(
  client: Client,
  invocationState: ClientSetupState,
  envStatus: ClientEnvStatus,
  mode: PrivateMcpMode
): ClientStatus {
  const credentialApiKey =
    envStatus.inlineApiKey ||
    (envStatus.apiKeyFileOverride
      ? readConfigFile(resolveApiKeyFileOverride(envStatus.apiKeyFileOverride))
      : readConfigFile(getWarmApiKeyPath(mode)));
  const state =
    invocationState === 'configured' && credentialApiKey && !envStatus.hasIrrelevantCredential
      ? 'configured'
      : invocationState === 'missing'
        ? 'missing'
        : 'needs_setup';

  return { client, credentialApiKey, state, ...envStatus };
}

function getJsonStatus(client: Client, content: string, mode: PrivateMcpMode): ClientStatus {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
    const candidate = servers?.[getServerName(mode)];
    const server = isRecord(candidate) ? candidate : undefined;
    const envStatus = getJsonEnvStatus(server, mode);

    if (!server) {
      return createClientStatus(client, 'missing', envStatus, mode);
    }

    const command = typeof server.command === 'string' ? server.command : undefined;
    const args = getStringArray(server.args);

    if (isSupportedWarmInvocation(command, args, mode)) {
      return createClientStatus(client, 'configured', envStatus, mode);
    }

    return createClientStatus(client, 'needs_setup', envStatus, mode);
  } catch {
    return createClientStatus(
      client,
      'missing',
      { apiKeyFileOverride: null, hasIrrelevantCredential: false, inlineApiKey: null },
      mode
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTomlSection(content: string, sectionName: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\r?\\n)\\[${escapeRegExp(sectionName)}\\]\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[[^\\r\\n]+\\]|\\s*$)`
  );
  const match = content.match(pattern);

  return match ? match[0].replace(/^\r?\n/, '') : null;
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

function getTomlEnvStatus(
  content: string,
  mode: PrivateMcpMode
): {
  envLines: string[];
} & ClientEnvStatus {
  const envBlock = getTomlSection(content, `mcp_servers.${getServerName(mode)}.env`);
  if (!envBlock) {
    return {
      apiKeyFileOverride: null,
      envLines: [],
      hasIrrelevantCredential: false,
      inlineApiKey: null,
    };
  }

  const envLines = envBlock
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0);
  const credential = getCredential(mode);
  const oppositeCredential = getOppositeCredential(mode);
  const apiKeyName = credential.apiKeyEnv;
  const inlineApiKey = getTomlStringValue(envBlock, apiKeyName)?.trim() || null;
  const apiKeyFile = getTomlStringValue(envBlock, credential.apiKeyFileEnv);

  return {
    apiKeyFileOverride:
      typeof apiKeyFile === 'string' && apiKeyFile.trim() ? apiKeyFile.trim() : null,
    envLines,
    hasIrrelevantCredential: [
      'WARM_API_KEY',
      'WARM_API_KEY_FILE',
      oppositeCredential.apiKeyEnv,
      oppositeCredential.apiKeyFileEnv,
    ].some((name) => Boolean(getTomlStringValue(envBlock, name)?.trim())),
    inlineApiKey,
  };
}

function getTomlStatus(client: Client, content: string, mode: PrivateMcpMode): ClientStatus {
  const warmBlock = getTomlSection(content, `mcp_servers.${getServerName(mode)}`);
  const envStatus = getTomlEnvStatus(content, mode);

  if (!warmBlock) {
    return createClientStatus(client, 'missing', envStatus, mode);
  }

  const command = getTomlStringValue(warmBlock, 'command');
  const args = getTomlStringArrayValue(warmBlock, 'args');

  if (isSupportedWarmInvocation(command, args, mode)) {
    return createClientStatus(client, 'configured', envStatus, mode);
  }

  return createClientStatus(client, 'needs_setup', envStatus, mode);
}

function getClientStatus(client: Client, mode: PrivateMcpMode): ClientStatus {
  if (!existsSync(client.configPath)) {
    return createClientStatus(
      client,
      'missing',
      { apiKeyFileOverride: null, hasIrrelevantCredential: false, inlineApiKey: null },
      mode
    );
  }

  const content = readFileSync(client.configPath, 'utf-8');

  if (client.format === 'toml') {
    return getTomlStatus(client, content, mode);
  }

  return getJsonStatus(client, content, mode);
}

function configureJson(
  client: Client,
  mode: PrivateMcpMode,
  preserveSelectedKeyFile: boolean
): void {
  let config: Record<string, unknown> = {};
  if (existsSync(client.configPath)) {
    const content = readFileSync(client.configPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Refusing to overwrite unparsable JSON config ${client.configPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `Refusing to overwrite JSON config ${client.configPath}: root must be an object.`
      );
    }
    config = parsed;
  }

  if (config.mcpServers === undefined) {
    config.mcpServers = {};
  }
  const servers = config.mcpServers;
  if (!isRecord(servers)) {
    throw new Error(
      `Refusing to overwrite JSON config ${client.configPath}: mcpServers must be an object.`
    );
  }
  const serverName = getServerName(mode);
  const existing = isRecord(servers[serverName]) ? servers[serverName] : undefined;
  const existingEnv = isRecord(existing?.env) ? existing.env : {};
  const nextEnv = { ...existingEnv } as Record<string, unknown>;
  const existingCommand = typeof existing?.command === 'string' ? existing.command : undefined;
  const existingArgs = getStringArray(existing?.args);
  const preserveProjectCommand =
    client.isProjectLevel &&
    !!existingCommand &&
    isSupportedWarmInvocation(existingCommand, existingArgs, mode);

  const credential = getCredential(mode);
  const oppositeCredential = getOppositeCredential(mode);
  const selectedKeyFile = credential.apiKeyFileEnv;
  for (const name of [
    'WARM_API_KEY',
    'WARM_API_KEY_FILE',
    credential.apiKeyEnv,
    oppositeCredential.apiKeyEnv,
    oppositeCredential.apiKeyFileEnv,
  ]) {
    delete nextEnv[name];
  }
  if (!preserveSelectedKeyFile) {
    delete nextEnv[selectedKeyFile];
  }

  if (preserveProjectCommand) {
    servers[serverName] = {
      ...existing,
      env: Object.keys(nextEnv).length > 0 ? nextEnv : undefined,
    };
  } else {
    servers[serverName] = {
      ...existing,
      ...getMcpConfig(mode),
      env: Object.keys(nextEnv).length > 0 ? nextEnv : undefined,
    };
  }

  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(client.configPath, JSON.stringify(config, null, 2) + '\n');
}

function configureToml(
  client: Client,
  mode: PrivateMcpMode,
  preserveSelectedKeyFile: boolean
): void {
  let content = '';
  let lineEnding = '\n';
  if (existsSync(client.configPath)) {
    content = readFileSync(client.configPath, 'utf-8');
    lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    if (!content.endsWith('\n')) {
      content += lineEnding;
    }
  }

  const serverName = getServerName(mode);
  const serverConfig = WARM_MCP_SERVER_CONFIGS[mode];
  const tomlCommand = platform() === 'win32' ? 'cmd' : serverConfig.command;
  const posixArgs = formatTomlStringArray(serverConfig.args);
  const windowsArgs = formatTomlStringArray(['/c', serverConfig.command, ...serverConfig.args]);
  const tomlArgs = platform() === 'win32' ? windowsArgs : posixArgs;
  const warmBlock = `[mcp_servers.${serverName}]${lineEnding}command = "${tomlCommand}"${lineEnding}args = ${tomlArgs}${lineEnding}`;
  const credential = getCredential(mode);
  const oppositeCredential = getOppositeCredential(mode);
  const selectedKeyFile = credential.apiKeyFileEnv;
  const removedEnvNames = new Set([
    'WARM_API_KEY',
    'WARM_API_KEY_FILE',
    credential.apiKeyEnv,
    oppositeCredential.apiKeyEnv,
    oppositeCredential.apiKeyFileEnv,
    ...(!preserveSelectedKeyFile ? [selectedKeyFile] : []),
  ]);
  const preservedEnvLines = getTomlEnvStatus(content, mode).envLines.filter((line) => {
    const name = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    return !name || !removedEnvNames.has(name);
  });
  const escapedServerName = escapeRegExp(serverName);
  const tomlBlockPattern = new RegExp(
    `(?:\\r?\\n)?\\[mcp_servers\\.${escapedServerName}\\]\\r?\\n[\\s\\S]*?(?=\\r?\\n\\[[^\\r\\n]+\\]|\\s*$)`,
    'g'
  );
  const tomlEnvBlockPattern = new RegExp(
    `(?:\\r?\\n)?\\[mcp_servers\\.${escapedServerName}\\.env\\]\\r?\\n[\\s\\S]*?(?=\\r?\\n\\[[^\\r\\n]+\\]|\\s*$)`,
    'g'
  );
  let nextContent = content
    .replace(tomlEnvBlockPattern, '')
    .replace(tomlBlockPattern, '')
    .trimEnd();
  if (nextContent.length > 0) {
    nextContent += `${lineEnding}${lineEnding}`;
  }
  nextContent += warmBlock;
  if (preservedEnvLines.length > 0) {
    nextContent += `${lineEnding}[mcp_servers.${serverName}.env]${lineEnding}${preservedEnvLines.join(lineEnding)}${lineEnding}`;
  }

  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(
    client.configPath,
    nextContent.endsWith('\n') ? nextContent : `${nextContent}${lineEnding}`
  );
}

function configure(client: Client, mode: PrivateMcpMode, preserveSelectedKeyFile: boolean): void {
  if (client.format === 'json') {
    configureJson(client, mode, preserveSelectedKeyFile);
    return;
  }

  configureToml(client, mode, preserveSelectedKeyFile);
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

async function validateApiKey(apiKey: string, mode: PrivateMcpMode): Promise<boolean> {
  console.log('  Validating API key...');

  try {
    const result = await verifyWarmApiKey(apiKey, mode);
    if (!result.valid) {
      console.log(`  Validation failed: ${result.status}`);
      console.log('  Check https://warm.io/settings and try again.');
      console.log('');
      return false;
    }
    if (result.audience !== mode) {
      console.log(`  Validation failed: this installer mode requires a ${mode} API key.`);
      console.log(`  Create a ${mode} key in https://warm.io/settings and try again.`);
      console.log('');
      return false;
    }

    console.log('  API key verified.');
    console.log('');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof WarmApiError && (error.status === 401 || error.status === 403)) {
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

async function validateEffectiveApiKeys(
  apiKeys: Array<string | null | undefined>,
  mode: PrivateMcpMode
): Promise<void> {
  const uniqueApiKeys = [...new Set(apiKeys.filter((apiKey): apiKey is string => Boolean(apiKey)))];
  for (const apiKey of uniqueApiKeys) {
    if (!(await validateApiKey(apiKey, mode))) {
      throw new Error(`The ${mode} API key could not be validated.`);
    }
  }
}

function storeApiKey(apiKey: string, mode: PrivateMcpMode): void {
  const apiKeyPath = getWarmApiKeyPath(mode);
  mkdirSync(dirname(apiKeyPath), { recursive: true });
  writeFileSync(apiKeyPath, `${apiKey}\n`, { mode: 0o600 });
  chmodSync(apiKeyPath, 0o600);
}

function getStatusLabel(status: ClientSetupState, force: boolean): string {
  if (force) {
    return 'not configured';
  }

  if (status === 'configured') {
    return 'configured';
  }

  if (status === 'needs_setup') {
    return 'needs setup';
  }

  return 'not configured';
}

export async function install(options: InstallOptions = {}): Promise<void> {
  const force = options.force ?? false;
  const mode = options.mode ?? 'context';
  const shouldValidateApiKey = options.validateApiKey ?? true;

  console.log('');
  console.log('  Warmio Installer');
  console.log('  ----------------');
  console.log('');

  const globalClients = GLOBAL_CLIENTS.filter(isDetected);
  const projectClients = detectProjectClients();
  const allClients = [...globalClients, ...projectClients];
  const clientStatuses = allClients.map((client) => getClientStatus(client, mode));
  const needsSetup = clientStatuses.filter((status) => force || status.state !== 'configured');

  console.log('  MCP clients found:');
  clientStatuses.forEach((status) => {
    console.log(
      `    ${status.client.name.padEnd(22)} ${shortPath(status.client.configPath).padEnd(55)} ${getStatusLabel(status.state, force)}`
    );
  });
  console.log('');

  if (needsSetup.length === 0) {
    if (shouldValidateApiKey) {
      await validateEffectiveApiKeys(
        clientStatuses.map((status) => status.credentialApiKey),
        mode
      );
    }
    console.log('  All clients already configured!');
    console.log('  Run with --force to update the API key.');
    console.log('');
    return;
  }

  const apiKeyPath = getWarmApiKeyPath(mode);
  const storedApiKey = readConfigFile(apiKeyPath);
  const migratedApiKey =
    needsSetup.find(
      (status) => typeof status.inlineApiKey === 'string' && status.inlineApiKey.length > 0
    )?.inlineApiKey ?? null;
  const usableApiKeyFileOverride = needsSetup.find(
    (status) => status.apiKeyFileOverride && !status.inlineApiKey && status.credentialApiKey
  );
  const targetMissingCredential = needsSetup.some((status) => !status.credentialApiKey);

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
    } else if (usableApiKeyFileOverride && !targetMissingCredential) {
      console.log(`  Reusing existing ${getCredential(mode).apiKeyFileEnv} override.`);
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
      throw new Error(`A ${mode} API key is required to complete setup.`);
    }

    apiKeyToStore = apiKey;
    shouldStoreApiKey = true;
  }

  if (shouldValidateApiKey) {
    const retainedClientApiKeys = force
      ? []
      : clientStatuses
          .filter(
            (status) =>
              status.state === 'configured' ||
              Boolean(status.apiKeyFileOverride && status.credentialApiKey)
          )
          .map((status) => status.credentialApiKey);
    await validateEffectiveApiKeys([apiKeyToStore, ...retainedClientApiKeys], mode);
  }

  if (apiKeyToStore && shouldStoreApiKey) {
    storeApiKey(apiKeyToStore, mode);
  }

  console.log('  Configuring...');
  console.log('');

  const configurationFailures: string[] = [];
  needsSetup.forEach((status) => {
    try {
      configure(
        status.client,
        mode,
        !force && Boolean(status.apiKeyFileOverride && status.credentialApiKey)
      );
      console.log(`    ${status.client.name.padEnd(22)} done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    ${status.client.name.padEnd(22)} failed: ${message}`);
      configurationFailures.push(`${status.client.name}: ${message}`);
    }
  });

  console.log('');
  if (configurationFailures.length > 0) {
    throw new Error(`Failed to configure MCP clients: ${configurationFailures.join('; ')}`);
  }
  if (apiKeyToStore) {
    console.log(`  Stored ${mode} API key at ${shortPath(apiKeyPath)}`);
  }
  console.log('  All set! Restart your MCP clients and try:');
  console.log('    "What\'s my net worth?"');
  console.log('');
}
