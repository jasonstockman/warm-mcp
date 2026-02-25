/**
 * Warm MCP Server
 *
 * Provides financial data from the Warm API as MCP tools.
 * Reads API key from WARM_API_KEY env var or ~/.config/warm/api_key.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateApiTypeString } from './api-types.js';
import { executeSandboxedCode } from './sandbox.js';

const API_URL = process.env.WARM_API_URL || 'https://warm.io';
const MAX_RESPONSE_SIZE = 50_000;
const MAX_TRANSACTION_PAGES = 10;
const MAX_TRANSACTION_SCAN = 5_000;
const TRANSACTION_PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

let cachedApiKey: string | null | undefined;

interface Transaction {
  id: string;
  date: string;
  amount: number;
  merchant_name?: string;
  name?: string;
  primary_category?: string;
  detailed_category?: string;
}

interface CompactTransaction {
  d: string; // date
  a: number; // amount (positive = expense, negative = income)
  m: string; // merchant
  c: string | null; // primary category
}

function compactTransaction(t: Transaction): CompactTransaction {
  return {
    d: t.date,
    // Positive = expense, negative = income/deposit (Plaid convention)
    a: Math.round(t.amount * 100) / 100,
    m: t.merchant_name || t.name || 'Unknown',
    c: t.primary_category || null,
  };
}

function inDateRange(t: Transaction, since?: string, until?: string): boolean {
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
    throw new Error(errorMessages[response.status] || `HTTP ${response.status}`);
  }

  return response.json();
}

function sizeCheck(data: unknown[], maxSize: number): unknown[] {
  let output = JSON.stringify(data);
  if (output.length > maxSize) {
    const reducedCount = Math.floor(data.length * (maxSize / output.length) * 0.8);
    return data.slice(0, reducedCount);
  }
  return data;
}

// ============================================
// EXTRACTED TOOL HANDLERS
// ============================================

async function handleGetAccounts(): Promise<unknown> {
  return apiRequest('/api/accounts');
}

async function handleGetTransactions(args?: Record<string, unknown>): Promise<unknown> {
  const since = args?.since ? String(args.since) : undefined;
  const until = args?.until ? String(args.until) : undefined;
  const parsedLimit = args?.limit ? Number(args.limit) : 200;
  const requestedLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.floor(parsedLimit), 1000))
    : 200;

  let transactions: Transaction[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  let scanned = 0;

  do {
    const params: Record<string, string> = {
      limit: String(TRANSACTION_PAGE_SIZE),
    };
    if (since) params.last_knowledge = since;
    if (cursor) params.cursor = cursor;

    const response = (await apiRequest('/api/transactions', params)) as {
      transactions?: Transaction[];
      cursor?: string;
    };

    const batch = (response.transactions || []) as Transaction[];
    transactions.push(...batch);
    scanned += batch.length;
    pagesFetched += 1;
    cursor = response.cursor;
  } while (cursor && pagesFetched < MAX_TRANSACTION_PAGES && scanned < MAX_TRANSACTION_SCAN);

  if (until) {
    transactions = transactions.filter((t) => inDateRange(t, since, until));
  }

  const compactTxns = transactions.map(compactTransaction);
  const summary = calculateSummary(compactTxns);
  const limited = compactTxns.slice(0, requestedLimit);
  const truncated = compactTxns.length > requestedLimit;

  const result: {
    summary: ReturnType<typeof calculateSummary>;
    txns: CompactTransaction[];
    more?: number;
  } = { summary, txns: limited };

  if (truncated) {
    result.more = compactTxns.length - requestedLimit;
  }

  let output = JSON.stringify(result);
  if (output.length > MAX_RESPONSE_SIZE) {
    const reducedCount = Math.floor(limited.length * (MAX_RESPONSE_SIZE / output.length) * 0.8);
    result.txns = limited.slice(0, reducedCount);
    result.more = compactTxns.length - reducedCount;
  }

  return result;
}

async function handleGetRecurring(): Promise<unknown> {
  const response = (await apiRequest('/api/subscriptions')) as {
    recurring_transactions?: Array<Record<string, unknown>>;
  };
  const raw = response.recurring_transactions || [];

  const recurring = raw.map((r) => ({
    merchant: r.merchant_name || r.merchant || r.name || 'Unknown',
    // Normalize to positive amounts
    amount: Math.round(Math.abs(Number(r.amount) || 0) * 100) / 100,
    frequency: r.frequency,
    next_date: r.next_date,
  }));

  const checked = sizeCheck(recurring, MAX_RESPONSE_SIZE) as typeof recurring;
  const result: { recurring: typeof recurring; more?: number } = { recurring: checked };
  if (checked.length < recurring.length) {
    result.more = recurring.length - checked.length;
  }

  return result;
}

async function handleGetSnapshots(args?: Record<string, unknown>): Promise<unknown> {
  const response = (await apiRequest('/api/snapshots')) as {
    snapshots?: Array<Record<string, unknown>>;
  };
  const snapshots = response.snapshots || [];

  const granularity = (args?.granularity as string) || 'daily';
  const defaultLimit = granularity === 'daily' ? 30 : 0;
  const limit = args?.limit ? Number(args.limit) : defaultLimit;
  const since = args?.since as string | undefined;

  let filtered = snapshots;
  if (since) {
    filtered = filtered.filter((s) => String(s.snapshot_date) >= since);
  }

  if (granularity === 'monthly') {
    const byMonth = new Map<string, Record<string, unknown>>();
    filtered.forEach((s) => {
      const month = String(s.snapshot_date).substring(0, 7);
      if (!byMonth.has(month) || String(s.snapshot_date) > String(byMonth.get(month)!.snapshot_date)) {
        byMonth.set(month, s);
      }
    });
    filtered = Array.from(byMonth.values());
  }

  filtered.sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)));
  if (limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  const result = filtered.map((s) => ({
    d: s.snapshot_date,
    nw: s.net_worth,
    a: s.total_assets,
    l: s.total_liabilities,
  }));

  return { granularity, snapshots: result };
}

async function handleVerifyKey(): Promise<unknown> {
  return apiRequest('/api/verify');
}

async function handleGetBudgets(): Promise<unknown> {
  return apiRequest('/api/budgets');
}

async function handleGetGoals(): Promise<unknown> {
  return apiRequest('/api/goals');
}

async function handleGetHealth(): Promise<unknown> {
  return apiRequest('/api/health');
}

async function handleGetSpending(args?: Record<string, unknown>): Promise<unknown> {
  const months = args?.months ? String(args.months) : '6';
  return apiRequest('/api/spending', { months });
}

// Tool name → handler mapping for sandbox dispatch
const toolHandlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {
  get_accounts: handleGetAccounts,
  get_transactions: handleGetTransactions,
  get_recurring: handleGetRecurring,
  get_snapshots: handleGetSnapshots,
  verify_key: handleVerifyKey,
  get_budgets: handleGetBudgets,
  get_goals: handleGetGoals,
  get_health: handleGetHealth,
  get_spending: handleGetSpending,
};

// ============================================
// SERVER SETUP
// ============================================

const server = new Server({ name: 'warm', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_accounts',
      description:
        'Get all connected bank accounts with balances. Use for: "What accounts do I have?", "What is my checking balance?", "Show my credit cards".\nReturns: { accounts: Array<{ name: string; type: string; balance: number; institution: string }> }',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_transactions',
      description:
        'Get transactions and analyze spending. Use for: "How much did I spend on coffee?", "Show my purchases", "What did I buy last month?", "Show my income". Use the `c` (category) field to filter: INCOME and TRANSFER_IN = income, all others = expenses. Amounts: positive = expense, negative = income/deposit.\nReturns: { summary: { total: number; count: number; avg: number }; txns: Array<{ d: string; a: number; m: string; c: string | null }>; more?: number }',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description: 'Start date inclusive (YYYY-MM-DD)',
          },
          until: {
            type: 'string',
            description: 'End date inclusive (YYYY-MM-DD)',
          },
          limit: {
            type: 'number',
            description: 'Max transactions to return (default: 200, max: 1000)',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_recurring',
      description:
        'Get detected subscriptions and recurring payments. Use for: "What subscriptions do I have?", "Show my monthly bills", "What are my recurring charges?".\nReturns: { recurring: Array<{ merchant: string; amount: number; frequency: string; next_date: string | null }> }',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_snapshots',
      description:
        'Get net worth history over time. Use for: "How has my net worth changed?", "Show my financial progress", "What was my balance last month?".\nReturns: { granularity: string; snapshots: Array<{ d: string; nw: number; a: number; l: number }> }',
      inputSchema: {
        type: 'object' as const,
        properties: {
          granularity: {
            type: 'string',
            enum: ['daily', 'monthly'],
            description: 'daily or monthly (default: daily)',
          },
          limit: {
            type: 'number',
            description: 'Number of snapshots (default: 30)',
          },
          since: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_budgets',
      description:
        'Get all budgets with current spending progress. Use for: "How are my budgets?", "Am I over budget?", "Show my budget status".\nReturns: { budgets: Array<{ name: string; amount: number; spent: number; remaining: number; percent_used: number; period: string; status: string }> }',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_goals',
      description:
        'Get savings goals with progress. Use for: "How are my goals?", "Savings progress", "Am I on track for my goals?".\nReturns: { goals: Array<{ name: string; target: number; current: number; progress_percent: number; target_date: string | null; status: string }> }',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_health',
      description:
        'Get financial health score and pillar breakdown. Use for: "What\'s my financial health?", "How am I doing financially?", "Health score".\nReturns: { score: number | null; label: string | null; pillars: { spend: number; save: number; borrow: number; build: number } | null }',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_spending',
      description:
        'Get spending breakdown by category over a period. Use for: "Where does my money go?", "Spending by category", "Top spending categories".\nReturns: { spending: Array<{ category: string; total: number; count: number }>; period: { start: string; end: string } }',
      inputSchema: {
        type: 'object' as const,
        properties: {
          months: {
            type: 'number',
            description: 'Number of months to analyze (default: 6, max: 24)',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'run_analysis',
      description:
        `Run JavaScript code that calls warm.* functions for complex multi-step analysis. Use when a query requires combining data from multiple tools, custom calculations, or comparisons that would take 3+ tool calls.\n\nAvailable API:\n${generateApiTypeString()}\n\nUse console.log() to output results. Example:\nconst [accounts, txns] = await Promise.all([warm.getAccounts(), warm.getTransactions({ since: "2024-01-01" })]);\nconst total = txns.txns.reduce((s, t) => s + t.a, 0);\nconsole.log(JSON.stringify({ accounts: accounts.accounts.length, totalSpent: total }));`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Use warm.* functions and console.log() for output.',
          },
        },
        required: ['code'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'verify_key',
      description: 'Check if API key is valid and working.\nReturns: { valid: boolean; user_id: string }',
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
    // Handle run_analysis separately (sandbox execution)
    if (name === 'run_analysis') {
      const code = args?.code ? String(args.code) : '';
      if (!code) {
        throw new Error('Code parameter is required');
      }

      const callApi = async (tool: string, params: Record<string, unknown>): Promise<unknown> => {
        const handler = toolHandlers[tool];
        if (!handler) {
          throw new Error(`Unknown tool: ${tool}`);
        }
        return handler(params);
      };

      const result = await executeSandboxedCode(code, callApi);
      const text = result.error
        ? `Output:\n${result.output}\n\nError: ${result.error}`
        : result.output;

      return {
        content: [{ type: 'text', text }],
        isError: !!result.error,
      };
    }

    // Standard tool dispatch
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
