import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  emptyInputSchema,
  getAccountsOutputSchema,
  getFinancialStateOutputSchema,
  getTransactionsInputSchema,
  getTransactionsOutputSchema,
  verifyKeyOutputSchema,
  type Account,
  type GetAccountsOutput,
  type GetFinancialStateOutput,
  type GetTransactionsInput,
  type GetTransactionsOutput,
  type VerifyKeyOutput,
} from './schemas.js';
import type {
  RegisteredWarmTools,
  WarmApiAccount,
  WarmApiAccountsResponse,
  WarmApiClient,
  WarmApiClientOptions,
  WarmApiTransactionsResponse,
  WarmApiVerifyResponse,
  WarmServerOptions,
  WarmToolRegistrationTarget,
} from './types.js';
import { getWarmApiKeyPath } from './config-paths.js';

const DEFAULT_API_URL = process.env.WARM_API_URL || 'https://warm.io';
const DEFAULT_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

let cachedApiKey: string | null | undefined;

export const WARM_SERVER_INFO = {
  name: 'warm',
  version: getPackageVersion(),
} as const;

export const API_URL = DEFAULT_API_URL;

function getPackageVersion(): string {
  try {
    const packageJson = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(packageJson) as { version?: string };
    return parsed.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function getRequestSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

function normalizeAccountType(rawType: string | null | undefined): Account['type'] {
  switch (rawType) {
    case 'depository':
    case 'credit':
    case 'loan':
    case 'investment':
      return rawType;
    default:
      return 'other';
  }
}

function normalizeAccount(account: WarmApiAccount): GetAccountsOutput['accounts'][number] {
  return {
    name: account.name || 'Unknown Account',
    type: normalizeAccountType(account.type),
    subtype: account.subtype ?? null,
    balance: roundMoney(account.current_balance ?? 0),
    institution: account.institution_name ?? null,
    mask: account.mask ?? null,
  };
}

function createWarmApiClientConfig(options: WarmApiClientOptions) {
  return {
    apiUrl: options.apiUrl || DEFAULT_API_URL,
    apiKeyResolver: options.apiKeyResolver,
    fetchImplementation: options.fetchImplementation || fetch,
    requestTimeoutMs: options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export function getConfiguredApiKey(): string | null {
  if (cachedApiKey !== undefined) {
    return cachedApiKey;
  }

  if (process.env.WARM_API_KEY?.trim()) {
    cachedApiKey = process.env.WARM_API_KEY.trim();
    return cachedApiKey;
  }

  const configPath = getWarmApiKeyPath();
  try {
    cachedApiKey = fs.readFileSync(configPath, 'utf-8').trim() || null;
  } catch {
    cachedApiKey = null;
  }

  return cachedApiKey;
}

export async function apiRequest<TResponse>(
  endpoint: string,
  params: Record<string, string | undefined> = {},
  options: WarmApiClientOptions = {}
): Promise<TResponse> {
  const requestOptions = createWarmApiClientConfig(options);
  const apiKey = requestOptions.apiKeyResolver?.() ?? getConfiguredApiKey();

  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  const url = new URL(endpoint, requestOptions.apiUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.append(key, value);
    }
  });

  let response: Response;
  try {
    response = await requestOptions.fetchImplementation(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: getRequestSignal(requestOptions.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Warm API timed out after ${requestOptions.requestTimeoutMs}ms`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Warm API request aborted after ${requestOptions.requestTimeoutMs}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const errorMessages: Record<number, string> = {
      401: 'Invalid or expired API key. Regenerate at https://warm.io/settings',
      403: 'Pro subscription required. Upgrade at https://warm.io/settings',
      429: 'Rate limit exceeded. Try again in a few minutes.',
    };

    if (errorMessages[response.status]) {
      throw new Error(errorMessages[response.status]);
    }

    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) {
        detail = body.error;
      }
    } catch {
      // Ignore response parse failures and fall back to status text.
    }

    throw new Error(detail);
  }

  return (await response.json()) as TResponse;
}

function createStructuredToolResult<TStructured extends Record<string, unknown>>(
  structuredContent: TStructured
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

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  async function getAccounts(): Promise<GetAccountsOutput> {
    const response = await apiRequest<WarmApiAccountsResponse>(
      '/api/export',
      { dataset: 'accounts' },
      options
    );

    return {
      accounts: (response.accounts || []).map(normalizeAccount),
    };
  }

  async function getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput> {
    const response = await apiRequest<WarmApiTransactionsResponse>(
      '/api/transactions',
      {
        limit: String(input.limit),
        cursor: input.cursor,
        last_knowledge: input.last_knowledge,
        search: input.search,
      },
      options
    );
    const nextCursor = response.pagination?.next_cursor ?? null;

    return {
      generated_at: response.generated_at ?? null,
      next_knowledge: response.next_knowledge ?? null,
      txns: (response.transactions || []).map((transaction) => ({
        id: transaction.id ?? null,
        date: transaction.date ?? null,
        amount: roundMoney(transaction.amount ?? 0),
        merchant: transaction.merchant_name ?? null,
        description: transaction.name ?? null,
        category: transaction.primary_category ?? null,
        detailed_category: transaction.detailed_category ?? null,
      })),
      pagination: {
        limit: response.pagination?.limit ?? input.limit,
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
      },
    };
  }

  async function getFinancialState(): Promise<GetFinancialStateOutput> {
    return apiRequest<GetFinancialStateOutput>('/api/financial-state', {}, options);
  }

  async function verifyKey(): Promise<VerifyKeyOutput> {
    const response = await apiRequest<WarmApiVerifyResponse>('/api/verify', {}, options);
    return {
      valid: response.valid === true,
      status: response.status || (response.valid ? 'ok' : 'invalid'),
    };
  }

  return {
    getAccounts,
    getTransactions,
    getFinancialState,
    verifyKey,
  };
}

export function registerWarmTools(
  server: WarmToolRegistrationTarget,
  options: WarmApiClientOptions = {}
): RegisteredWarmTools {
  const client = createWarmApiClient(options);

  return {
    get_accounts: server.registerTool(
      'get_accounts',
      {
        description:
          'Read-only list of connected financial accounts with balances, subtypes, institutions, and masks when available.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: getAccountsOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.getAccounts())
    ),
    get_transactions: server.registerTool(
      'get_transactions',
      {
        description:
          'Read-only transaction export with strict opaque cursor pagination and optional last_knowledge incremental sync.',
        inputSchema: getTransactionsInputSchema as unknown as AnySchema,
        outputSchema: getTransactionsOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async (args: GetTransactionsInput) =>
        createStructuredToolResult(await client.getTransactions(args))
    ),
    get_financial_state: server.registerTool(
      'get_financial_state',
      {
        description:
          'Read-only broad financial state bundle with snapshots, recurring payments, budgets, goals, financial health, liabilities, holdings, and category spending.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: getFinancialStateOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.getFinancialState())
    ),
    verify_key: server.registerTool(
      'verify_key',
      {
        description: 'Read-only API key validation for the configured Warm account.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: verifyKeyOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.verifyKey())
    ),
  };
}

export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const server = new McpServer(options.serverInfo || WARM_SERVER_INFO);
  registerWarmTools(server, options);
  return server;
}

export async function verifyWarmApiKey(apiKey: string): Promise<VerifyKeyOutput> {
  const client = createWarmApiClient({
    apiKeyResolver: () => apiKey,
  });

  return client.verifyKey();
}
