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

function matchesSearch(t: Transaction, search: string): boolean {
  const s = search.toLowerCase();
  const merchant = (t.merchant_name || t.name || '').toLowerCase();
  const category = (t.category || '').toLowerCase();
  return merchant.includes(s) || category.includes(s);
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
  if (process.env.WARM_API_KEY) {
    return process.env.WARM_API_KEY;
  }
  const configPath = path.join(os.homedir(), '.config', 'warm', 'api_key');
  try {
    return fs.readFileSync(configPath, 'utf-8').trim();
  } catch {
    return null;
  }
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

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

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

const server = new Server({ name: 'warm', version: '1.2.0' }, { capabilities: { tools: {} } });

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
        'Search and analyze transactions. Use for: "How much did I spend on X?", "Show my Amazon purchases", "What did I buy last month?". Returns: {summary: {total, count, avg}, txns: [{d, a, m, c}]} where d=date, a=amount, m=merchant, c=category.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          search: {
            type: 'string',
            description: 'Filter by merchant or category (e.g., "coffee", "amazon", "groceries")',
          },
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
            description: 'Max transactions (default: 50, max: 200)',
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
        const search = args?.search ? String(args.search) : undefined;
        const since = args?.since ? String(args.since) : undefined;
        const until = args?.until ? String(args.until) : undefined;
        const requestedLimit = args?.limit ? Math.min(Number(args.limit), 200) : 50;

        // Fetch more if filtering, since we'll reduce the set
        const fetchLimit = search || until ? Math.min(requestedLimit * 10, 1000) : requestedLimit;

        const params: Record<string, string> = { limit: String(fetchLimit) };
        if (since) params.last_knowledge = since;

        const response = (await apiRequest('/api/transactions', params)) as {
          transactions?: Transaction[];
          cursor?: string;
        };

        let transactions = (response.transactions || []) as Transaction[];

        // Apply date range filter (until is client-side since API only supports since)
        if (until) {
          transactions = transactions.filter((t) => inDateRange(t, since, until));
        }

        // Apply search filter
        if (search) {
          transactions = transactions.filter((t) => matchesSearch(t, search));
        }

        // Convert to compact format
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
