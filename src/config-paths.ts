import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WARM_MCP_CREDENTIALS, type PrivateMcpMode } from '@warmio/contracts/mcp';

export function getWarmConfigDir(): string {
  if (process.env.WARM_CONFIG_DIR?.trim()) {
    return process.env.WARM_CONFIG_DIR.trim();
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Warm');
  }

  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return path.join(process.env.XDG_CONFIG_HOME.trim(), 'warm');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Warm');
  }

  return path.join(os.homedir(), '.config', 'warm');
}

export function getWarmApiKeyPath(audience: PrivateMcpMode = 'context'): string {
  const credential = WARM_MCP_CREDENTIALS[audience];
  const configuredPath = process.env[credential.apiKeyFileEnv]?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  return path.join(getWarmConfigDir(), credential.defaultFileName);
}

export function readConfigFile(configPath: string): string | null {
  try {
    return fs.readFileSync(configPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
