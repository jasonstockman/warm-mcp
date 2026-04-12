import * as os from 'node:os';
import * as path from 'node:path';

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

export function getWarmApiKeyPath(): string {
  if (process.env.WARM_API_KEY_FILE?.trim()) {
    return process.env.WARM_API_KEY_FILE.trim();
  }

  return path.join(getWarmConfigDir(), 'api_key');
}
