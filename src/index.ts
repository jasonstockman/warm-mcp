#!/usr/bin/env node

import { install } from './install.js';
import { startHttpServer } from './http.js';
import { loadDotEnv } from './load-env.js';
import { createWarmServer } from './server.js';
import { AdaptiveStdioTransport } from './stdio.js';
import { createWarmApiClient } from './warm-api-client.js';

type Command =
  | 'context-get'
  | 'context-meta'
  | 'help'
  | 'http'
  | 'install'
  | 'mcp'
  | 'transactions-get';

interface CliOptions {
  command: Command;
  force: boolean;
  httpHost?: string;
  httpPath?: string;
  httpPort?: number;
  latest?: true;
  month?: string;
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
  console.log('  warmio context get');
  console.log('  warmio context meta');
  console.log('  warmio transactions get --month YYYY-MM');
  console.log('  warmio transactions get --latest');
  console.log('');
  console.log('  Transactions require exactly one selector: --month YYYY-MM or --latest.');
  console.log('  Month and latest are mutually exclusive. Latest is a fixed 10-day window.');
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

    if (arg === 'context') {
      const subcommand = args[index + 1];
      if (subcommand === 'get') {
        options.command = 'context-get';
        index += 1;
        continue;
      }
      if (subcommand === 'meta') {
        options.command = 'context-meta';
        index += 1;
        continue;
      }
      throw new Error('Usage: warmio context get | warmio context meta');
    }

    if (arg === 'transactions') {
      const subcommand = args[index + 1];
      if (subcommand !== 'get') {
        throw new Error('Usage: warmio transactions get --month YYYY-MM | --latest');
      }
      options.command = 'transactions-get';
      index += 1;
      continue;
    }

    if (arg === '--format') {
      const format = args[index + 1];
      if (format !== 'json') {
        throw new Error('Only --format json is supported.');
      }
      index += 1;
      continue;
    }

    if (arg === '--month') {
      const month = args[index + 1];
      if (!month) {
        throw new Error('Missing value for --month');
      }
      if (!/^\d{4}-\d{2}$/.test(month)) {
        throw new Error(`Invalid value for --month: ${month}. Expected YYYY-MM.`);
      }
      options.month = month;
      index += 1;
      continue;
    }

    if (arg === '--latest') {
      options.latest = true;
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

function validateCliOptions(options: CliOptions): void {
  if (options.command !== 'transactions-get') {
    if (options.month || options.latest) {
      throw new Error('--month and --latest are only valid with `warmio transactions get`.');
    }
    return;
  }

  if (options.month && options.latest) {
    throw new Error('--month and --latest are mutually exclusive.');
  }

  if (!options.month && !options.latest) {
    throw new Error('Usage: warmio transactions get --month YYYY-MM | --latest');
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
  validateCliOptions(options);

  switch (options.command) {
    case 'context-get':
      printJson(await createWarmApiClient().getFinancialContext());
      return;
    case 'context-meta':
      printJson(await createWarmApiClient().getFinancialContextMeta());
      return;
    case 'transactions-get':
      printJson(
        await createWarmApiClient().getTransactions(
          options.month ? { month: options.month } : { latest: true }
        )
      );
      return;
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
