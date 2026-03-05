/**
 * Warm MCP Server
 *
 * Provides financial data from the Warm API as MCP tools.
 * Reads API key from WARM_API_KEY env var or ~/.config/warm/api_key.
 *
 * Four read-only tools: get_accounts, get_transactions, get_snapshots, verify_key.
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
const TRANSACTION_CACHE_TTL_MS = 60_000; // 60s cache for paginated reads
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
  const response = (await apiRequest('/api/accounts')) as {
    accounts?: Array<{
      name: string;
      type: string;
      balance: number;
      institution: string;
    }>;
    generated_at?: string;
  };

  return {
    accounts: response.accounts || [],
  };
}

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
  const response = (await apiRequest('/api/snapshots')) as {
    snapshots?: ApiSnapshot[];
    generated_at?: string;
  };
  const snapshots = response.snapshots || [];

  const limit = args?.limit ? Number(args.limit) : 30;
  const since = args?.since as string | undefined;

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

const toolHandlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {
  get_accounts: handleGetAccounts,
  get_transactions: handleGetTransactions,
  get_snapshots: handleGetSnapshots,
  verify_key: handleVerifyKey,
};

// ============================================
// SERVER SETUP
// ============================================

const server = new Server({ name: 'warm', version: '3.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_accounts',
      description:
        'Get all connected bank accounts with current balances.\n\nReturns: { accounts: Array<{ name: string; type: string; balance: number; institution: string }> }\n\nAccount types: depository (checking/savings), credit, loan, investment, other.',
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
