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
  getTransactionsMcpInputSchema,
  normalizeGetTransactionsMcpInput,
  privateMcpToolDefinitions,
  type PrivateMcpMode,
} from '@warmio/contracts/mcp';

import {
  createWarmApiClient,
  type WarmApiClientOptions,
  getConfiguredApiKey,
  verifyWarmApiKey,
  WarmApiError,
} from './warm-api-client.js';

export { createWarmApiClient, getConfiguredApiKey, verifyWarmApiKey, WarmApiError };
export type { WarmApiClientOptions } from './warm-api-client.js';

export interface WarmServerOptions extends WarmApiClientOptions {
  mode?: WarmServerMode;
  serverInfo?: Implementation;
}

export type WarmServerMode = PrivateMcpMode;

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
    ...(isError ? { isError: true } : { structuredContent }),
  };
}

interface WarmToolDefinition {
  annotations?: ToolAnnotations;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  inputShape: ZodRawShape;
  name: string;
  outputSchema: z.ZodTypeAny;
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

function getToolDefinition(name: string, mode: WarmServerMode) {
  const definition = privateMcpToolDefinitions.find(
    (candidate) => candidate.mode === mode && candidate.name === name
  );
  if (!definition) throw new Error(`Missing ${mode} MCP contract for ${name}.`);
  return definition;
}

function getListToolOutputSchema(outputSchema: z.ZodTypeAny) {
  const schema = toJsonSchemaCompat(outputSchema, {
    pipeStrategy: 'output',
    strictUnions: true,
  });

  if (schema.type === 'object') return schema;
  if (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.length > 0 &&
    schema.anyOf.every(
      (candidate) =>
        typeof candidate === 'object' && candidate !== null && candidate.type === 'object'
    )
  ) {
    return { ...schema, type: 'object' };
  }
  return undefined;
}

export function registerWarmTools(
  server: McpServer,
  options: WarmApiClientOptions = {},
  mode: WarmServerMode = 'context'
): void {
  const client = createWarmApiClient({ ...options, audience: mode });
  const contextTools: WarmToolDefinition[] = [
    {
      ...getToolDefinition('get_financial_context', 'context'),
      handler: async () => await client.getFinancialContext(),
    },
    {
      ...getToolDefinition('get_transactions', 'context'),
      handler: async (args) => {
        return await client.getTransactions(normalizeGetTransactionsMcpInput(args));
      },
    },
    {
      ...getToolDefinition('verify_key', 'context'),
      handler: async () => await client.validateAudience(),
    },
  ];
  const automationTools: WarmToolDefinition[] = [
    {
      ...getToolDefinition('search_operations', 'automation'),
      handler: async (args) =>
        await client.searchOperations(typeof args.query === 'string' ? args.query : undefined),
    },
    {
      ...getToolDefinition('describe_operation', 'automation'),
      handler: async (args) =>
        await client.describeOperation(
          args.operation_id as string,
          args.input as Parameters<typeof client.describeOperation>[1]
        ),
    },
    {
      ...getToolDefinition('invoke_operation', 'automation'),
      handler: async (args) =>
        await client.invokeOperation(
          args.operation_id as string,
          args.input as Parameters<typeof client.invokeOperation>[1],
          typeof args.approval_id === 'string' ? args.approval_id : undefined
        ),
    },
  ];
  const tools = mode === 'automation' ? automationTools : contextTools;

  server.server.registerCapabilities({
    tools: {
      listChanged: true,
    },
  });

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => {
      const outputSchema = getListToolOutputSchema(tool.outputSchema);
      return {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: toJsonSchemaCompat(z.object(tool.inputShape).strict(), {
          pipeStrategy: 'input',
          strictUnions: true,
        }),
        ...(outputSchema ? { outputSchema } : {}),
        name: tool.name,
      };
    }),
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
      const transactionInput = await getTransactionsMcpInputSchema.safeParseAsync(parseResult.data);
      if (!transactionInput.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for tool ${request.params.name}: ${transactionInput.error.message}`
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
