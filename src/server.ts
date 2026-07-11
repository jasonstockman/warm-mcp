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

function parseGetTransactionsArgs(args: Record<string, unknown>) {
  const hasMonth = typeof args.month === 'string';
  const hasLatestKey = Object.prototype.hasOwnProperty.call(args, 'latest');
  const hasLatest = args.latest === true;

  if (hasMonth && hasLatestKey) {
    throw new Error('`month` and `latest` are mutually exclusive.');
  }

  if (hasMonth) {
    return { month: args.month as string };
  }

  if (hasLatest || Object.keys(args).length === 0) {
    return { latest: true as const };
  }

  throw new Error(
    'Call get_transactions with `month` in YYYY-MM format, `latest: true`, or no arguments.'
  );
}

export function registerWarmTools(
  server: McpServer,
  options: WarmApiClientOptions = {}
): void {
  const client = createWarmApiClient(options);
  const tools: WarmToolDefinition[] = [
    {
      description:
        'Read-only compact FinancialContext JSON. Includes status.position, status.accounts, transaction index total/months, recurring, budgets, goals, snapshots, liabilities, holdings, and health. Transaction items are not inline; use get_transactions for items.',
      handler: async () => await client.getFinancialContext(),
      inputShape: emptyInputSchema,
      name: 'get_financial_context',
    },
    {
      description:
        'Read-only transactions from the FinancialContext artifact. Pass exactly one selector: `month` in YYYY-MM format for a month page, or `latest: true` for the fixed latest window. A bare call with no arguments defaults to `latest: true`. The latest window is fixed at 10 days and is not caller-configurable. `month` and `latest` are mutually exclusive. Months outside the covered range return an error.',
      handler: async (args) => {
        return await client.getTransactions(parseGetTransactionsArgs(args));
      },
      inputShape: getTransactionsInputSchema,
      name: 'get_transactions',
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
