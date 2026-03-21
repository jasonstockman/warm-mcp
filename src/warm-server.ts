import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  emptyInputSchema,
  getTransactionsInputSchema,
  getTransactionsOutputSchema,
  getStateInputSchema,
  getStateOutputSchema,
  verifyKeyOutputSchema,
  type Account,
  type GetAccountsOutput,
  type GetFinancialStateOutput,
  type GetStateInput,
  type GetStateOutput,
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
  WarmApiHolding,
  WarmApiHoldingsResponse,
  WarmApiLiability,
  WarmApiLiabilitiesResponse,
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

function normalizeDateOnly(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const directMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  if (directMatch) {
    return directMatch[0];
  }

  const dateTimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (dateTimeMatch) {
    return dateTimeMatch[1] ?? null;
  }

  const embeddedMatch = trimmed.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return embeddedMatch?.[0] ?? null;
}

interface QuerySelection {
  [key: string]: QuerySelection | true;
}

type QueryToken =
  | { type: 'brace_open' }
  | { type: 'brace_close' }
  | { type: 'name'; value: string };

const ROOT_QUERY_FIELDS = new Set(['accounts', 'financial_state']);

function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];

  for (let index = 0; index < query.length; ) {
    const char = query[index] ?? '';

    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '#') {
      while (index < query.length && query[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '{') {
      tokens.push({ type: 'brace_open' });
      index += 1;
      continue;
    }

    if (char === '}') {
      tokens.push({ type: 'brace_close' });
      index += 1;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < query.length && /[A-Za-z0-9_]/.test(query[end] ?? '')) {
        end += 1;
      }
      tokens.push({ type: 'name', value: query.slice(index, end) });
      index = end;
      continue;
    }

    throw new Error(`Unsupported query syntax near "${query.slice(index, index + 12)}"`);
  }

  return tokens;
}

function mergeSelection(
  left: QuerySelection | true | undefined,
  right: QuerySelection | true
): QuerySelection | true {
  if (!left) {
    return right;
  }

  if (left === true || right === true) {
    return true;
  }

  const merged: QuerySelection = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = mergeSelection(merged[key], value);
  }
  return merged;
}

function parseQuerySelection(query: string): QuerySelection {
  const tokens = tokenizeQuery(query);
  let index = 0;

  function parseSelectionSet(withOpeningBrace: boolean): QuerySelection {
    if (withOpeningBrace) {
      const openToken = tokens[index];
      if (openToken?.type !== 'brace_open') {
        throw new Error('Expected "{" to start a selection set.');
      }
      index += 1;
    }

    const selection: QuerySelection = {};

    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) break;

      if (token.type === 'brace_close') {
        if (!withOpeningBrace) {
          throw new Error('Unexpected "}" in query.');
        }
        index += 1;
        return selection;
      }

      if (token.type !== 'name') {
        throw new Error('Expected a field name in query.');
      }

      index += 1;
      const nextToken = tokens[index];
      const childSelection =
        nextToken?.type === 'brace_open' ? parseSelectionSet(true) : true;

      selection[token.value] = mergeSelection(selection[token.value], childSelection);
    }

    if (withOpeningBrace) {
      throw new Error('Unclosed "{" in query.');
    }

    return selection;
  }

  const selection =
    tokens[0]?.type === 'brace_open' ? parseSelectionSet(true) : parseSelectionSet(false);

  if (index !== tokens.length) {
    throw new Error('Unexpected trailing tokens in query.');
  }

  for (const rootField of Object.keys(selection)) {
    if (!ROOT_QUERY_FIELDS.has(rootField)) {
      throw new Error(
        `Unknown root field "${rootField}". Supported roots: accounts, financial_state.`
      );
    }
  }

  return selection;
}

function projectSelection(source: unknown, selection: QuerySelection | true): unknown {
  if (selection === true) {
    return source;
  }

  if (source == null) {
    return source;
  }

  if (Array.isArray(source)) {
    return source.map((item) => projectSelection(item, selection));
  }

  if (typeof source !== 'object') {
    return source;
  }

  const sourceRecord = source as Record<string, unknown>;
  const projected: Record<string, unknown> = {};

  for (const [field, childSelection] of Object.entries(selection)) {
    projected[field] = projectSelection(sourceRecord[field] ?? null, childSelection);
  }

  return projected;
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
    account_id: account.account_id ?? null,
    name: account.name || 'Unknown Account',
    type: normalizeAccountType(account.type),
    subtype: account.subtype ?? null,
    balance: roundMoney(account.current_balance ?? 0),
    available_balance:
      account.available_balance == null ? null : roundMoney(account.available_balance),
    institution: account.institution_name ?? null,
    mask: account.mask ?? null,
  };
}

function normalizeSnapshot(snapshot: WarmApiSnapshot): GetFinancialStateOutput['snapshots'][number] | null {
  const date = normalizeDateOnly(snapshot.snapshot_date || snapshot.period_end || null);
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
    next_date: normalizeDateOnly(stream.next_date),
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
    target_date: normalizeDateOnly(goal.target_date),
    status: goal.status ?? null,
    category: goal.category ?? null,
    monthly_contribution_needed:
      goal.monthly_contribution_needed == null
        ? null
        : roundMoney(goal.monthly_contribution_needed),
  };
}

function normalizeLiability(liability: WarmApiLiability): GetFinancialStateOutput['liabilities'][number] {
  return {
    account_id: liability.account_id || '',
    type: liability.type || 'unknown',
    balance: liability.balance == null ? null : roundMoney(liability.balance),
    apr_percentage: liability.apr_percentage ?? liability.interest_rate_percentage ?? null,
    minimum_payment: liability.minimum_payment == null ? null : roundMoney(liability.minimum_payment),
    next_payment_due_date: normalizeDateOnly(liability.next_payment_due_date),
    is_overdue: liability.is_overdue ?? null,
  };
}

function normalizeHolding(holding: WarmApiHolding): GetFinancialStateOutput['holdings'][number] {
  return {
    account_id: holding.account_id || '',
    security_name: holding.security_name ?? null,
    symbol: holding.symbol ?? null,
    type: holding.type ?? null,
    quantity: holding.quantity ?? 0,
    value: holding.value == null ? null : roundMoney(holding.value),
    cost_basis: holding.cost_basis == null ? null : roundMoney(holding.cost_basis),
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
        account_id: transaction.account_id ?? null,
        date: normalizeDateOnly(transaction.date),
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
    const [
      snapshotsResponse,
      recurringResponse,
      budgetsResponse,
      goalsResponse,
      healthResponse,
      liabilitiesResponse,
      holdingsResponse,
    ] = await Promise.all([
      apiRequest<WarmApiSnapshotsResponse>('/api/export', { dataset: 'snapshots' }, options),
      apiRequest<WarmApiRecurringResponse>('/api/export', { dataset: 'recurring' }, options),
      apiRequest<WarmApiBudgetsResponse>('/api/export', { dataset: 'budgets' }, options),
      apiRequest<WarmApiGoalsResponse>('/api/export', { dataset: 'goals' }, options),
      apiRequest<WarmApiHealthResponse>('/api/export', { dataset: 'health' }, options),
      apiRequest<WarmApiLiabilitiesResponse>('/api/export', { dataset: 'liabilities' }, options),
      apiRequest<WarmApiHoldingsResponse>('/api/export', { dataset: 'holdings' }, options),
    ]);

    // Extract category spending from the most recent snapshot's spending_by_category
    const snapshots = snapshotsResponse.snapshots || [];
    const latestWithCategories = snapshots.find(
      (s) => Array.isArray((s as Record<string, unknown>).spending_by_category)
    ) as (WarmApiSnapshot & { spending_by_category?: Array<{ category: string; amount: number }> }) | undefined;
    const categorySpending = (latestWithCategories?.spending_by_category || []).map((c) => ({
      category: c.category || 'Unknown',
      amount: roundMoney(Math.abs(c.amount ?? 0)),
    }));

    return {
      generated_at: asGeneratedAt(
        snapshotsResponse.generated_at,
        recurringResponse.generated_at,
        budgetsResponse.generated_at,
        goalsResponse.generated_at,
        healthResponse.generated_at
      ),
      snapshots: snapshots
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
      liabilities: (liabilitiesResponse.liabilities || []).map(normalizeLiability),
      holdings: (holdingsResponse.holdings || []).map(normalizeHolding),
      category_spending: categorySpending,
    };
  }

  async function getState(input: GetStateInput): Promise<GetStateOutput> {
    const selection = parseQuerySelection(input.query);
    const result: Record<string, unknown> = {};

    if (selection.accounts) {
      result.accounts = projectSelection((await getAccounts()).accounts, selection.accounts);
    }

    if (selection.financial_state) {
      result.financial_state = projectSelection(await getFinancialState(), selection.financial_state);
    }

    return { data: result };
  }

  async function verifyKey(): Promise<VerifyKeyOutput> {
    const response = await apiRequest<WarmApiVerifyResponse>('/api/verify', {}, options);
    return {
      valid: response.valid === true,
      status: response.status || (response.valid ? 'ok' : 'invalid'),
    };
  }

  return {
    getTransactions,
    getState,
    verifyKey,
  };
}

export function registerWarmTools(
  server: WarmToolRegistrationTarget,
  options: WarmApiClientOptions = {}
): RegisteredWarmTools {
  const client = createWarmApiClient(options);

  return {
    get_state: server.registerTool(
      'get_state',
      {
        description:
          'GraphQL-like read-only state query over accounts and financial_state.',
        inputSchema: getStateInputSchema as unknown as AnySchema,
        outputSchema: getStateOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async (args: GetStateInput) =>
        createStructuredToolResult(await client.getState(args))
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
