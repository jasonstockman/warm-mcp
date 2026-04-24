import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnvFile } from 'dotenv';

let loaded = false;

export function loadDotEnv(): void {
  if (loaded) {
    return;
  }

  loaded = true;

  const candidates = new Set<string>();

  let currentDir = process.cwd();
  while (true) {
    candidates.add(path.join(currentDir, '.env'));
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  let moduleDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    candidates.add(path.join(moduleDir, '.env'));
    const parentDir = path.dirname(moduleDir);
    if (parentDir === moduleDir) {
      break;
    }
    moduleDir = parentDir;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      loadEnvFile({ path: candidate, override: false });
      return;
    }
  }
}
