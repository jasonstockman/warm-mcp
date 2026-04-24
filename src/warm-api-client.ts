import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';

type NormalizedAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

export interface WarmApiClientOptions {
  apiKeyResolver?: () => string | null;
  apiUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface WarmApiAccount {
  account_id?: string | null;
  available_balance?: number | null;
  current_balance?: number | null;
  institution_name?: string | null;
  mask?: string | null;
  name?: string | null;
  subtype?: string | null;
  type?: string | null;
}

export interface WarmApiTransaction {
  account_id?: string | null;
  amount?: number | null;
  date?: string | null;
  detailed_category?: string | null;
  id?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  primary_category?: string | null;
}

export interface WarmApiBudget {
  amount?: number | null;
  name?: string | null;
  period?: string | null;
  percent_used?: number | null;
  remaining?: number | null;
  spent?: number | null;
  status?: string | null;
}

export interface WarmApiGoal {
  category?: string | null;
  current?: number | null;
  monthly_contribution_needed?: number | null;
  name?: string | null;
  progress_percent?: number | null;
  status?: string | null;
  target?: number | null;
  target_date?: string | null;
}

export interface WarmFinancialState extends Record<string, unknown> {
  budgets: Array<{
    amount: number;
    name: string;
    percent_used: number;
    period: string;
    remaining: number;
    spent: number;
    status: string | null;
  }>;
  category_spending: Array<{
    amount: number;
    category: string;
  }>;
  generated_at: string;
  goals: Array<{
    category: string | null;
    current: number;
    monthly_contribution_needed: number | null;
    name: string;
    progress_percent: number;
    status: string | null;
    target: number;
    target_date: string | null;
  }>;
  health: {
    data_completeness: number | null;
    label: string | null;
    message: string | null;
    pillars: {
      borrow: number | null;
      build: number | null;
      save: number | null;
      spend: number | null;
    } | null;
    score: number | null;
  };
  holdings: Array<{
    account_id: string;
    cost_basis: number | null;
    quantity: number;
    security_name: string | null;
    symbol: string | null;
    type: string | null;
    value: number | null;
  }>;
  liabilities: Array<{
    account_id: string;
    apr_percentage: number | null;
    balance: number | null;
    is_overdue: boolean | null;
    minimum_payment: number | null;
    next_payment_due_date: string | null;
    type: string;
  }>;
  recurring: Array<{
    active: boolean;
    amount: number;
    frequency: string;
    merchant: string;
    next_date: string | null;
    type: string | null;
  }>;
  snapshots: Array<{
    date: string;
    net_worth: number;
    total_assets: number;
    total_liabilities: number;
  }>;
}

interface StateAccount {
  available_balance: number | null;
  balance: number;
  institution: string | null;
  mask: string | null;
  name: string;
  subtype: string | null;
  type: NormalizedAccountType;
}

export interface GetTransactionsInput {
  cursor?: string;
  last_knowledge?: string;
  limit: number;
  search?: string;
}

export interface GetTransactionsOutput extends Record<string, unknown> {
  generated_at: string | null;
  next_knowledge: string | null;
  pagination: {
    has_more: boolean;
    limit: number;
    next_cursor: string | null;
  };
  txns: Array<{
    amount: number;
    category: string | null;
    date: string | null;
    description: string | null;
    detailed_category: string | null;
    id: string | null;
    merchant: string | null;
  }>;
}

export interface GetAccountsOutput extends Record<string, unknown> {
  accounts: Array<{
    balance: number;
    institution: string | null;
    mask: string | null;
    name: string;
    subtype: string | null;
    type: NormalizedAccountType;
  }>;
}

export interface VerifyKeyOutput extends Record<string, unknown> {
  status: string;
  valid: boolean;
}

export interface WarmApiClient {
  getAccounts(): Promise<GetAccountsOutput>;
  getFinancialState(): Promise<WarmFinancialState>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
  verifyKey(): Promise<VerifyKeyOutput>;
}

interface WarmApiAccountsResponse {
  accounts?: WarmApiAccount[];
  generated_at?: string;
}

interface WarmApiTransactionsResponse {
  generated_at?: string;
  next_knowledge?: string;
  pagination?: {
    limit?: number | null;
    next_cursor?: string | null;
  };
  transactions?: WarmApiTransaction[];
}

interface WarmApiSnapshot {
  date?: string | null;
  net_worth?: number | null;
  period_end?: string | null;
  snapshot_date?: string | null;
  total_assets?: number | null;
  total_liabilities?: number | null;
}

interface WarmApiRecurring {
  active?: boolean | null;
  amount?: number | null;
  average_amount?: number | null;
  description?: string | null;
  frequency?: string | null;
  is_active?: boolean | null;
  last_amount?: number | null;
  merchant?: string | null;
  merchant_name?: string | null;
  next_date?: string | null;
  stream_type?: string | null;
  type?: string | null;
}

interface WarmApiHealth {
  data_completeness?: number | null;
  label?: string | null;
  message?: string | null;
  pillars?: {
    borrow?: number | null;
    build?: number | null;
    save?: number | null;
    spend?: number | null;
  } | null;
  score?: number | null;
}

interface WarmApiSnapshotsResponse {
  generated_at?: string;
  snapshots?: WarmApiSnapshot[];
}

interface WarmApiRecurringResponse {
  generated_at?: string;
  recurring_transactions?: WarmApiRecurring[];
  recurring?: WarmApiRecurring[];
}

interface WarmApiBudgetsResponse {
  budgets?: WarmApiBudget[];
  generated_at?: string;
}

interface WarmApiGoalsResponse {
  generated_at?: string;
  goals?: WarmApiGoal[];
}

interface WarmApiHealthResponse extends WarmApiHealth {
  generated_at?: string;
}

export interface WarmApiLiability {
  account_id?: string | null;
  apr_percentage?: number | null;
  balance?: number | null;
  is_overdue?: boolean | null;
  minimum_payment?: number | null;
  next_payment_due_date?: string | null;
  type?: string | null;
}

interface WarmApiLiabilitiesResponse {
  generated_at?: string;
  liabilities?: WarmApiLiability[];
}

export interface WarmApiHolding {
  account_id?: string | null;
  cost_basis?: number | null;
  quantity?: number | null;
  security_name?: string | null;
  symbol?: string | null;
  type?: string | null;
  value?: number | null;
}

interface WarmApiHoldingsResponse {
  generated_at?: string;
  holdings?: WarmApiHolding[];
}

interface WarmApiSpendingResponse {
  generated_at?: string;
  spending?: Array<{
    category?: string | null;
    total?: number | null;
  }>;
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
const DEFAULT_SPENDING_MONTHS = 6;

let cachedApiKey: string | null | undefined;

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

function normalizeAccountType(rawType: string | null | undefined): NormalizedAccountType {
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

function normalizeStateAccount(account: WarmApiAccount): StateAccount {
  return {
    available_balance:
      account.available_balance == null ? null : roundMoney(account.available_balance),
    balance: roundMoney(account.current_balance ?? 0),
    institution: account.institution_name ?? null,
    mask: account.mask ?? null,
    name: account.name || 'Unknown Account',
    subtype: account.subtype ?? null,
    type: normalizeAccountType(account.type),
  };
}

function normalizeAccounts(accounts: WarmApiAccount[]): GetAccountsOutput {
  return {
    accounts: accounts.map((account) => {
      const normalized = normalizeStateAccount(account);
      return {
        balance: normalized.balance,
        institution: normalized.institution,
        mask: normalized.mask,
        name: normalized.name,
        subtype: normalized.subtype,
        type: normalized.type,
      };
    }),
  };
}

function normalizeFinancialState(input: {
  budgets?: WarmApiBudget[];
  categorySpending?: WarmApiSpendingResponse['spending'];
  generatedAt: string;
  goals?: WarmApiGoal[];
  health?: WarmApiHealth;
  holdings?: WarmApiHolding[];
  liabilities?: WarmApiLiability[];
  recurring?: WarmApiRecurring[];
  snapshots?: WarmApiSnapshot[];
}): WarmFinancialState {
  return {
    budgets: (input.budgets || []).map((budget) => ({
      amount: budget.amount ?? 0,
      name: budget.name || '',
      percent_used: budget.percent_used ?? 0,
      period: budget.period || '',
      remaining: budget.remaining ?? 0,
      spent: budget.spent ?? 0,
      status: budget.status ?? null,
    })),
    category_spending: (input.categorySpending || []).map((item) => ({
      amount: roundMoney(item?.total ?? 0),
      category: item?.category || 'Uncategorized',
    })),
    generated_at: input.generatedAt,
    goals: (input.goals || []).map((goal) => ({
      category: goal.category ?? null,
      current: goal.current ?? 0,
      monthly_contribution_needed: goal.monthly_contribution_needed ?? null,
      name: goal.name || '',
      progress_percent: goal.progress_percent ?? 0,
      status: goal.status ?? null,
      target: goal.target ?? 0,
      target_date: goal.target_date ?? null,
    })),
    health: {
      data_completeness: input.health?.data_completeness ?? null,
      label: input.health?.label ?? null,
      message: input.health?.message ?? null,
      pillars: input.health?.pillars
        ? {
            borrow: input.health.pillars.borrow ?? null,
            build: input.health.pillars.build ?? null,
            save: input.health.pillars.save ?? null,
            spend: input.health.pillars.spend ?? null,
          }
        : null,
      score: input.health?.score ?? null,
    },
    holdings: (input.holdings || []).map((holding) => ({
      account_id: holding.account_id || '',
      cost_basis: holding.cost_basis ?? null,
      quantity: roundMoney(holding.quantity ?? 0),
      security_name: holding.security_name ?? null,
      symbol: holding.symbol ?? null,
      type: holding.type ?? null,
      value: holding.value == null ? null : roundMoney(holding.value),
    })),
    liabilities: (input.liabilities || []).map((liability) => ({
      account_id: liability.account_id || '',
      apr_percentage: liability.apr_percentage ?? null,
      balance: liability.balance == null ? null : roundMoney(liability.balance),
      is_overdue: liability.is_overdue ?? null,
      minimum_payment:
        liability.minimum_payment == null ? null : roundMoney(liability.minimum_payment),
      next_payment_due_date: liability.next_payment_due_date ?? null,
      type: liability.type || 'unknown',
    })),
    recurring: (input.recurring || []).map((stream) => ({
      active: stream.active === true || stream.is_active === true,
      amount: roundMoney(stream.amount ?? stream.last_amount ?? stream.average_amount ?? 0),
      frequency: stream.frequency || '',
      merchant: stream.merchant || stream.merchant_name || stream.description || '',
      next_date: stream.next_date ?? null,
      type: stream.type ?? stream.stream_type ?? null,
    })),
    snapshots: (input.snapshots || [])
      .map((snapshot) => ({
        date: snapshot.date || snapshot.snapshot_date || snapshot.period_end || null,
        net_worth: snapshot.net_worth ?? 0,
        total_assets: snapshot.total_assets ?? 0,
        total_liabilities: snapshot.total_liabilities ?? 0,
      }))
      .filter((snapshot): snapshot is { date: string; net_worth: number; total_assets: number; total_liabilities: number } =>
        typeof snapshot.date === 'string'
      )
      .map((snapshot) => ({
        date: snapshot.date,
        net_worth: roundMoney(snapshot.net_worth),
        total_assets: roundMoney(snapshot.total_assets),
        total_liabilities: roundMoney(snapshot.total_liabilities),
      })),
  };
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
      'WARM_API_KEY not set. Run "npx -y @warmio/mcp@latest" to configure or set WARM_API_KEY.'
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
      // Fall back to the HTTP status when the error body is not JSON.
    }

    throw new Error(detail);
  }

  return (await response.json()) as TResponse;
}

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  const getAccounts = async (): Promise<GetAccountsOutput> => {
    const response = await apiRequest<WarmApiAccountsResponse>(
      '/api/export',
      { dataset: 'accounts' },
      options
    );

    return normalizeAccounts(response.accounts || []);
  };

  const getFinancialState = async (): Promise<WarmFinancialState> => {
    const [
      snapshotsResponse,
      recurringResponse,
      budgetsResponse,
      goalsResponse,
      healthResponse,
      liabilitiesResponse,
      holdingsResponse,
      spendingResponse,
    ] = await Promise.all([
      apiRequest<WarmApiSnapshotsResponse>('/api/export', { dataset: 'snapshots' }, options),
      apiRequest<WarmApiRecurringResponse>('/api/export', { dataset: 'recurring' }, options),
      apiRequest<WarmApiBudgetsResponse>('/api/export', { dataset: 'budgets' }, options),
      apiRequest<WarmApiGoalsResponse>('/api/export', { dataset: 'goals' }, options),
      apiRequest<WarmApiHealthResponse>('/api/export', { dataset: 'health' }, options),
      apiRequest<WarmApiLiabilitiesResponse>('/api/export', { dataset: 'liabilities' }, options),
      apiRequest<WarmApiHoldingsResponse>('/api/export', { dataset: 'holdings' }, options),
      apiRequest<WarmApiSpendingResponse>(
        '/api/spending',
        { months: String(DEFAULT_SPENDING_MONTHS) },
        options
      ),
    ]);

    const generatedAt =
      spendingResponse.generated_at ||
      holdingsResponse.generated_at ||
      liabilitiesResponse.generated_at ||
      healthResponse.generated_at ||
      goalsResponse.generated_at ||
      budgetsResponse.generated_at ||
      recurringResponse.generated_at ||
      snapshotsResponse.generated_at ||
      new Date().toISOString();

    return normalizeFinancialState({
      budgets: budgetsResponse.budgets,
      categorySpending: spendingResponse.spending,
      generatedAt,
      goals: goalsResponse.goals,
      health: healthResponse,
      holdings: holdingsResponse.holdings,
      liabilities: liabilitiesResponse.liabilities,
      recurring: recurringResponse.recurring || recurringResponse.recurring_transactions,
      snapshots: snapshotsResponse.snapshots,
    });
  };

  const getTransactions = async (input: GetTransactionsInput): Promise<GetTransactionsOutput> => {
    const response = await apiRequest<WarmApiTransactionsResponse>(
      '/api/export',
      {
        cursor: input.cursor,
        dataset: 'transactions',
        last_knowledge: input.last_knowledge,
        limit: String(input.limit),
        search: input.search,
      },
      options
    );
    const nextCursor = response.pagination?.next_cursor ?? null;

    return {
      generated_at: response.generated_at ?? null,
      next_knowledge: response.next_knowledge ?? null,
      pagination: {
        has_more: nextCursor !== null,
        limit: response.pagination?.limit ?? input.limit,
        next_cursor: nextCursor,
      },
      txns: (response.transactions || []).map((transaction) => ({
        amount: roundMoney(transaction.amount ?? 0),
        category: transaction.primary_category ?? null,
        date: transaction.date ?? null,
        description: transaction.name ?? null,
        detailed_category: transaction.detailed_category ?? null,
        id: transaction.id ?? null,
        merchant: transaction.merchant_name ?? null,
      })),
    };
  };

  const verifyKey = async (): Promise<VerifyKeyOutput> => {
    const response = await apiRequest<WarmApiVerifyResponse>('/api/verify', {}, options);
    return {
      status: response.status || (response.valid ? 'ok' : 'invalid'),
      valid: response.valid === true,
    };
  };

  return {
    getAccounts,
    getFinancialState,
    getTransactions,
    verifyKey,
  };
}

export async function verifyWarmApiKey(apiKey: string): Promise<VerifyKeyOutput> {
  return createWarmApiClient({
    apiKeyResolver: () => apiKey,
  }).verifyKey();
}
