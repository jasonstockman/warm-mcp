#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WARM_MCP_INSTALLER_COMMAND, WARM_MCP_SERVER_COMMAND } from '@warmio/contracts/mcp';
import { install } from './install.js';
import { loadDotEnv } from './load-env.js';
import { createWarmServer } from './server.js';

function usage(): void {
  console.log(`Usage: ${WARM_MCP_INSTALLER_COMMAND} [--force] | ${WARM_MCP_SERVER_COMMAND}`);
}

async function main(args: string[]): Promise<void> {
  loadDotEnv();
  const command = args[0] || (process.stdin.isTTY && process.stdout.isTTY ? 'install' : 'mcp');
  if (command === 'mcp') {
    const server = createWarmServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === 'install') {
    const invalidArgument = args.slice(1).find((argument) => argument !== '--force');
    if (invalidArgument) throw new Error(`Unknown argument: ${invalidArgument}`);
    await install({ force: args.includes('--force') });
    return;
  }
  usage();
  process.exitCode = 1;
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

export { install } from './install.js';
export * from './server.js';
export * from './warm-api-client.js';
