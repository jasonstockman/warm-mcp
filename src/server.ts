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
  privateMcpToolDescriptors,
} from '@warmio/contracts/mcp';
import {
  createReadOnlyWarmApiClient,
  createWarmApiClient,
  type ReadOnlyWarmApiClient,
  type ReadOnlyWarmApiClientOptions,
  type WarmApiClient,
  type WarmApiClientOptions,
  WarmApiError,
} from './warm-api-client.js';

export {
  createReadOnlyWarmApiClient,
  createWarmApiClient,
  getConfiguredApiKey,
  WarmApiError,
} from './warm-api-client.js';
export type { ReadOnlyWarmApiClientOptions, WarmApiClientOptions } from './warm-api-client.js';

export interface WarmServerOptions extends WarmApiClientOptions {
  serverInfo?: Implementation;
}
export interface ReadOnlyWarmServerOptions extends ReadOnlyWarmApiClientOptions {
  serverInfo?: Implementation;
}

function packageVersion(): string {
  try {
    return (
      (
        JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
          version?: string;
        }
      ).version || '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

export const WARM_SERVER_INFO = { name: 'warm', version: packageVersion() };

type WarmToolDefinition = {
  annotations?: ToolAnnotations;
  description: string;
  inputShape: ZodRawShape;
  name: string;
  handler: (args: Record<string, unknown>) => Promise<object>;
};

function structuredResult(value: object, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : { structuredContent: value }),
  };
}

function toolFailure(error: unknown) {
  if (error instanceof WarmApiError) {
    return structuredResult({ error: error.message, status: error.status }, true);
  }
  return structuredResult({ error: error instanceof Error ? error.message : String(error) }, true);
}

function descriptor(name: string) {
  const definition = privateMcpToolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing MCP contract for ${name}.`);
  return definition;
}

function canonicalToolDescriptor(name: string) {
  const tool = privateMcpToolDescriptors.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing MCP contract for ${name}.`);
  return tool;
}

function mcpOutputSchema(name: string) {
  const outputSchema = canonicalToolDescriptor(name).output_schema;
  return 'type' in outputSchema && outputSchema.type === 'object'
    ? outputSchema
    : { ...outputSchema, type: 'object' };
}

function readToolDefinitions(client: ReadOnlyWarmApiClient): WarmToolDefinition[] {
  return [
    {
      ...descriptor('get_financial_context'),
      handler: async () => await client.getFinancialContext(),
    },
    {
      ...descriptor('get_transactions'),
      handler: async (args) =>
        await client.getTransactions(
          normalizeGetTransactionsMcpInput(
            args as Parameters<typeof normalizeGetTransactionsMcpInput>[0]
          )
        ),
    },
  ];
}

function automationToolDefinitions(client: WarmApiClient): WarmToolDefinition[] {
  return [
    {
      ...descriptor('search_operations'),
      handler: async (args) =>
        await client.searchOperations(typeof args.query === 'string' ? args.query : undefined),
    },
    {
      ...descriptor('describe_operation'),
      handler: async (args) =>
        await client.describeOperation(
          args.operation_id as string,
          args.input as Parameters<WarmApiClient['describeOperation']>[1]
        ),
    },
    {
      ...descriptor('invoke_operation'),
      handler: async (args) =>
        await client.invokeOperation(
          args.operation_id as string,
          args.input as Parameters<WarmApiClient['invokeOperation']>[1],
          typeof args.approval_id === 'string' ? args.approval_id : undefined
        ),
    },
  ];
}

function registerTools(server: McpServer, tools: WarmToolDefinition[]): void {
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      annotations: tool.annotations,
      description: tool.description,
      inputSchema: toJsonSchemaCompat(z.object(tool.inputShape).strict(), {
        pipeStrategy: 'input',
        strictUnions: true,
      }),
      outputSchema: mcpOutputSchema(tool.name),
      name: tool.name,
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    const parsed = await z
      .object(tool.inputShape)
      .strict()
      .safeParseAsync(request.params.arguments ?? {});
    if (!parsed.success)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool ${tool.name}: ${parsed.error.message}`
      );
    if (tool.name === 'get_transactions') {
      const transactionInput = await getTransactionsMcpInputSchema.safeParseAsync(parsed.data);
      if (!transactionInput.success)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for tool ${tool.name}: ${transactionInput.error.message}`
        );
    }
    try {
      const result = await tool.handler(parsed.data);
      const invokeStatus = (result as { status?: unknown }).status;
      return structuredResult(
        result,
        tool.name === 'invoke_operation' && typeof invokeStatus === 'number' && invokeStatus >= 400
      );
    } catch (error) {
      return toolFailure(error);
    }
  });
}

/** Full API-key MCP server with read and automation tools. */
export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const { serverInfo, ...clientOptions } = options;
  const server = new McpServer(serverInfo || WARM_SERVER_INFO);
  const client = createWarmApiClient(clientOptions);
  registerTools(server, [...readToolDefinitions(client), ...automationToolDefinitions(client)]);
  return server;
}

/** JWT-only MCP server for Warm Chat. It never reads or falls back to an API key. */
export function createReadOnlyWarmServer(options: ReadOnlyWarmServerOptions): McpServer {
  const { serverInfo, ...clientOptions } = options;
  const server = new McpServer(serverInfo || WARM_SERVER_INFO);
  registerTools(server, readToolDefinitions(createReadOnlyWarmApiClient(clientOptions)));
  return server;
}
