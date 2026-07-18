import * as fs from 'node:fs';
import * as path from 'node:path';
import { config as loadEnvFile } from 'dotenv';

let loaded = false;

export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  for (let current = process.cwd(); ; current = path.dirname(current)) {
    const candidate = path.join(current, '.env');
    if (fs.existsSync(candidate)) {
      loadEnvFile({ path: candidate, override: false, quiet: true });
      return;
    }
    if (path.dirname(current) === current) return;
  }
}
