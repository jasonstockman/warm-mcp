import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  WarmApiBudgetsResponse,
  WarmApiClient,
  WarmApiClientOptions,
  WarmApiGoal,
  WarmApiGoalsResponse,
  WarmApiHealthResponse,
  WarmApiRecurring,
  WarmApiRecurringResponse,
  WarmApiSnapshot,
  WarmApiSnapshotsResponse,
  WarmApiTransactionsResponse,
  WarmApiVerifyResponse,
  WarmServerOptions,
  WarmToolRegistrationTarget,
} from './types.js';

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

function normalizeSnapshot(snapshot: WarmApiSnapshot): GetFinancialStateOutput['snapshots'][number] | null {
  const date = snapshot.snapshot_date || snapshot.period_end || null;
  if (!date) {
    return null;
  }

  const totalAssets =
    snapshot.total_assets ??
    (snapshot.total_cash ?? 0) + (snapshot.investment_value ?? 0) + (snapshot.asset_value ?? 0);
  const totalLiabilities = snapshot.total_liabilities ?? snapshot.total_debt ?? snapshot.liability_value ?? 0;

  return {
    date,
    net_worth: roundMoney(snapshot.net_worth ?? totalAssets - totalLiabilities),
    total_assets: roundMoney(totalAssets),
    total_liabilities: roundMoney(totalLiabilities),
  };
}

function normalizeRecurring(stream: WarmApiRecurring): GetFinancialStateOutput['recurring'][number] {
  return {
    merchant: stream.merchant_name || stream.description || 'Unknown',
    amount: roundMoney(Math.abs(stream.average_amount ?? stream.last_amount ?? 0)),
    frequency: stream.frequency || 'UNKNOWN',
    next_date: stream.next_date ?? null,
    type: stream.stream_type ?? null,
    active: stream.is_active !== false,
  };
}

function normalizeGoal(goal: WarmApiGoal): GetFinancialStateOutput['goals'][number] {
  return {
    name: goal.name || 'Unnamed Goal',
    target: roundMoney(goal.target ?? 0),
    current: roundMoney(goal.current ?? 0),
    progress_percent: roundMoney(goal.progress_percent ?? 0),
    target_date: goal.target_date ?? null,
    status: goal.status ?? null,
    category: goal.category ?? null,
    monthly_contribution_needed:
      goal.monthly_contribution_needed == null
        ? null
        : roundMoney(goal.monthly_contribution_needed),
  };
}

function asGeneratedAt(...values: Array<string | null | undefined>): string {
  return values.find((value): value is string => Boolean(value)) || new Date().toISOString();
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

  const configPath = path.join(os.homedir(), '.config', 'warm', 'api_key');
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
    const [snapshotsResponse, recurringResponse, budgetsResponse, goalsResponse, healthResponse] =
      await Promise.all([
        apiRequest<WarmApiSnapshotsResponse>('/api/export', { dataset: 'snapshots' }, options),
        apiRequest<WarmApiRecurringResponse>('/api/export', { dataset: 'recurring' }, options),
        apiRequest<WarmApiBudgetsResponse>('/api/export', { dataset: 'budgets' }, options),
        apiRequest<WarmApiGoalsResponse>('/api/export', { dataset: 'goals' }, options),
        apiRequest<WarmApiHealthResponse>('/api/export', { dataset: 'health' }, options),
      ]);

    return {
      generated_at: asGeneratedAt(
        snapshotsResponse.generated_at,
        recurringResponse.generated_at,
        budgetsResponse.generated_at,
        goalsResponse.generated_at,
        healthResponse.generated_at
      ),
      snapshots: (snapshotsResponse.snapshots || [])
        .map(normalizeSnapshot)
        .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null),
      recurring: (recurringResponse.recurring_transactions || []).map(normalizeRecurring),
      budgets: (budgetsResponse.budgets || []).map((budget) => ({
        name: budget.name || 'Unnamed Budget',
        amount: roundMoney(budget.amount ?? 0),
        spent: roundMoney(budget.spent ?? 0),
        remaining: roundMoney(budget.remaining ?? 0),
        percent_used: roundMoney(budget.percent_used ?? 0),
        period: budget.period || 'monthly',
        status: budget.status ?? null,
      })),
      goals: (goalsResponse.goals || []).map(normalizeGoal),
      health: {
        score: healthResponse.score ?? null,
        label: healthResponse.label ?? null,
        data_completeness: healthResponse.data_completeness ?? null,
        pillars: healthResponse.pillars
          ? {
              spend: healthResponse.pillars.spend ?? null,
              save: healthResponse.pillars.save ?? null,
              borrow: healthResponse.pillars.borrow ?? null,
              build: healthResponse.pillars.build ?? null,
            }
          : null,
        message: healthResponse.message ?? null,
      },
    };
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
          'Read-only broad financial state bundle with snapshots, recurring payments, budgets, goals, and financial health.',
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
