import * as fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Implementation,
} from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';

import {
  createWarmApiClient,
  type WarmApiClientOptions,
  getConfiguredApiKey,
  verifyWarmApiKey,
  apiRequest,
} from './warm-api-client.js';
import {
  emptyInputSchema,
  getTransactionsInputSchema,
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

interface WarmToolDefinition {
  description: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inputShape: ZodRawShape;
  name: string;
}

export function registerWarmTools(
  server: McpServer,
  options: WarmApiClientOptions = {}
): void {
  const client = createWarmApiClient(options);
  const tools: WarmToolDefinition[] = [
    {
      description:
        'Read-only list of connected financial accounts with balances, subtypes, institutions, and masks when available.',
      handler: async () => await client.getAccounts(),
      inputShape: emptyInputSchema,
      name: 'get_accounts',
    },
    {
      description:
        'Read-only transaction export with strict opaque cursor pagination and optional last_knowledge incremental sync.',
      handler: async (args) => {
        const transactionArgs = {
          cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
          last_knowledge:
            typeof args.last_knowledge === 'string' ? args.last_knowledge : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 500,
          search: typeof args.search === 'string' ? args.search : undefined,
        };

        if (transactionArgs.cursor && transactionArgs.last_knowledge) {
          throw new Error('`cursor` cannot be combined with `last_knowledge`.');
        }

        return await client.getTransactions(transactionArgs);
      },
      inputShape: getTransactionsInputSchema,
      name: 'get_transactions',
    },
    {
      description:
        'Read-only broad financial state bundle with snapshots, recurring payments, budgets, goals, financial health, liabilities, holdings, and category spending.',
      handler: async () => await client.getFinancialState(),
      inputShape: emptyInputSchema,
      name: 'get_financial_state',
    },
    {
      description: 'Read-only API key validation for the configured Warm account.',
      handler: async () => await client.verifyKey(),
      inputShape: emptyInputSchema,
      name: 'verify_key',
    },
  ];

  server.server.registerCapabilities({
    tools: {
      listChanged: true,
    },
  });

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      description: tool.description,
      inputSchema: toJsonSchemaCompat(z.object(tool.inputShape).strict(), {
        pipeStrategy: 'input',
        strictUnions: true,
      }),
      name: tool.name,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }

    const argsSchema = z.object(tool.inputShape).strict();
    const parseResult = await argsSchema.safeParseAsync(request.params.arguments ?? {});
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool ${request.params.name}: ${parseResult.error.message}`
      );
    }

    return createStructuredToolResult(await tool.handler(parseResult.data));
  });
}

export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const { serverInfo, ...clientOptions } = options;
  const server = new McpServer(serverInfo || WARM_SERVER_INFO);
  registerWarmTools(server, clientOptions);
  return server;
}
