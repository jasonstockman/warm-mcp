/**
 * Warm MCP server worker and shared API helpers.
 *
 * The transport layer lives elsewhere. This module exposes the reusable MCP
 * server factory plus the shared Warm API request helpers used by stdio, HTTP,
 * and installation flows.
 */

import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PACKAGE_VERSION = getPackageVersion();

export const WARM_SERVER_INFO = {
  name: 'warm',
  version: PACKAGE_VERSION,
} as const;

export const API_URL = process.env.WARM_API_URL || 'https://warm.io';

const MAX_TRANSACTION_PAGES = 10;
const MAX_TRANSACTION_SCAN = 5_000;
const TRANSACTION_PAGE_SIZE = 200;
const TRANSACTION_CACHE_TTL_MS = 600_000;
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

let cachedApiKey: string | null | undefined;

let txnCache: {
  key: string;
  transactions: CompactTransaction[];
  summary: ReturnType<typeof calculateSummary>;
  fetchedAt: number;
} | null = null;

interface WarmApiRequestOptions {
  apiKey?: string;
}

interface Transaction {
  id: string | null;
  date: string | null;
  amount: number | null;
  merchant_name?: string | null;
  name?: string | null;
  primary_category?: string | null;
  detailed_category?: string | null;
}

interface ApiAccount {
  name?: string | null;
  type?: string | null;
  current_balance?: number | null;
}

interface ApiSnapshot {
  snapshot_date?: string;
  d?: string;
  net_worth?: number;
  nw?: number;
  total_assets?: number;
  a?: number;
  total_liabilities?: number;
  l?: number;
}

interface ApiRecurring {
  average_amount?: number | null;
  description?: string | null;
  frequency?: string | null;
  is_active?: boolean | null;
  last_amount?: number | null;
  merchant_name?: string | null;
  next_date?: string | null;
  stream_type?: string | null;
}

interface ApiBudget {
  name?: string | null;
  amount?: number | null;
  spent?: number | null;
  remaining?: number | null;
  percent_used?: number | null;
  period?: string | null;
  status?: string | null;
  budget_type?: string | null;
  rollover_enabled?: boolean | null;
  effective_amount?: number | null;
}

interface ApiGoal {
  name?: string | null;
  target?: number | null;
  current?: number | null;
  progress_percent?: number | null;
  target_date?: string | null;
  status?: string | null;
  category?: string | null;
  monthly_contribution_needed?: number | null;
  linked_account?: string | null;
}

interface ApiHealth {
  score?: number | null;
  label?: string | null;
  pillars?: {
    spend?: number | null;
    save?: number | null;
    borrow?: number | null;
    build?: number | null;
  } | null;
  data_completeness?: number | null;
  message?: string | null;
  generated_at?: string;
}

interface CompactTransaction {
  d: string;
  a: number;
  m: string;
  c: string | null;
}

function getPackageVersion(): string {
  try {
    const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(packageJson) as { version?: string };
    return parsed.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function compactTransaction(t: Transaction): CompactTransaction {
  return {
    d: t.date || '',
    a: roundCurrency(t.amount ?? 0),
    m: t.merchant_name || t.name || 'Unknown',
    c: t.primary_category ?? null,
  };
}

function inDateRange(t: Transaction, since?: string, until?: string): boolean {
  if (!t.date) return false;
  if (since && t.date < since) return false;
  if (until && t.date > until) return false;
  return true;
}

function calculateSummary(transactions: CompactTransaction[]) {
  if (transactions.length === 0) {
    return { total: 0, count: 0, avg: 0 };
  }

  const total = transactions.reduce((sum, t) => sum + t.a, 0);
  return {
    total: roundCurrency(total),
    count: transactions.length,
    avg: roundCurrency(total / transactions.length),
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
    cachedApiKey = readFileSync(configPath, 'utf-8').trim() || null;
  } catch {
    cachedApiKey = null;
  }

  return cachedApiKey;
}

function resolveApiKey(explicitApiKey?: string): string | null {
  if (explicitApiKey !== undefined) {
    const trimmed = explicitApiKey.trim();
    return trimmed || null;
  }

  return getConfiguredApiKey();
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

export async function apiRequest(
  endpoint: string,
  params: Record<string, string> = {},
  options: WarmApiRequestOptions = {}
): Promise<unknown> {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  const url = new URL(endpoint, API_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.append(key, value);
    }
  });

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: getRequestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Warm API timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Warm API request aborted after ${REQUEST_TIMEOUT_MS}ms`);
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
      // Ignore JSON parsing failures for non-JSON error responses.
    }

    throw new Error(detail);
  }

  return response.json();
}

export async function verifyWarmApiKey(apiKey: string): Promise<{
  valid: boolean;
  status: string;
}> {
  const response = (await apiRequest('/api/verify', {}, { apiKey })) as {
    valid?: boolean;
    status?: string;
  };

  return {
    valid: response.valid === true,
    status: response.status || (response.valid ? 'ok' : 'invalid'),
  };
}

async function handleGetAccounts(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'accounts' })) as {
    accounts?: ApiAccount[];
    generated_at?: string;
  };

  return {
    accounts: (response.accounts || []).map((account) => ({
      name: account.name || 'Unknown Account',
      type: account.type || 'other',
      balance: roundCurrency(account.current_balance ?? 0),
    })),
  };
}

async function fetchAllTransactions(since?: string, until?: string): Promise<{
  transactions: CompactTransaction[];
  summary: ReturnType<typeof calculateSummary>;
}> {
  const cacheKey = `${since || ''}|${until || ''}`;
  if (
    txnCache &&
    txnCache.key === cacheKey &&
    Date.now() - txnCache.fetchedAt < TRANSACTION_CACHE_TTL_MS
  ) {
    return {
      transactions: txnCache.transactions,
      summary: txnCache.summary,
    };
  }

  let transactions: Transaction[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  let scanned = 0;

  do {
    const params: Record<string, string> = {
      limit: String(TRANSACTION_PAGE_SIZE),
    };

    if (since && !cursor) {
      params.last_knowledge = since;
    }
    if (cursor) {
      params.cursor = cursor;
    }

    const response = (await apiRequest('/api/transactions', params)) as {
      transactions?: Transaction[];
      pagination?: { next_cursor: string | null };
    };

    const batch = response.transactions || [];
    transactions.push(...batch);
    scanned += batch.length;
    pagesFetched += 1;
    cursor = response.pagination?.next_cursor ?? undefined;
  } while (cursor && pagesFetched < MAX_TRANSACTION_PAGES && scanned < MAX_TRANSACTION_SCAN);

  if (until) {
    transactions = transactions.filter((t) => inDateRange(t, since, until));
  }

  const compactTxns = transactions.map(compactTransaction);
  const summary = calculateSummary(compactTxns);

  txnCache = {
    key: cacheKey,
    transactions: compactTxns,
    summary,
    fetchedAt: Date.now(),
  };

  return { transactions: compactTxns, summary };
}

async function handleGetTransactions(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const until = args?.until ? String(args.until) : undefined;
  const limit = Math.min(Math.max(args?.limit ? Number(args.limit) : 500, 1), 1000);
  const offset = Math.max(args?.offset ? Number(args.offset) : 0, 0);

  const { transactions, summary } = await fetchAllTransactions(since, until);
  const total = transactions.length;

  return {
    summary,
    txns: transactions.slice(offset, offset + limit),
    total,
    has_more: offset + limit < total,
  };
}

async function handleGetSnapshots(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const response = (await apiRequest('/api/export', {
    dataset: 'snapshots',
    ...(since ? { since } : {}),
  })) as {
    snapshots?: ApiSnapshot[];
    generated_at?: string;
  };

  const limit = args?.limit ? Number(args.limit) : 30;
  const normalized = (response.snapshots || []).map((snapshot) => ({
    date: snapshot.snapshot_date || snapshot.d || '',
    net_worth: snapshot.net_worth ?? snapshot.nw ?? 0,
    total_assets: snapshot.total_assets ?? snapshot.a ?? 0,
    total_liabilities: snapshot.total_liabilities ?? snapshot.l ?? 0,
  }));

  let filtered = normalized;
  if (since) {
    filtered = filtered.filter((snapshot) => snapshot.date >= since);
  }

  filtered.sort((a, b) => b.date.localeCompare(a.date));
  if (limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  return {
    snapshots: filtered.map((snapshot) => ({
      d: snapshot.date,
      nw: roundCurrency(snapshot.net_worth),
      a: roundCurrency(snapshot.total_assets),
      l: roundCurrency(snapshot.total_liabilities),
    })),
  };
}

async function handleGetRecurring(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const limit = Math.min(Math.max(args?.limit ? Number(args.limit) : 100, 1), 500);
  const response = (await apiRequest('/api/export', {
    dataset: 'recurring',
    ...(since ? { since } : {}),
  })) as {
    recurring_transactions?: ApiRecurring[];
    generated_at?: string;
  };

  return {
    recurring: (response.recurring_transactions || []).slice(0, limit).map((stream) => ({
      merchant: stream.merchant_name || stream.description || 'Unknown',
      amount: roundCurrency(Math.abs(stream.average_amount ?? stream.last_amount ?? 0)),
      frequency: stream.frequency || 'UNKNOWN',
      next_date: stream.next_date || null,
      type: stream.stream_type || null,
      active: stream.is_active !== false,
    })),
  };
}

async function handleGetBudgets(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'budgets' })) as {
    budgets?: ApiBudget[];
    generated_at?: string;
  };

  return {
    budgets: (response.budgets || []).map((budget) => ({
      name: budget.name || 'Unnamed Budget',
      amount: roundCurrency(budget.amount ?? 0),
      spent: roundCurrency(budget.spent ?? 0),
      remaining: roundCurrency(budget.remaining ?? 0),
      percent_used: roundCurrency(budget.percent_used ?? 0),
      period: budget.period || 'monthly',
      status: budget.status || null,
    })),
  };
}

async function handleGetGoals(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'goals' })) as {
    goals?: ApiGoal[];
    generated_at?: string;
  };

  return {
    goals: (response.goals || []).map((goal) => ({
      name: goal.name || 'Unnamed Goal',
      target: roundCurrency(goal.target ?? 0),
      current: roundCurrency(goal.current ?? 0),
      progress_percent: roundCurrency(goal.progress_percent ?? 0),
      target_date: goal.target_date || null,
      status: goal.status || null,
      category: goal.category || null,
      monthly_contribution_needed:
        goal.monthly_contribution_needed != null
          ? roundCurrency(goal.monthly_contribution_needed)
          : null,
    })),
  };
}

async function handleGetHealth(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'health' })) as ApiHealth;

  return {
    score: response.score ?? null,
    label: response.label || null,
    pillars: response.pillars || null,
    data_completeness: response.data_completeness ?? null,
    ...(response.message ? { message: response.message } : {}),
  };
}

async function handleVerifyKey(): Promise<unknown> {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  return verifyWarmApiKey(apiKey);
}

const toolHandlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {
  get_accounts: handleGetAccounts,
  get_transactions: handleGetTransactions,
  get_recurring: handleGetRecurring,
  get_snapshots: handleGetSnapshots,
  get_budgets: handleGetBudgets,
  get_goals: handleGetGoals,
  get_health: handleGetHealth,
  verify_key: handleVerifyKey,
};

const warmTools = [
  {
    name: 'get_accounts',
    description:
      'Get all connected bank accounts with current balances.\n\nReturns: { accounts: Array<{ name: string; type: string; balance: number }> }\n\nAccount types: depository (checking/savings), credit, loan, investment, other.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_transactions',
    description:
      'Get transactions with date filtering and pagination. Returns a summary of the FULL date range plus a paginated slice of individual transactions.\n\nAmounts: positive = expense/debit, negative = income/credit (Plaid convention).\nCategories in field `c`: INCOME, TRANSFER_IN = income. FOOD_AND_DRINK, TRANSPORTATION, ENTERTAINMENT, GENERAL_MERCHANDISE, RENT_AND_UTILITIES, LOAN_PAYMENTS, etc. = expenses.\n\nReturns: { summary: { total: number; count: number; avg: number }; txns: Array<{ d: string; a: number; m: string; c: string | null }>; total: number; has_more: boolean }\n\nCall multiple times with increasing offset to paginate. The summary is always computed over ALL matching transactions regardless of limit/offset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: {
          type: 'string',
          description: 'Start date inclusive (YYYY-MM-DD). Omit to get all available transactions.',
        },
        until: {
          type: 'string',
          description: 'End date inclusive (YYYY-MM-DD). Omit for no end date filter.',
        },
        limit: {
          type: 'number',
          description: 'Max transactions per page (default 500, max 1000).',
        },
        offset: {
          type: 'number',
          description: 'Skip N transactions for pagination (default 0).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_recurring',
    description:
      'Get recurring subscriptions and income streams.\n\nReturns: { recurring: Array<{ merchant: string; amount: number; frequency: string; next_date: string | null; type: string | null; active: boolean }> }',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: {
          type: 'string',
          description: 'Start date inclusive (YYYY-MM-DD). Omit to get all recurring streams.',
        },
        limit: {
          type: 'number',
          description: 'Max recurring streams to return (default 100, max 500).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_snapshots',
    description:
      'Get daily net worth snapshots over time.\n\nReturns: { snapshots: Array<{ d: string; nw: number; a: number; l: number }> }\n\nFields: d = date, nw = net worth, a = total assets, l = total liabilities. Sorted newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max snapshots to return (default 30).',
        },
        since: {
          type: 'string',
          description: 'Start date inclusive (YYYY-MM-DD).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_budgets',
    description:
      'Get all budgets with spending progress.\n\nReturns: { budgets: Array<{ name: string; amount: number; spent: number; remaining: number; percent_used: number; period: string; status: string | null }> }',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_goals',
    description:
      'Get all savings goals with progress.\n\nReturns: { goals: Array<{ name: string; target: number; current: number; progress_percent: number; target_date: string | null; status: string | null; category: string | null; monthly_contribution_needed: number | null }> }',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_health',
    description:
      'Get financial health score and pillar breakdown.\n\nReturns: { score: number | null; label: string | null; pillars: { spend: number; save: number; borrow: number; build: number } | null; data_completeness: number | null }',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'verify_key',
    description: 'Check if the API key is valid.\n\nReturns: { valid: boolean; status: string }',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
] as const;

export function createWarmServer(): Server {
  const server = new Server(WARM_SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...warmTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const handler = toolHandlers[name];
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const data = await handler(args as Record<string, unknown> | undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startStdioServer(): Promise<Server> {
  const server = createWarmServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
