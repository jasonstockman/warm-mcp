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

const server = new Server({ name: 'warm', version: '1.0.3' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_accounts',
      description:
        'Get all connected bank accounts with balances. Returns account names, types, balances, and institutions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description: 'Filter accounts updated since this date (ISO format)',
          },
        },
      },
    },
    {
      name: 'get_transactions',
      description:
        'Get transactions from connected accounts. Supports pagination and date filtering.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of transactions to return (default: 100)',
          },
          since: {
            type: 'string',
            description: 'Get transactions since this date (ISO format, e.g., 2024-01-01)',
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor for fetching more results',
          },
        },
      },
    },
    {
      name: 'get_recurring',
      description: 'Get recurring payments and subscriptions detected from transaction history.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description: 'Filter recurring items detected since this date',
          },
        },
      },
    },
    {
      name: 'get_snapshots',
      description: 'Get net worth snapshots over time (daily or monthly aggregation).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          granularity: {
            type: 'string',
            enum: ['daily', 'monthly'],
            description: 'Aggregation level (default: daily)',
          },
          limit: {
            type: 'number',
            description: 'Number of snapshots to return',
          },
          since: {
            type: 'string',
            description: 'Start date for snapshots (ISO format)',
          },
        },
      },
    },
    {
      name: 'verify_key',
      description: 'Check if the Warm API key is valid and working.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_accounts': {
        const params: Record<string, string> = {};
        if (args?.since) params.since = String(args.since);
        const data = await apiRequest('/api/accounts', params);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_transactions': {
        const params: Record<string, string> = {};
        if (args?.limit) params.limit = String(args.limit);
        if (args?.since) params.last_knowledge = String(args.since);
        if (args?.cursor) params.cursor = String(args.cursor);
        const data = await apiRequest('/api/transactions', params);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_recurring': {
        const params: Record<string, string> = {};
        if (args?.since) params.since = String(args.since);
        const data = await apiRequest('/api/recurring', params);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_snapshots': {
        const response = (await apiRequest('/api/transactions', {
          limit: '1',
        })) as { snapshots?: Array<Record<string, unknown>> };
        const snapshots = response.snapshots || [];

        const granularity = (args?.granularity as string) || 'daily';
        const limit = args?.limit ? Number(args.limit) : granularity === 'daily' ? 100 : 0;
        const since = args?.since as string | undefined;

        let filtered = snapshots;
        if (since) {
          filtered = filtered.filter((s) => String(s.snapshot_date) >= since);
        }

        if (granularity === 'monthly') {
          const byMonth = new Map<string, Record<string, unknown>>();
          filtered.forEach((s) => {
            const month = String(s.snapshot_date).substring(0, 7);
            if (
              !byMonth.has(month) ||
              String(s.snapshot_date) > String(byMonth.get(month)!.snapshot_date)
            ) {
              byMonth.set(month, s);
            }
          });
          filtered = Array.from(byMonth.values());
        }

        filtered.sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)));
        if (limit > 0) {
          filtered = filtered.slice(0, limit);
        }

        const result = {
          granularity,
          snapshots: filtered.map((s) => ({
            date: s.snapshot_date,
            ...(granularity === 'monthly' && {
              month: String(s.snapshot_date).substring(0, 7),
            }),
            net_worth: s.net_worth,
            total_assets: s.total_assets,
            total_liabilities: s.total_liabilities,
          })),
        };

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'verify_key': {
        const data = await apiRequest('/api/verify');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
