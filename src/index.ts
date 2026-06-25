#!/usr/bin/env node

import { install } from './install.js';
import { startHttpServer } from './http.js';
import { loadDotEnv } from './load-env.js';
import { createWarmServer } from './server.js';
import { AdaptiveStdioTransport } from './stdio.js';

type Command = 'help' | 'http' | 'install' | 'mcp';

interface CliOptions {
  command: Command;
  force: boolean;
  httpHost?: string;
  httpPath?: string;
  httpPort?: number;
  validateApiKey: boolean;
}

function isInteractiveSession(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function printUsage(): void {
  console.log('');
  console.log('  Warmio');
  console.log('  ------');
  console.log('');
  console.log('  warmio');
  console.log('    Run the interactive installer');
  console.log('');
  console.log('  warmio install [--force] [--no-validate]');
  console.log('  warmio mcp');
  console.log('  warmio http [--host 127.0.0.1] [--port 3000] [--path /mcp]');
  console.log('');
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: isInteractiveSession() ? 'install' : 'mcp',
    force: false,
    validateApiKey: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === 'help' || arg === '--help' || arg === '-h') {
      options.command = 'help';
      continue;
    }

    if (arg === 'install' || arg === '--install') {
      options.command = 'install';
      continue;
    }

    if (arg === 'mcp') {
      options.command = 'mcp';
      continue;
    }

    if (arg === 'http') {
      options.command = 'http';
      continue;
    }

    if (arg === '--host') {
      options.httpHost = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--path') {
      options.httpPath = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const nextArg = args[index + 1];
      if (!nextArg) {
        throw new Error('Missing value for --port');
      }

      const port = Number.parseInt(nextArg, 10);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Invalid value for --port: ${nextArg}`);
      }

      options.httpPort = port;
      index += 1;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--no-validate') {
      options.validateApiKey = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function startStdioServer() {
  const server = createWarmServer();
  const transport = new AdaptiveStdioTransport();
  await server.connect(transport);
  return server;
}

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseCliArgs(process.argv.slice(2));

  switch (options.command) {
    case 'help':
      printUsage();
      return;
    case 'mcp':
      await startStdioServer();
      return;
    case 'http':
      await startHttpServer({
        host: options.httpHost,
        path: options.httpPath,
        port: options.httpPort,
      });
      return;
    case 'install':
      await install({
        force: options.force,
        validateApiKey: options.validateApiKey,
      });
      return;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
}
