import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { API_ORIGIN, WARM_API_KEY_PREFIX } from '@warmio/contracts/api';
import {
  WARM_MCP_CLIENTS,
  WARM_MCP_PROJECT_CONFIGS,
  WARM_MCP_SERVER_CONFIG,
  type WarmMcpClientConfigDialect,
  type WarmMcpConfigPath,
} from '@warmio/contracts/mcp';
import { getWarmApiKeyPath } from './config-paths.js';

type ClientFormat = 'json' | 'toml';

type Client = {
  alwaysInclude?: boolean;
  configDialect: WarmMcpClientConfigDialect;
  configPath: string;
  format: ClientFormat;
  name: string;
};

type FileSnapshot = {
  content: string;
  exists: boolean;
  mode: number;
};

type PreparedFile = {
  content: string;
  mode: number;
  snapshot: FileSnapshot;
  target: string;
};

export interface InstallOptions {
  /** Replace an existing Warm server configuration without an additional confirmation. */
  force?: boolean;
  /** Test seam for the API request. It is not used by the CLI. */
  fetchImplementation?: typeof fetch;
  /** Test seam for local client discovery. It is not used by the CLI. */
  homeDir?: string;
  /** Test seam for the API endpoint. It is not used by the CLI. */
  apiUrl?: string;
  /** Test seam for installer interaction. It is not used by the CLI. */
  prompt?: (question: string) => Promise<string>;
  /** Test seam for installer interaction. It is not used by the CLI. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam for project client discovery. It is not used by the CLI. */
  workingDirectory?: string;
  /** Test seam for atomic file replacement failures. It is not used by the CLI. */
  atomicReplaceFile?: (target: string, content: string, mode: number) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const API_KEY_PATTERN = new RegExp(`^${WARM_API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);
function configPath(config: WarmMcpConfigPath, homeDir: string): string {
  const root =
    config.root === 'appData'
      ? process.env.APPDATA?.trim() || path.join(homeDir, 'AppData', 'Roaming')
      : homeDir;
  return path.join(root, ...config.segments);
}

function supportedClients(homeDir: string, workingDirectory: string): Client[] {
  const platform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const globalClients = WARM_MCP_CLIENTS.map((client) => ({
    alwaysInclude: 'alwaysInclude' in client && client.alwaysInclude,
    configDialect: client.configDialect,
    configPath: configPath(client.configPaths[platform], homeDir),
    format: client.format as ClientFormat,
    name: client.name,
  })).filter((client) => client.alwaysInclude || fs.existsSync(path.dirname(client.configPath)));
  const projectClients = WARM_MCP_PROJECT_CONFIGS.map((relativePath) =>
    path.resolve(workingDirectory, relativePath)
  )
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      configPath: candidate,
      configDialect: 'mcpServers' as const,
      format: 'json' as const,
      name: `Project (${path.relative(workingDirectory, candidate)})`,
    }));
  const configPaths = new Set<string>();
  return [...globalClients, ...projectClients].filter((client) => {
    if (configPaths.has(client.configPath)) return false;
    configPaths.add(client.configPath);
    return true;
  });
}

function isCurrentWarmConfig(client: Client, server: unknown): boolean {
  if (!isRecord(server)) return false;
  if (client.configDialect === 'openCode') {
    return (
      server.type === 'local' &&
      Array.isArray(server.command) &&
      server.command.length === WARM_MCP_SERVER_CONFIG.args.length + 1 &&
      server.command[0] === WARM_MCP_SERVER_CONFIG.command &&
      server.command.slice(1).every((argument, index) => argument === WARM_MCP_SERVER_CONFIG.args[index]) &&
      Object.keys(server).length === 2
    );
  }
  return (
    server.command === WARM_MCP_SERVER_CONFIG.command &&
    Array.isArray(server.args) &&
    server.args.length === WARM_MCP_SERVER_CONFIG.args.length &&
    server.args.every((argument, index) => argument === WARM_MCP_SERVER_CONFIG.args[index]) &&
    Object.keys(server).length === 2
  );
}

function parseJsonConfig(client: Client, content: string): Record<string, unknown> {
  if (!content) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${client.name} config is not a JSON object.`);
  return parsed;
}

function readJsonConfig(client: Client): Record<string, unknown> {
  return parseJsonConfig(
    client,
    fs.existsSync(client.configPath) ? fs.readFileSync(client.configPath, 'utf8') : ''
  );
}

const WARM_TOML_BLOCK = /\n?\[mcp_servers\.warm\][\s\S]*?(?=\n\[[^\n]+\]|\s*$)/g;
const WARM_TOML_ENV_BLOCK = /\n?\[mcp_servers\.warm\.env\][\s\S]*?(?=\n\[[^\n]+\]|\s*$)/g;

function existingWarmConfig(client: Client): {
  current: boolean;
  exists: boolean;
} {
  if (client.format === 'toml') {
    const content = fs.existsSync(client.configPath)
      ? fs.readFileSync(client.configPath, 'utf8')
      : '';
    const section = content.match(WARM_TOML_BLOCK)?.[0];
    return {
      current:
        Boolean(section) &&
        section!.trim() ===
          [
            '[mcp_servers.warm]',
            `command = "${WARM_MCP_SERVER_CONFIG.command}"`,
            `args = ${JSON.stringify(WARM_MCP_SERVER_CONFIG.args)}`,
          ].join('\n'),
      exists: Boolean(section),
    };
  }
  const config = readJsonConfig(client);
  const servers =
    client.configDialect === 'openCode'
      ? isRecord(config.mcp)
        ? config.mcp
        : {}
      : isRecord(config.mcpServers)
        ? config.mcpServers
        : {};
  return {
    current: isCurrentWarmConfig(client, servers.warm),
    exists: 'warm' in servers,
  };
}

function prepareJsonConfig(client: Client, current: string): string {
  const config = parseJsonConfig(client, current);
  if (client.configDialect === 'openCode') {
    const servers = isRecord(config.mcp) ? config.mcp : {};
    servers.warm = {
      type: 'local',
      command: [WARM_MCP_SERVER_CONFIG.command, ...WARM_MCP_SERVER_CONFIG.args],
    };
    config.mcp = servers;
    delete config.mcpServers;
    return `${JSON.stringify(config, null, 2)}\n`;
  }
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  servers.warm = {
    command: WARM_MCP_SERVER_CONFIG.command,
    args: [...WARM_MCP_SERVER_CONFIG.args],
  };
  config.mcpServers = servers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function prepareTomlConfig(current: string): string {
  const remaining = current.replace(WARM_TOML_ENV_BLOCK, '').replace(WARM_TOML_BLOCK, '').trimEnd();
  const next = [
    remaining,
    '[mcp_servers.warm]',
    `command = "${WARM_MCP_SERVER_CONFIG.command}"`,
    `args = ${JSON.stringify(WARM_MCP_SERVER_CONFIG.args)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return `${next}\n`;
}

function snapshotFile(target: string): FileSnapshot {
  try {
    const stat = fs.statSync(target);
    return {
      content: fs.readFileSync(target, 'utf8'),
      exists: true,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { content: '', exists: false, mode: 0o666 };
  }
}

function prepareClientFile(client: Client): PreparedFile {
  const snapshot = snapshotFile(client.configPath);
  return {
    content:
      client.format === 'toml'
        ? prepareTomlConfig(snapshot.content)
        : prepareJsonConfig(client, snapshot.content),
    mode: snapshot.mode,
    snapshot,
    target: client.configPath,
  };
}

function prepareCredentialFile(target: string, apiKey: string): PreparedFile {
  return {
    content: `${apiKey}\n`,
    mode: 0o600,
    snapshot: snapshotFile(target),
    target,
  };
}

function atomicReplaceFile(target: string, content: string, mode: number): void {
  const directory = path.dirname(target);
  const temporaryPath = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true });
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function restorePreparedFile(
  prepared: PreparedFile,
  replaceFile: (target: string, content: string, mode: number) => void
): void {
  if (prepared.snapshot.exists) {
    replaceFile(prepared.target, prepared.snapshot.content, prepared.snapshot.mode);
    return;
  }
  fs.rmSync(prepared.target, { force: true });
}

function commitPreparedFiles(
  files: PreparedFile[],
  replaceFile: (target: string, content: string, mode: number) => void
): void {
  const replaced: PreparedFile[] = [];
  try {
    for (const file of files) {
      replaceFile(file.target, file.content, file.mode);
      replaced.push(file);
    }
  } catch (error) {
    try {
      for (const file of [...replaced].reverse()) restorePreparedFile(file, replaceFile);
    } catch {
      throw new Error('Warm MCP installation failed and rollback could not complete.');
    }
    throw error;
  }
}

function readlinePrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    readline.question(question, (answer) => {
      readline.close();
      resolve(answer.trim());
    });
  });
}

async function validateApiKey(apiKey: string, options: InstallOptions): Promise<void> {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error('Warm API key validation failed. Check Warm Settings and try again.');
  }
  const response = await (options.fetchImplementation || fetch)(
    new URL('/api/verify', options.apiUrl || process.env.WARM_API_URL || API_ORIGIN),
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* An invalid response is not a valid key. */
  }
  if (!response.ok || !isRecord(body) || body.valid !== true || Object.keys(body).length !== 1) {
    throw new Error('Warm API key validation failed. Check Warm Settings and try again.');
  }
}

async function requestedApiKey(
  ask: (question: string) => Promise<string>,
  options: InstallOptions
): Promise<string> {
  const apiKey = (await ask('Warm API key: ')).trim();
  if (!apiKey) throw new Error('A Warm API key is required to configure MCP clients.');
  await validateApiKey(apiKey, options);
  return apiKey;
}

async function resolveApiKey(
  target: string,
  ask: (question: string) => Promise<string>,
  confirm: (question: string) => Promise<boolean>,
  options: InstallOptions
): Promise<{ apiKey: string; replaceStoredKey: boolean }> {
  const storedApiKey = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').trim() : '';
  if (!storedApiKey || options.force) {
    return {
      apiKey: await requestedApiKey(ask, options),
      replaceStoredKey: true,
    };
  }
  try {
    await validateApiKey(storedApiKey, options);
    return { apiKey: storedApiKey, replaceStoredKey: false };
  } catch {
    if (!(await confirm('Replace the existing stored Warm API key?'))) {
      throw new Error('Warm API key replacement cancelled.');
    }
    return {
      apiKey: await requestedApiKey(ask, options),
      replaceStoredKey: true,
    };
  }
}

/** Configure detected supported MCP clients for the local stdio server. */
export async function install(options: InstallOptions = {}): Promise<void> {
  const homeDir = options.homeDir || os.homedir();
  const workingDirectory = options.workingDirectory || process.cwd();
  const ask = options.prompt || readlinePrompt;
  const confirm =
    options.confirm ||
    (async (question: string) => /^(y|yes)$/i.test(await ask(`${question} [y/N] `)));
  const targets: Client[] = [];

  for (const client of supportedClients(homeDir, workingDirectory)) {
    const existing = existingWarmConfig(client);
    if (existing.current) continue;
    if (
      existing.exists &&
      !options.force &&
      !(await confirm(`Replace the existing Warm MCP configuration in ${client.name}?`))
    )
      continue;
    targets.push(client);
  }

  const target = getWarmApiKeyPath();
  const { apiKey, replaceStoredKey } = await resolveApiKey(target, ask, confirm, options);
  const clientFiles = targets.map(prepareClientFile);
  const files = replaceStoredKey ? [...clientFiles, prepareCredentialFile(target, apiKey)] : clientFiles;
  commitPreparedFiles(files, options.atomicReplaceFile || atomicReplaceFile);
}
