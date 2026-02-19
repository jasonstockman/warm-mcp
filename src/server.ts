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
  category?: string;
}

interface CompactTransaction {
  d: string; // date
  a: number; // amount
  m: string; // merchant
  c: string | null; // category
}

function compactTransaction(t: Transaction): CompactTransaction {
  return {
    d: t.date,
    a: t.amount,
    m: t.merchant_name || t.name || 'Unknown',
    c: t.category || null,
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

const server = new Server({ name: 'warm', version: '1.2.2' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_accounts',
      description:
        'Get all connected bank accounts with balances. Use for: "What accounts do I have?", "What is my checking balance?", "Show my credit cards". Returns: array of {name, type, balance, institution}.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_transactions',
      description:
        'Get transactions and analyze spending. Use for: "How much did I spend on coffee?", "Show my purchases", "What did I buy last month?". Returns: {summary: {total, count, avg}, txns: [{d, a, m, c}]} where d=date, a=amount, m=merchant, c=category. IMPORTANT: Do NOT pre-filter—fetch all transactions then analyze the `c` (category) field to answer category questions (coffee, dining, groceries, etc.). Category details take priority over merchant name string matching.',
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
            description: 'Max transactions to return (default: 200, max: 500)',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_recurring',
      description:
        'Get detected subscriptions and recurring payments. Use for: "What subscriptions do I have?", "Show my monthly bills", "What are my recurring charges?". Returns: {recurring: [{merchant, amount, frequency, next_date}]}.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_snapshots',
      description:
        'Get net worth history over time. Use for: "How has my net worth changed?", "Show my financial progress", "What was my balance last month?". Returns: {snapshots: [{d, nw, a, l}]} where nw=net_worth, a=assets, l=liabilities.',
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
      name: 'verify_key',
      description: 'Check if API key is valid and working.',
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
    switch (name) {
      case 'get_accounts': {
        const data = await apiRequest('/api/accounts');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'get_transactions': {
        const since = args?.since ? String(args.since) : undefined;
        const until = args?.until ? String(args.until) : undefined;
        const parsedLimit = args?.limit ? Number(args.limit) : 200;
        const requestedLimit = Number.isFinite(parsedLimit)
          ? Math.max(1, Math.min(Math.floor(parsedLimit), 500))
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

        // Apply date range filter (until is client-side since API only supports since)
        if (until) {
          transactions = transactions.filter((t) => inDateRange(t, since, until));
        }

        const compactTxns = transactions.map(compactTransaction);

        // Calculate summary on ALL matching transactions
        const summary = calculateSummary(compactTxns);

        // Apply limit for display
        const limited = compactTxns.slice(0, requestedLimit);
        const truncated = compactTxns.length > requestedLimit;

        // Build compact result
        const result: {
          summary: ReturnType<typeof calculateSummary>;
          txns: CompactTransaction[];
          more?: number;
        } = { summary, txns: limited };

        if (truncated) {
          result.more = compactTxns.length - requestedLimit;
        }

        // Size check and reduce if needed
        let output = JSON.stringify(result);
        if (output.length > MAX_RESPONSE_SIZE) {
          const reducedCount = Math.floor(limited.length * (MAX_RESPONSE_SIZE / output.length) * 0.8);
          result.txns = limited.slice(0, reducedCount);
          result.more = compactTxns.length - reducedCount;
          output = JSON.stringify(result);
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'get_recurring': {
        const response = (await apiRequest('/api/transactions', { limit: '1' })) as {
          recurring?: Array<Record<string, unknown>>;
        };
        const recurring = response.recurring || [];
        return { content: [{ type: 'text', text: JSON.stringify({ recurring }) }] };
      }

      case 'get_snapshots': {
        const response = (await apiRequest('/api/transactions', { limit: '1' })) as {
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

        // Compact output
        const result = filtered.map((s) => ({
          d: s.snapshot_date,
          nw: s.net_worth,
          a: s.total_assets,
          l: s.total_liabilities,
        }));

        return { content: [{ type: 'text', text: JSON.stringify({ granularity, snapshots: result }) }] };
      }

      case 'verify_key': {
        const data = await apiRequest('/api/verify');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
