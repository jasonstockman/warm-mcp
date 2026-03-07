/**
 * Warm MCP Server
 *
 * Provides financial data from the Warm API as MCP tools.
 * Reads API key from WARM_API_KEY env var or ~/.config/warm/api_key.
 *
 * Eight read-only tools: get_accounts, get_transactions, get_recurring, get_snapshots,
 * get_budgets, get_goals, get_health, verify_key.
 * The AI client handles all analysis — no sandbox needed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_URL = process.env.WARM_API_URL || 'https://warm.io';
const MAX_TRANSACTION_PAGES = 10;
const MAX_TRANSACTION_SCAN = 5_000;
const TRANSACTION_PAGE_SIZE = 200;
const TRANSACTION_CACHE_TTL_MS = 600_000; // 10min cache for paginated reads
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

let cachedApiKey: string | null | undefined;

// In-memory transaction cache to avoid re-fetching on paginated reads
let txnCache: {
  key: string;
  transactions: CompactTransaction[];
  summary: ReturnType<typeof calculateSummary>;
  fetchedAt: number;
} | null = null;

// ============================================
// API RESPONSE TYPE DEFINITIONS
// ============================================

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

interface CompactTransaction {
  d: string; // date
  a: number; // amount (positive = expense, negative = income)
  m: string; // merchant
  c: string | null; // primary category
}

function compactTransaction(t: Transaction): CompactTransaction {
  return {
    d: t.date || '',
    a: t.amount ? Math.round(t.amount * 100) / 100 : 0,
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
    total: Math.round(total * 100) / 100,
    count: transactions.length,
    avg: Math.round((total / transactions.length) * 100) / 100,
  };
}

function getApiKey(): string | null {
  if (cachedApiKey !== undefined) {
    return cachedApiKey;
  }

  if (process.env.WARM_API_KEY) {
    cachedApiKey = process.env.WARM_API_KEY;
    return cachedApiKey;
  }

  const configPath = path.join(os.homedir(), '.config', 'warm', 'api_key');
  try {
    cachedApiKey = fs.readFileSync(configPath, 'utf-8').trim();
  } catch {
    cachedApiKey = null;
  }
  return cachedApiKey;
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

async function apiRequest(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  const url = new URL(endpoint, API_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
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
      if (body?.error) detail = body.error;
    } catch { /* ignore parse failures */ }
    throw new Error(detail);
  }

  return response.json();
}

// ============================================
// TOOL HANDLERS
// ============================================

async function handleGetAccounts(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'accounts' })) as {
    accounts?: ApiAccount[];
    generated_at?: string;
  };

  return {
    accounts: (response.accounts || []).map((account) => ({
      name: account.name || 'Unknown Account',
      type: account.type || 'other',
      balance: Math.round((account.current_balance ?? 0) * 100) / 100,
    })),
  };
}

// TODO: Migrate to /api/export?dataset=transactions when the unified export
// endpoint supports cursor-based pagination. Currently uses legacy /api/transactions.
async function fetchAllTransactions(since?: string, until?: string): Promise<{
  transactions: CompactTransaction[];
  summary: ReturnType<typeof calculateSummary>;
}> {
  const cacheKey = `${since || ''}|${until || ''}`;
  if (txnCache && txnCache.key === cacheKey && Date.now() - txnCache.fetchedAt < TRANSACTION_CACHE_TTL_MS) {
    return { transactions: txnCache.transactions, summary: txnCache.summary };
  }

  let transactions: Transaction[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  let scanned = 0;

  do {
    const params: Record<string, string> = {
      limit: String(TRANSACTION_PAGE_SIZE),
    };
    if (since && !cursor) params.last_knowledge = since;
    if (cursor) params.cursor = cursor;

    const response = (await apiRequest('/api/transactions', params)) as {
      transactions?: Transaction[];
      pagination?: { next_cursor: string | null };
    };

    const batch = (response.transactions || []) as Transaction[];
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

  txnCache = { key: cacheKey, transactions: compactTxns, summary, fetchedAt: Date.now() };

  return { transactions: compactTxns, summary };
}

async function handleGetTransactions(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const until = args?.until ? String(args.until) : undefined;
  const limit = Math.min(Math.max(args?.limit ? Number(args.limit) : 500, 1), 1000);
  const offset = Math.max(args?.offset ? Number(args.offset) : 0, 0);

  const { transactions: compactTxns, summary } = await fetchAllTransactions(since, until);
  const total = compactTxns.length;
  const page = compactTxns.slice(offset, offset + limit);

  return {
    summary,
    txns: page,
    total,
    has_more: offset + limit < total,
  };
}

async function handleGetSnapshots(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const response = (await apiRequest('/api/export', { dataset: 'snapshots', ...(since ? { since } : {}) })) as {
    snapshots?: ApiSnapshot[];
    generated_at?: string;
  };
  const snapshots = response.snapshots || [];

  const limit = args?.limit ? Number(args.limit) : 30;

  const normalized = snapshots.map((s) => ({
    date: s.snapshot_date || s.d || '',
    net_worth: s.net_worth ?? s.nw ?? 0,
    total_assets: s.total_assets ?? s.a ?? 0,
    total_liabilities: s.total_liabilities ?? s.l ?? 0,
  }));

  let filtered = normalized;
  if (since) {
    filtered = filtered.filter((s) => s.date >= since);
  }

  filtered.sort((a, b) => b.date.localeCompare(a.date));
  if (limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  const result = filtered.map((s) => ({
    d: s.date,
    nw: Math.round(s.net_worth * 100) / 100,
    a: Math.round(s.total_assets * 100) / 100,
    l: Math.round(s.total_liabilities * 100) / 100,
  }));

  return { snapshots: result };
}

async function handleGetRecurring(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const limit = Math.min(Math.max(args?.limit ? Number(args.limit) : 100, 1), 500);

  const response = (await apiRequest('/api/export', { dataset: 'recurring', ...(since ? { since } : {}) })) as {
    recurring_transactions?: ApiRecurring[];
    generated_at?: string;
  };

  const recurring = (response.recurring_transactions || []).slice(0, limit).map((stream) => ({
    merchant: stream.merchant_name || stream.description || 'Unknown',
    amount: Math.round(Math.abs(stream.average_amount ?? stream.last_amount ?? 0) * 100) / 100,
    frequency: stream.frequency || 'UNKNOWN',
    next_date: stream.next_date || null,
    type: stream.stream_type || null,
    active: stream.is_active !== false,
  }));

  return { recurring };
}

async function handleVerifyKey(): Promise<unknown> {
  const response = (await apiRequest('/api/verify')) as {
    valid?: boolean;
    status?: string;
    error?: string;
  };

  return {
    valid: response.valid === true,
    status: response.status || (response.valid ? 'ok' : 'invalid'),
  };
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

async function handleGetBudgets(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'budgets' })) as {
    budgets?: ApiBudget[];
    generated_at?: string;
  };

  return {
    budgets: (response.budgets || []).map((b) => ({
      name: b.name || 'Unnamed Budget',
      amount: Math.round((b.amount ?? 0) * 100) / 100,
      spent: Math.round((b.spent ?? 0) * 100) / 100,
      remaining: Math.round((b.remaining ?? 0) * 100) / 100,
      percent_used: Math.round((b.percent_used ?? 0) * 100) / 100,
      period: b.period || 'monthly',
      status: b.status || null,
    })),
  };
}

async function handleGetGoals(): Promise<unknown> {
  const response = (await apiRequest('/api/export', { dataset: 'goals' })) as {
    goals?: ApiGoal[];
    generated_at?: string;
  };

  return {
    goals: (response.goals || []).map((g) => ({
      name: g.name || 'Unnamed Goal',
      target: Math.round((g.target ?? 0) * 100) / 100,
      current: Math.round((g.current ?? 0) * 100) / 100,
      progress_percent: Math.round((g.progress_percent ?? 0) * 100) / 100,
      target_date: g.target_date || null,
      status: g.status || null,
      category: g.category || null,
      monthly_contribution_needed: g.monthly_contribution_needed != null
        ? Math.round(g.monthly_contribution_needed * 100) / 100
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

// ============================================
// SERVER SETUP
// ============================================

const server = new Server({ name: 'warm', version: '3.0.3' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const handler = toolHandlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const data = await handler(args as Record<string, unknown> | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
