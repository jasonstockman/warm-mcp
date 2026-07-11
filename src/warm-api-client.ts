import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';

export interface WarmApiClientOptions {
  apiKeyResolver?: () => string | null;
  apiUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface TransactionIndex {
  total: number;
  months: Array<{
    month: string;
    count: number;
  }>;
}

export interface Position {
  date: string | null;
  net_worth: number | null;
  cash: number | null;
  debt: number | null;
  investments: number | null;
  other_assets: number | null;
  total_assets: number | null;
}

export interface Account {
  id: string;
  name: string;
  type: 'depository' | 'credit' | 'loan' | 'investment' | 'brokerage' | 'other';
  subtype: string | null;
  group: 'cash' | 'debt' | 'investments' | null;
  institution: string | null;
  mask: string | null;
  balance: number | null;
  available: number | null;
  currency: string | null;
  updated_at: string | null;
}

export interface Status {
  position: Position | null;
  accounts: Account[];
}

export interface Recurring {
  id: string;
  account_id: string | null;
  direction: 'inflow' | 'outflow' | null;
  frequency:
    | 'WEEKLY'
    | 'BIWEEKLY'
    | 'MONTHLY'
    | 'QUARTERLY'
    | 'SEMI_ANNUALLY'
    | 'ANNUALLY'
    | null;
  status: 'active' | 'inactive' | 'dismissed' | null;
  merchant: string | null;
  amount: number | null;
  next_date: string | null;
}

export interface Budget {
  id: string;
  name: string;
  type: 'category' | 'merchant';
  period: 'weekly' | 'biweekly' | 'monthly';
  status: 'under' | 'warning' | 'over';
  amount: number;
  spent: number;
  remaining: number;
  used_percent: number;
}

export interface Goal {
  id: string;
  name: string;
  category: string;
  status: 'not_started' | 'in_progress' | 'on_track' | 'behind' | 'completed';
  target: number;
  current: number;
  progress_percent: number;
  target_date: string | null;
}

export interface Snapshot {
  date: string;
  net_worth: number | null;
  cash: number | null;
  debt: number | null;
  income: number | null;
  expenses: number | null;
  cash_flow: number | null;
  savings_rate: number | null;
  investments: number | null;
  assets: number | null;
  health_score: number | null;
}

export interface Liability {
  account_id: string | null;
  type: 'credit' | 'student' | 'mortgage' | 'other' | null;
  balance: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  interest_rate: number | null;
  rate_type: 'fixed' | 'variable' | null;
  overdue: boolean | null;
}

export interface Holding {
  account_id: string | null;
  symbol: string | null;
  name: string | null;
  type: 'cash' | 'derivative' | 'equity' | 'etf' | 'fixed_income' | 'mutual_fund' | 'other' | null;
  quantity: number | null;
  value: number | null;
  cost_basis: number | null;
}

export interface Health {
  score: number;
  label: 'Needs Attention' | 'Good' | 'Strong';
  level: 'critical' | 'poor' | 'fair' | 'good' | 'strong';
  summary: string;
  data_completeness: number;
  pillars: {
    spend: number | null;
    save: number | null;
    borrow: number | null;
    build: number | null;
  } | null;
}

export interface FinancialContext extends Record<string, unknown> {
  version: 'v1';
  updated_at: string;
  currency: 'USD';
  status: Status;
  transactions: TransactionIndex;
  recurring: Recurring[];
  budgets: Budget[];
  goals: Goal[];
  snapshots: Snapshot[];
  liabilities: Liability[];
  holdings: Holding[];
  health: Health | null;
}

export interface Transaction {
  id: string;
  account_id: string | null;
  date: string | null;
  amount: number;
  merchant: string | null;
  name: string | null;
  category: string | null;
  subcategory: string | null;
  pending: boolean | null;
  currency: string | null;
}

export interface TransactionMonth extends Record<string, unknown> {
  month: string;
  start_date: string;
  end_date: string;
  count: number;
  items: Transaction[];
}

export interface LatestTransactions extends Record<string, unknown> {
  since: string;
  window_days: 10;
  count: number;
  items: Transaction[];
}

export type GetTransactionsInput =
  | { month: string; latest?: never }
  | { latest: true; month?: never };

export type GetTransactionsOutput = TransactionMonth | LatestTransactions;

export interface FinancialContextMeta extends Record<string, unknown> {
  version: 'v1';
  user_id: string;
  context_id: string;
  generated_at: string;
  updated_at: string;
  content_hash: string;
  byte_length: number;
  counts: {
    accounts: number;
    transaction_months: number;
    transactions: number;
    snapshots: number;
  };
}

export interface VerifyKeyOutput extends Record<string, unknown> {
  status: string;
  valid: boolean;
}

export interface WarmApiClient {
  getFinancialContext(): Promise<FinancialContext>;
  getFinancialContextMeta(): Promise<FinancialContextMeta>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
  verifyKey(): Promise<VerifyKeyOutput>;
}

interface WarmApiVerifyResponse {
  status?: string;
  valid?: boolean;
}

const DEFAULT_API_URL = process.env.WARM_API_URL || 'https://warm.io';
const DEFAULT_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();
let cachedApiKey: string | null | undefined;

function getRequestSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

function createWarmApiClientConfig(options: WarmApiClientOptions) {
  return {
    apiKeyResolver: options.apiKeyResolver,
    apiUrl: options.apiUrl || DEFAULT_API_URL,
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

  cachedApiKey = readConfigFile(getWarmApiKeyPath());
  return cachedApiKey;
}

export function resetConfiguredApiKeyCache(): void {
  cachedApiKey = undefined;
}

export async function apiRequest<TResponse>(
  endpoint: string,
  params: Record<string, string | undefined> = {},
  options: WarmApiClientOptions = {}
): Promise<TResponse> {
  const requestOptions = createWarmApiClientConfig(options);
  const apiKey = requestOptions.apiKeyResolver?.() ?? getConfiguredApiKey();

  if (!apiKey) {
    throw new Error(
      'WARM_API_KEY not set. Run "npx @warmio/mcp" to configure or set WARM_API_KEY.'
    );
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
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
      403: 'API access is available on paid plans only. Upgrade at https://warm.io/settings',
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
      // Fall back to the HTTP status when the error body is not JSON.
    }

    throw new Error(detail);
  }

  return (await response.json()) as TResponse;
}

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  const getFinancialContext = async (): Promise<FinancialContext> =>
    await apiRequest<FinancialContext>('/api/financial-context', {}, options);

  const getFinancialContextMeta = async (): Promise<FinancialContextMeta> =>
    await apiRequest<FinancialContextMeta>('/api/financial-context/meta', {}, options);

  const getTransactions = async (
    input: GetTransactionsInput
  ): Promise<GetTransactionsOutput> => {
    const rawInput = input as { latest?: unknown; month?: unknown };
    if (typeof rawInput.month === 'string' && rawInput.latest !== undefined) {
      throw new Error('`month` and `latest` are mutually exclusive.');
    }
    if (typeof rawInput.month === 'string') {
      return await apiRequest<GetTransactionsOutput>(
        '/api/financial-context/transactions',
        { month: rawInput.month, latest: undefined },
        options
      );
    }
    if (rawInput.latest === true) {
      return await apiRequest<GetTransactionsOutput>(
        '/api/financial-context/transactions',
        { month: undefined, latest: '1' },
        options
      );
    }

    throw new Error(
      'Call getTransactions with `month` in YYYY-MM format or `latest: true`.'
    );
  };

  const verifyKey = async (): Promise<VerifyKeyOutput> => {
    const response = await apiRequest<WarmApiVerifyResponse>('/api/verify', {}, options);
    return {
      status: response.status || (response.valid ? 'ok' : 'invalid'),
      valid: response.valid === true,
    };
  };

  return {
    getFinancialContext,
    getFinancialContextMeta,
    getTransactions,
    verifyKey,
  };
}

export async function verifyWarmApiKey(apiKey: string): Promise<VerifyKeyOutput> {
  return createWarmApiClient({
    apiKeyResolver: () => apiKey,
  }).verifyKey();
}
