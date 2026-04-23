#!/usr/bin/env node

import { install } from './install.js';
import { startStdioServer } from './server.js';

type Command = 'help' | 'install' | 'stdio';

interface CliOptions {
  command: Command;
  force: boolean;
  validateApiKey: boolean;
}

function printUsage(): void {
  console.log('');
  console.log('  Warm MCP');
  console.log('  --------');
  console.log('');
  console.log('  warm-mcp [install] [--force] [--no-validate]');
  console.log('  warm-mcp stdio');
  console.log('');
  console.log('  Aliases:');
  console.log('    --server, --stdio    Start stdio mode');
  console.log('');
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

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  switch (options.command) {
    case 'help':
      printUsage();
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
