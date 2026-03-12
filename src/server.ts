/**
 * Warm MCP server worker and shared API helpers.
 *
 * This module owns the typed MCP contract and the Warm API request helpers used
 * by stdio, HTTP, and installation flows.
 */

import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import * as z from 'zod/v4';
import {
  createWarmServer as createReusableWarmServer,
  verifyWarmApiKey as verifyReusableWarmApiKey,
} from './warm-server.js';

const PACKAGE_VERSION = getPackageVersion();

export const WARM_SERVER_INFO = {
  name: 'warm',
  version: PACKAGE_VERSION,
} as const;

export const API_URL = process.env.WARM_API_URL || 'https://warm.io';

const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

type WarmAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

interface WarmApiRequestOptions {
  apiKey?: string;
}

interface ApiAccount {
  name?: string | null;
  type?: string | null;
  subtype?: string | null;
  current_balance?: number | null;
  institution_name?: string | null;
  mask?: string | null;
}

interface ApiTransaction {
  id?: string | null;
  date?: string | null;
  amount?: number | null;
  merchant_name?: string | null;
  name?: string | null;
  primary_category?: string | null;
  detailed_category?: string | null;
}

interface ApiTransactionPage {
  generated_at?: string;
  next_knowledge?: string;
  transactions?: ApiTransaction[];
  pagination?: {
    limit?: number | null;
    next_cursor?: string | null;
  };
}

interface ApiSnapshot {
  snapshot_date?: string | null;
  d?: string | null;
  net_worth?: number | null;
  nw?: number | null;
  total_assets?: number | null;
  a?: number | null;
  total_liabilities?: number | null;
  l?: number | null;
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
}

const accountOutputSchema = z.object({
  name: z.string(),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'other']),
  subtype: z.string().nullable(),
  balance: z.number(),
  institution: z.string().nullable(),
  mask: z.string().nullable(),
});

const transactionOutputSchema = z.object({
  id: z.string().nullable(),
  date: z.string().nullable(),
  amount: z.number(),
  merchant: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  detailed_category: z.string().nullable(),
});

const snapshotOutputSchema = z.object({
  date: z.string(),
  net_worth: z.number(),
  total_assets: z.number(),
  total_liabilities: z.number(),
});

const recurringOutputSchema = z.object({
  merchant: z.string(),
  amount: z.number(),
  frequency: z.string(),
  next_date: z.string().nullable(),
  type: z.string().nullable(),
  active: z.boolean(),
});

const budgetOutputSchema = z.object({
  name: z.string(),
  amount: z.number(),
  spent: z.number(),
  remaining: z.number(),
  percent_used: z.number(),
  period: z.string(),
  status: z.string().nullable(),
});

const goalOutputSchema = z.object({
  name: z.string(),
  target: z.number(),
  current: z.number(),
  progress_percent: z.number(),
  target_date: z.string().nullable(),
  status: z.string().nullable(),
  category: z.string().nullable(),
  monthly_contribution_needed: z.number().nullable(),
});

const healthPillarsOutputSchema = z.object({
  spend: z.number().nullable(),
  save: z.number().nullable(),
  borrow: z.number().nullable(),
  build: z.number().nullable(),
});

const healthOutputSchema = z.object({
  score: z.number().nullable(),
  label: z.string().nullable(),
  data_completeness: z.number().nullable(),
  pillars: healthPillarsOutputSchema.nullable(),
  message: z.string().nullable(),
});

const getAccountsOutputSchema = z.object({
  accounts: z.array(accountOutputSchema),
});

const getTransactionsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(500),
    cursor: z.string().min(1).optional(),
    last_knowledge: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const getTransactionsOutputSchema = z.object({
  generated_at: z.string().datetime({ offset: true }).nullable(),
  next_knowledge: z.string().datetime({ offset: true }).nullable(),
  txns: z.array(transactionOutputSchema),
  pagination: z.object({
    limit: z.number().int().min(1).max(1000),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  }),
});

const getFinancialStateOutputSchema = z.object({
  generated_at: z.string().datetime({ offset: true }),
  snapshots: z.array(snapshotOutputSchema),
  recurring: z.array(recurringOutputSchema),
  budgets: z.array(budgetOutputSchema),
  goals: z.array(goalOutputSchema),
  health: healthOutputSchema,
});

const verifyKeyOutputSchema = z.object({
  valid: z.boolean(),
  status: z.string(),
});

const strictEmptySchema = z.object({}).strict();
const strictEmptyAnySchema = strictEmptySchema as unknown as AnySchema;

let cachedApiKey: string | null | undefined;

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

function normalizeAccountType(value: string | null | undefined): WarmAccountType {
  switch (value) {
    case 'depository':
    case 'credit':
    case 'loan':
    case 'investment':
      return value;
    default:
      return 'other';
  }
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

function asGeneratedAt(...values: Array<string | null | undefined>): string {
  return values.find((value): value is string => Boolean(value)) || new Date().toISOString();
}

function createTextContent(data: unknown): Array<{ type: 'text'; text: string }> {
  return [
    {
      type: 'text',
      text: JSON.stringify(data),
    },
  ];
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

export async function verifyWarmApiKey(apiKey: string): Promise<z.infer<typeof verifyKeyOutputSchema>> {
  return verifyReusableWarmApiKey(apiKey);
}

async function getAccountsResult(): Promise<z.infer<typeof getAccountsOutputSchema>> {
  const response = (await apiRequest('/api/export', { dataset: 'accounts' })) as {
    accounts?: ApiAccount[];
  };

  return {
    accounts: (response.accounts || []).map((account) => ({
      name: account.name || 'Unknown Account',
      type: normalizeAccountType(account.type),
      subtype: account.subtype || null,
      balance: roundCurrency(account.current_balance ?? 0),
      institution: account.institution_name || null,
      mask: account.mask || null,
    })),
  };
}

async function getTransactionsResult(
  args: z.infer<typeof getTransactionsInputSchema>
): Promise<z.infer<typeof getTransactionsOutputSchema>> {
  const params: Record<string, string> = {
    limit: String(args.limit),
  };

  if (args.cursor) {
    params.cursor = args.cursor;
  }
  if (args.last_knowledge) {
    params.last_knowledge = args.last_knowledge;
  }

  const response = (await apiRequest('/api/transactions', params)) as ApiTransactionPage;
  const nextCursor = response.pagination?.next_cursor ?? null;
  const limit = response.pagination?.limit ?? args.limit;

  return {
    generated_at: response.generated_at || null,
    next_knowledge: response.next_knowledge || null,
    txns: (response.transactions || []).map((transaction) => ({
      id: transaction.id || null,
      date: transaction.date || null,
      amount: roundCurrency(transaction.amount ?? 0),
      merchant: transaction.merchant_name || null,
      description: transaction.name || null,
      category: transaction.primary_category ?? null,
      detailed_category: transaction.detailed_category ?? null,
    })),
    pagination: {
      limit,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
    },
  };
}

async function getFinancialStateResult(): Promise<z.infer<typeof getFinancialStateOutputSchema>> {
  const [snapshotsResponse, recurringResponse, budgetsResponse, goalsResponse, healthResponse] =
    (await Promise.all([
      apiRequest('/api/export', { dataset: 'snapshots' }),
      apiRequest('/api/export', { dataset: 'recurring' }),
      apiRequest('/api/export', { dataset: 'budgets' }),
      apiRequest('/api/export', { dataset: 'goals' }),
      apiRequest('/api/export', { dataset: 'health' }),
    ])) as [
      { generated_at?: string; snapshots?: ApiSnapshot[] },
      { generated_at?: string; recurring_transactions?: ApiRecurring[] },
      { generated_at?: string; budgets?: ApiBudget[] },
      { generated_at?: string; goals?: ApiGoal[] },
      ApiHealth & { generated_at?: string }
    ];

  return {
    generated_at: asGeneratedAt(
      snapshotsResponse.generated_at,
      recurringResponse.generated_at,
      budgetsResponse.generated_at,
      goalsResponse.generated_at,
      healthResponse.generated_at
    ),
    snapshots: (snapshotsResponse.snapshots || [])
      .map((snapshot) => ({
        date: snapshot.snapshot_date || snapshot.d || '',
        net_worth: roundCurrency(snapshot.net_worth ?? snapshot.nw ?? 0),
        total_assets: roundCurrency(snapshot.total_assets ?? snapshot.a ?? 0),
        total_liabilities: roundCurrency(snapshot.total_liabilities ?? snapshot.l ?? 0),
      }))
      .filter((snapshot) => snapshot.date.length > 0),
    recurring: (recurringResponse.recurring_transactions || []).map((stream) => ({
      merchant: stream.merchant_name || stream.description || 'Unknown',
      amount: roundCurrency(Math.abs(stream.average_amount ?? stream.last_amount ?? 0)),
      frequency: stream.frequency || 'UNKNOWN',
      next_date: stream.next_date || null,
      type: stream.stream_type || null,
      active: stream.is_active !== false,
    })),
    budgets: (budgetsResponse.budgets || []).map((budget) => ({
      name: budget.name || 'Unnamed Budget',
      amount: roundCurrency(budget.amount ?? 0),
      spent: roundCurrency(budget.spent ?? 0),
      remaining: roundCurrency(budget.remaining ?? 0),
      percent_used: roundCurrency(budget.percent_used ?? 0),
      period: budget.period || 'monthly',
      status: budget.status || null,
    })),
    goals: (goalsResponse.goals || []).map((goal) => ({
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
    health: {
      score: healthResponse.score ?? null,
      label: healthResponse.label || null,
      data_completeness: healthResponse.data_completeness ?? null,
      pillars: healthResponse.pillars
        ? {
            spend: healthResponse.pillars.spend ?? null,
            save: healthResponse.pillars.save ?? null,
            borrow: healthResponse.pillars.borrow ?? null,
            build: healthResponse.pillars.build ?? null,
          }
        : null,
      message: healthResponse.message || null,
    },
  };
}

async function getVerifyKeyResult(): Promise<z.infer<typeof verifyKeyOutputSchema>> {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  return verifyWarmApiKey(apiKey);
}

export function createWarmServer(): McpServer {
  return createReusableWarmServer({
    serverInfo: WARM_SERVER_INFO,
  });
}

export async function startStdioServer(): Promise<McpServer> {
  const server = createWarmServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
