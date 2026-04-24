import * as fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

import {
  createWarmApiClient,
  type WarmApiClientOptions,
  getConfiguredApiKey,
  verifyWarmApiKey,
  apiRequest,
} from './warm-api-client.js';
import {
  emptyInputSchema,
  getAccountsOutputSchema,
  getFinancialStateOutputSchema,
  getTransactionsInputSchema,
  getTransactionsOutputSchema,
  verifyKeyOutputSchema,
} from './schemas.js';

export { apiRequest, createWarmApiClient, getConfiguredApiKey, verifyWarmApiKey };
export type { WarmApiClientOptions } from './warm-api-client.js';

export interface WarmServerOptions extends WarmApiClientOptions {
  serverInfo?: Implementation;
}

export const API_URL = process.env.WARM_API_URL || 'https://warm.io';

function getPackageVersion(): string {
  try {
    const packageJson = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(packageJson) as { version?: string };
    return parsed.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const WARM_SERVER_INFO = {
  name: 'warm',
  version: getPackageVersion(),
};

const READ_ONLY_TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

function createStructuredToolResult<TStructuredContent extends Record<string, unknown>>(
  structuredContent: TStructuredContent
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

export function registerWarmTools(
  server: McpServer,
  options: WarmApiClientOptions = {}
): void {
  const client = createWarmApiClient(options);

  server.registerTool(
    'get_accounts',
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        'Read-only list of connected financial accounts with balances, subtypes, institutions, and masks when available.',
      inputSchema: emptyInputSchema,
      outputSchema: getAccountsOutputSchema,
    },
    async () => createStructuredToolResult(await client.getAccounts())
  );

  server.registerTool(
    'get_transactions',
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        'Read-only transaction export with strict opaque cursor pagination and optional last_knowledge incremental sync.',
      inputSchema: getTransactionsInputSchema,
      outputSchema: getTransactionsOutputSchema,
    },
    async (args: {
      cursor?: string;
      last_knowledge?: string;
      limit: number;
      search?: string;
    }) => {
      if (args.cursor && args.last_knowledge) {
        throw new Error('`cursor` cannot be combined with `last_knowledge`.');
      }

      return createStructuredToolResult(await client.getTransactions(args));
    }
  );

  server.registerTool(
    'get_financial_state',
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        'Read-only broad financial state bundle with snapshots, recurring payments, budgets, goals, financial health, liabilities, holdings, and category spending.',
      inputSchema: emptyInputSchema,
      outputSchema: getFinancialStateOutputSchema,
    },
    async () => createStructuredToolResult(await client.getFinancialState())
  );

  server.registerTool(
    'verify_key',
    {
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description: 'Read-only API key validation for the configured Warm account.',
      inputSchema: emptyInputSchema,
      outputSchema: verifyKeyOutputSchema,
    },
    async () => createStructuredToolResult(await client.verifyKey())
  );
}

export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const { serverInfo, ...clientOptions } = options;
  const server = new McpServer(serverInfo || WARM_SERVER_INFO);
  registerWarmTools(server, clientOptions);
  return server;
}
