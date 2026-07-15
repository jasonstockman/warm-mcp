import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type WarmApiAudience = 'automation' | 'context';

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

export function getWarmApiKeyPath(audience: WarmApiAudience = 'context'): string {
  const envKey =
    audience === 'automation' ? 'WARM_AUTOMATION_API_KEY_FILE' : 'WARM_CONTEXT_API_KEY_FILE';
  const configuredPath = process.env[envKey]?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  return path.join(getWarmConfigDir(), `${audience}_api_key`);
}

export function readConfigFile(configPath: string): string | null {
  try {
    return fs.readFileSync(configPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
