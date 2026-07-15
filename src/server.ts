import * as fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Implementation,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';

import {
  createWarmApiClient,
  type WarmApiClientOptions,
  getConfiguredApiKey,
  verifyWarmApiKey,
  WarmApiError,
} from './warm-api-client.js';
import {
  describeOperationInputSchema,
  emptyInputSchema,
  getTransactionsInputSchema,
  invokeOperationInputSchema,
  searchOperationsInputSchema,
} from './schemas.js';

export { createWarmApiClient, getConfiguredApiKey, verifyWarmApiKey, WarmApiError };
export type { WarmApiClientOptions } from './warm-api-client.js';

export interface WarmServerOptions extends WarmApiClientOptions {
  mode?: WarmServerMode;
  serverInfo?: Implementation;
}

export type WarmServerMode = 'automation' | 'context';

export const API_URL = process.env.WARM_API_URL || 'https://app.warm.io';

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
  structuredContent: TStructuredContent,
  isError = false
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
    structuredContent,
  };
}

interface WarmToolDefinition {
  annotations?: ToolAnnotations;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inputShape: ZodRawShape;
  name: string;
}

function createToolFailure(error: unknown) {
  if (error instanceof WarmApiError) {
    return createStructuredToolResult(
      {
        body: error.body,
        headers: error.headers,
        message: error.message,
        status: error.status,
      },
      true
    );
  }

  return createStructuredToolResult(
    {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    },
    true
  );
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
  options: WarmApiClientOptions = {},
  mode: WarmServerMode = 'context'
): void {
  const client = createWarmApiClient({ ...options, audience: mode });
  const contextTools: WarmToolDefinition[] = [
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        'Read-only compact FinancialContext JSON. Includes status.position, status.accounts, transaction index total/months, recurring, budgets, goals, snapshots, liabilities, holdings, and health. Transaction items are not inline; use get_transactions for items.',
      handler: async () => await client.getFinancialContext(),
      inputShape: emptyInputSchema,
      name: 'get_financial_context',
    },
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        'Read-only transactions from the FinancialContext artifact. Pass exactly one selector: `month` in YYYY-MM format for a month page, or `latest: true` for the fixed latest window. A bare call with no arguments defaults to `latest: true`. The latest window is fixed at 10 days and is not caller-configurable. `month` and `latest` are mutually exclusive. Months outside the covered range return an error.',
      handler: async (args) => {
        return await client.getTransactions(parseGetTransactionsArgs(args));
      },
      inputShape: getTransactionsInputSchema,
      name: 'get_transactions',
    },
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description: 'Read-only API key validation for the configured Warm account.',
      handler: async () => await client.validateAudience(),
      inputShape: emptyInputSchema,
      name: 'verify_key',
    },
  ];
  const automationTools: WarmToolDefinition[] = [
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        'Search the supported Warm operation catalog. Use this first to find the smallest matching operation.',
      handler: async (args) =>
        await client.searchOperations(typeof args.query === 'string' ? args.query : undefined),
      inputShape: searchOperationsInputSchema,
      name: 'search_operations',
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Describe one operation, including its input schema and risk. For write operations, pass the exact intended input to receive an approval with its ID, status, URL, and expiry.',
      handler: async (args) =>
        await client.describeOperation(
          args.operation_id as string,
          args.input as Parameters<typeof client.describeOperation>[1]
        ),
      inputShape: describeOperationInputSchema,
      name: 'describe_operation',
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'Invoke one previously discovered Warm operation. Every write operation requires the approval_id returned for the exact same input by describe_operation.',
      handler: async (args) =>
        await client.invokeOperation(
          args.operation_id as string,
          args.input as Parameters<typeof client.invokeOperation>[1],
          typeof args.approval_id === 'string' ? args.approval_id : undefined
        ),
      inputShape: invokeOperationInputSchema,
      name: 'invoke_operation',
    },
  ];
  const tools = mode === 'automation' ? automationTools : contextTools;

  server.server.registerCapabilities({
    tools: {
      listChanged: true,
    },
  });

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      description: tool.description,
      annotations: tool.annotations,
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
    if (tool.name === 'get_transactions') {
      try {
        parseGetTransactionsArgs(parseResult.data);
      } catch (error) {
        throw new McpError(
          ErrorCode.InvalidParams,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    try {
      if (tool.name !== 'verify_key') {
        await client.validateAudience();
      }

      const result = await tool.handler(parseResult.data);
      const isFailedAutomationOperation =
        tool.name === 'invoke_operation' &&
        typeof result.status === 'number' &&
        result.status >= 400;
      return createStructuredToolResult(result, isFailedAutomationOperation);
    } catch (error) {
      return createToolFailure(error);
    }
  });
}

export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const { mode = 'context', serverInfo, ...clientOptions } = options;
  const server = new McpServer(serverInfo || WARM_SERVER_INFO);
  registerWarmTools(server, clientOptions, mode);
  return server;
}
