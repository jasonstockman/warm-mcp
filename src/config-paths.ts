import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WARM_MCP_CREDENTIALS } from '@warmio/contracts/mcp';

export function getWarmConfigDir(): string {
  if (process.env.WARM_CONFIG_DIR?.trim()) return process.env.WARM_CONFIG_DIR.trim();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Warm');
  }
  if (process.env.XDG_CONFIG_HOME?.trim())
    return path.join(process.env.XDG_CONFIG_HOME.trim(), 'warm');
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Warm')
    : path.join(os.homedir(), '.config', 'warm');
}

export function getWarmApiKeyPath(): string {
  const override = process.env[WARM_MCP_CREDENTIALS.apiKeyFileEnv]?.trim();
  if (override) return override;
  return path.join(getWarmConfigDir(), WARM_MCP_CREDENTIALS.defaultFileName);
}

export function readConfigFile(configPath: string): string | null {
  try {
    return fs.readFileSync(configPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
