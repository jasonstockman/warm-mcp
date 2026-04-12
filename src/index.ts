#!/usr/bin/env node

import { startHttpServer } from './http.js';
import { install } from './install.js';
import { startStdioServer } from './server.js';

type Command = 'help' | 'http' | 'install' | 'stdio';

interface CliOptions {
  allowedHosts?: string[];
  command: Command;
  force: boolean;
  host?: string;
  path?: string;
  port?: number;
  validateApiKey: boolean;
}

function printUsage(): void {
  console.log('');
  console.log('  Warm MCP');
  console.log('  --------');
  console.log('');
  console.log('  warm-mcp [install] [--force] [--no-validate]');
  console.log('  warm-mcp stdio');
  console.log('  warm-mcp http [--host 127.0.0.1] [--port 3000] [--path /mcp]');
  console.log('                 [--allowed-hosts host1,host2]');
  console.log('');
  console.log('  Aliases:');
  console.log('    --server, --stdio    Start stdio mode');
  console.log('    --http               Start HTTP mode');
  console.log('');
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOption(
  args: string[],
  index: number,
  flag: string
): { nextIndex: number; value: string } {
  const arg = args[index];
  if (arg.startsWith(`${flag}=`)) {
    return {
      nextIndex: index,
      value: arg.slice(flag.length + 1),
    };
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return {
    nextIndex: index + 1,
    value,
  };
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: 'install',
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

    if (arg === 'stdio' || arg === 'server' || arg === '--stdio' || arg === '--server') {
      options.command = 'stdio';
      continue;
    }

    if (arg === 'http' || arg === '--http') {
      options.command = 'http';
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

    if (arg === '--host' || arg.startsWith('--host=')) {
      const { nextIndex, value } = readOption(args, index, '--host');
      options.host = value;
      index = nextIndex;
      continue;
    }

    if (arg === '--port' || arg.startsWith('--port=')) {
      const { nextIndex, value } = readOption(args, index, '--port');
      options.port = parsePort(value);
      index = nextIndex;
      continue;
    }

    if (arg === '--path' || arg.startsWith('--path=')) {
      const { nextIndex, value } = readOption(args, index, '--path');
      options.path = value;
      index = nextIndex;
      continue;
    }

    if (arg === '--allowed-hosts' || arg.startsWith('--allowed-hosts=')) {
      const { nextIndex, value } = readOption(args, index, '--allowed-hosts');
      options.allowedHosts = parseList(value);
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  switch (options.command) {
    case 'help':
      printUsage();
      return;
    case 'http':
      await startHttpServer({
        allowedHosts: options.allowedHosts,
        host: options.host,
        path: options.path,
        port: options.port,
      });
      return;
    case 'stdio':
      await startStdioServer();
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error('Run "warm-mcp --help" for usage.');
  process.exit(1);
}
