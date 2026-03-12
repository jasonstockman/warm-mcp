import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  emptyInputSchema,
  getAccountsOutputSchema,
  getFinancialStateOutputSchema,
  getTransactionsInputSchema,
  getTransactionsOutputSchema,
  verifyKeyOutputSchema,
  type Account,
  type FinancialPosition,
  type GetAccountsOutput,
  type GetFinancialStateOutput,
  type GetTransactionsInput,
  type GetTransactionsOutput,
  type TransactionSummary,
  type VerifyKeyOutput,
} from './schemas.js';
import type {
  NormalizedTransaction,
  RegisteredWarmTools,
  TransactionCursorPosition,
  TransactionSummaryCacheEntry,
  WarmApiAccount,
  WarmApiAccountsResponse,
  WarmApiClient,
  WarmApiClientOptions,
  WarmApiHealthResponse,
  WarmApiSnapshot,
  WarmApiSnapshotsResponse,
  WarmApiTransaction,
  WarmApiTransactionsResponse,
  WarmApiVerifyResponse,
  WarmServerOptions,
  WarmToolRegistrationTarget,
  WarmTransactionCursorPayload,
} from './types.js';

const DEFAULT_API_URL = process.env.WARM_API_URL || 'https://warm.io';
const DEFAULT_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

const TRANSACTION_API_PAGE_SIZE = 500;
const SUMMARY_CACHE_TTL_MS = 600_000;
const SUMMARY_SCAN_PAGE_LIMIT = 40;
const SUMMARY_SCAN_TRANSACTION_LIMIT = 20_000;
const CURSOR_VERSION = 1 as const;
const HEALTH_LABELS = new Set([
  'Critical',
  'Urgent',
  'Needs Attention',
  'Good',
  'Strong',
]);

export const WARM_SERVER_INFO = {
  name: 'warm',
  version: '3.0.3',
} as const;

const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

let cachedApiKey: string | null | undefined;
const transactionSummaryCache = new Map<string, TransactionSummaryCacheEntry>();

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
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

function normalizeAccountType(rawType: string | null | undefined): Account['type'] {
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

function normalizeAccount(account: WarmApiAccount): Account {
  return {
    name: account.name || 'Unknown Account',
    type: normalizeAccountType(account.type),
    balance: roundMoney(account.current_balance ?? 0),
    institution: account.institution_name ?? null,
  };
}

function normalizeTransaction(row: WarmApiTransaction): NormalizedTransaction | null {
  if (!row.id || !row.date) {
    return null;
  }

  return {
    id: row.id,
    date: row.date,
    amount: roundMoney(row.amount ?? 0),
    merchant: row.merchant_name || row.name || 'Unknown',
    category: row.primary_category ?? null,
  };
}

function toCompactTransaction(row: NormalizedTransaction): GetTransactionsOutput['txns'][number] {
  return {
    d: row.date,
    a: row.amount,
    m: row.merchant,
    c: row.category,
  };
}

function normalizePosition(snapshot: WarmApiSnapshot | null | undefined): FinancialPosition {
  const asOf = snapshot?.snapshot_date || snapshot?.date || snapshot?.d || null;
  const netWorth = snapshot?.net_worth ?? snapshot?.nw ?? null;
  const totalAssets = snapshot?.total_assets ?? snapshot?.a ?? null;
  const totalLiabilities = snapshot?.total_liabilities ?? snapshot?.l ?? null;

  return {
    as_of: asOf,
    net_worth: netWorth == null ? null : roundMoney(netWorth),
    total_assets: totalAssets == null ? null : roundMoney(totalAssets),
    total_liabilities: totalLiabilities == null ? null : roundMoney(totalLiabilities),
  };
}

function encodeApiCursor(position: TransactionCursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf-8').toString('base64url');
}

function encodeOpaqueTransactionCursor(
  last: TransactionCursorPosition,
  since: string | null,
  until: string | null
): string {
  const payload: WarmTransactionCursorPayload = {
    v: CURSOR_VERSION,
    since,
    until,
    last,
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeOpaqueTransactionCursor(
  rawCursor: string,
  since: string | null,
  until: string | null
): TransactionCursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf-8'));
  } catch {
    throw new Error('Invalid cursor. Use the opaque cursor returned by get_transactions.');
  }

  const payload = parsed as Partial<WarmTransactionCursorPayload>;
  if (
    payload?.v !== CURSOR_VERSION ||
    payload.since !== since ||
    payload.until !== until ||
    !payload.last?.date ||
    !payload.last?.id
  ) {
    throw new Error(
      'Cursor does not match the requested filters. Re-run get_transactions without a cursor.'
    );
  }

  return payload.last;
}

function getSummaryCacheKey(since: string | null, until: string | null): string {
  return `${since || ''}|${until || ''}`;
}

function createWarmApiClientConfig(options: WarmApiClientOptions) {
  return {
    apiUrl: options.apiUrl || DEFAULT_API_URL,
    fetchImplementation: options.fetchImplementation || fetch,
    requestTimeoutMs: options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    apiKeyResolver: options.apiKeyResolver,
  };
}

async function apiRequest<TResponse>(
  endpoint: string,
  params: Record<string, string | undefined>,
  options: ReturnType<typeof createWarmApiClientConfig>
): Promise<TResponse> {
  const apiKey = options.apiKeyResolver?.() ?? getApiKey();
  if (!apiKey) {
    throw new Error('WARM_API_KEY not set. Run "npx @warmio/mcp" to configure.');
  }

  const url = new URL(endpoint, options.apiUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.append(key, value);
    }
  });

  let response: Response;
  try {
    response = await options.fetchImplementation(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: getRequestSignal(options.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Warm API timed out after ${options.requestTimeoutMs}ms`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Warm API request aborted after ${options.requestTimeoutMs}ms`);
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
      // Ignore response parse failures and use the HTTP status.
    }

    throw new Error(detail);
  }

  return (await response.json()) as TResponse;
}

function createStructuredToolResult<TStructured extends Record<string, unknown>>(
  structuredContent: TStructured
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

async function fetchTransactionsBatch(
  cursor: string | undefined,
  requestOptions: ReturnType<typeof createWarmApiClientConfig>
): Promise<WarmApiTransactionsResponse> {
  return apiRequest<WarmApiTransactionsResponse>(
    '/api/transactions',
    {
      limit: String(TRANSACTION_API_PAGE_SIZE),
      cursor,
    },
    requestOptions
  );
}

function buildTransactionSummary(
  total: number,
  count: number,
  complete: boolean
): TransactionSummary {
  return {
    total: roundMoney(total),
    count,
    avg: count > 0 ? roundMoney(total / count) : 0,
    kind: complete ? 'matching_range' : 'partial_matching_range',
    incomplete_reason: complete ? null : 'scan_limit_reached',
  };
}

function normalizeHealthLabel(
  label: string | null | undefined
): GetFinancialStateOutput['health']['label'] {
  if (label && HEALTH_LABELS.has(label)) {
    return label as GetFinancialStateOutput['health']['label'];
  }
  return null;
}

function sortSnapshotsNewestFirst(a: WarmApiSnapshot, b: WarmApiSnapshot): number {
  const aDate = a.snapshot_date || a.date || a.d || '';
  const bDate = b.snapshot_date || b.date || b.d || '';
  return bDate.localeCompare(aDate);
}

async function getTransactionsSummary(
  since: string | null,
  until: string | null,
  requestOptions: ReturnType<typeof createWarmApiClientConfig>
): Promise<TransactionSummary> {
  const cacheKey = getSummaryCacheKey(since, until);
  const cached = transactionSummaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  let nextApiCursor: string | undefined;
  let pagesScanned = 0;
  let transactionsScanned = 0;
  let total = 0;
  let count = 0;
  let complete = true;

  while (true) {
    if (
      pagesScanned >= SUMMARY_SCAN_PAGE_LIMIT ||
      transactionsScanned >= SUMMARY_SCAN_TRANSACTION_LIMIT
    ) {
      complete = false;
      break;
    }

    const response = await fetchTransactionsBatch(nextApiCursor, requestOptions);
    const batch = response.transactions || [];

    if (batch.length === 0) {
      break;
    }

    pagesScanned += 1;
    transactionsScanned += batch.length;

    let reachedSinceBoundary = false;
    for (const rawRow of batch) {
      const row = normalizeTransaction(rawRow);
      if (!row) {
        continue;
      }

      if (until && row.date > until) {
        continue;
      }

      if (since && row.date < since) {
        reachedSinceBoundary = true;
        break;
      }

      total += row.amount;
      count += 1;
    }

    if (reachedSinceBoundary || !response.pagination?.next_cursor) {
      break;
    }

    nextApiCursor = response.pagination.next_cursor;
  }

  const summary = buildTransactionSummary(total, count, complete);
  transactionSummaryCache.set(cacheKey, {
    summary,
    expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
  });

  return summary;
}

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  const requestOptions = createWarmApiClientConfig(options);

  async function getAccounts(): Promise<GetAccountsOutput> {
    const response = await apiRequest<WarmApiAccountsResponse>(
      '/api/export',
      { dataset: 'accounts' },
      requestOptions
    );

    return {
      accounts: (response.accounts || []).map(normalizeAccount),
    };
  }

  async function getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput> {
    const since = input.since ?? null;
    const until = input.until ?? null;
    const apiCursor = input.cursor
      ? encodeApiCursor(decodeOpaqueTransactionCursor(input.cursor, since, until))
      : undefined;

    let nextApiCursor = apiCursor;
    const matches: NormalizedTransaction[] = [];

    while (matches.length < input.limit) {
      const response = await fetchTransactionsBatch(nextApiCursor, requestOptions);
      const batch = response.transactions || [];

      if (batch.length === 0) {
        break;
      }

      let reachedSinceBoundary = false;
      for (let index = 0; index < batch.length; index += 1) {
        const row = normalizeTransaction(batch[index]);
        if (!row) {
          continue;
        }

        if (until && row.date > until) {
          continue;
        }

        if (since && row.date < since) {
          reachedSinceBoundary = true;
          break;
        }

        matches.push(row);

        if (matches.length === input.limit) {
          const last = matches[matches.length - 1];
          let hasMoreInBatch = false;
          let reachedSinceBoundaryInBatch = false;

          for (let tailIndex = index + 1; tailIndex < batch.length; tailIndex += 1) {
            const tailRow = normalizeTransaction(batch[tailIndex]);
            if (!tailRow) {
              continue;
            }

            if (until && tailRow.date > until) {
              continue;
            }

            if (since && tailRow.date < since) {
              reachedSinceBoundaryInBatch = true;
              break;
            }

            hasMoreInBatch = true;
            break;
          }

          const hasMore =
            hasMoreInBatch ||
            (!reachedSinceBoundaryInBatch && Boolean(response.pagination?.next_cursor));

          return {
            query: {
              since,
              until,
              limit: input.limit,
            },
            summary: await getTransactionsSummary(since, until, requestOptions),
            txns: matches.map(toCompactTransaction),
            page: {
              returned: matches.length,
              has_more: hasMore,
              next_cursor: hasMore
                ? encodeOpaqueTransactionCursor(
                    { date: last.date, id: last.id },
                    since,
                    until
                  )
                : null,
            },
          };
        }
      }

      if (reachedSinceBoundary || !response.pagination?.next_cursor) {
        break;
      }

      nextApiCursor = response.pagination.next_cursor;
    }

    return {
      query: {
        since,
        until,
        limit: input.limit,
      },
      summary: await getTransactionsSummary(since, until, requestOptions),
      txns: matches.map(toCompactTransaction),
      page: {
        returned: matches.length,
        has_more: false,
        next_cursor: null,
      },
    };
  }

  async function getFinancialState(): Promise<GetFinancialStateOutput> {
    const [snapshotResponse, healthResponse] = await Promise.all([
      apiRequest<WarmApiSnapshotsResponse>(
        '/api/export',
        { dataset: 'snapshots' },
        requestOptions
      ),
      apiRequest<WarmApiHealthResponse>('/api/export', { dataset: 'health' }, requestOptions),
    ]);

    const snapshots = [...(snapshotResponse.snapshots || [])].sort(sortSnapshotsNewestFirst);
    const previousSnapshot = snapshots[1];

    return {
      current: normalizePosition(snapshots[0]),
      previous: previousSnapshot ? normalizePosition(previousSnapshot) : null,
      health: {
        score:
          typeof healthResponse.score === 'number' ? Math.round(healthResponse.score) : null,
        label: normalizeHealthLabel(healthResponse.label),
        data_completeness:
          typeof healthResponse.data_completeness === 'number'
            ? roundMoney(healthResponse.data_completeness)
            : null,
        pillars: healthResponse.pillars
          ? {
              spend: roundMoney(healthResponse.pillars.spend ?? 0),
              save: roundMoney(healthResponse.pillars.save ?? 0),
              borrow: roundMoney(healthResponse.pillars.borrow ?? 0),
              build: roundMoney(healthResponse.pillars.build ?? 0),
            }
          : null,
        message: healthResponse.message ?? null,
      },
    };
  }

  async function verifyKey(): Promise<VerifyKeyOutput> {
    const response = await apiRequest<WarmApiVerifyResponse>('/api/verify', {}, requestOptions);
    return {
      valid: response.valid === true,
      status: response.status || (response.valid ? 'ok' : 'invalid'),
    };
  }

  return {
    getAccounts,
    getTransactions,
    getFinancialState,
    verifyKey,
  };
}

export function registerWarmTools(
  server: WarmToolRegistrationTarget,
  options: WarmApiClientOptions = {}
): RegisteredWarmTools {
  const client = createWarmApiClient(options);

  return {
    get_accounts: server.registerTool(
      'get_accounts',
      {
        description:
          'Read-only list of connected financial accounts with current balances and institutions.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: getAccountsOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.getAccounts())
    ),
    get_transactions: server.registerTool(
      'get_transactions',
      {
        description:
          'Read-only transaction query with transaction-date filters and opaque cursor pagination. `summary.kind` is `matching_range` when exact. If it is `partial_matching_range`, the server hit a scan limit while summarizing the full matching range and the model should narrow the date window.',
        inputSchema: getTransactionsInputSchema as unknown as AnySchema,
        outputSchema: getTransactionsOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async (args: GetTransactionsInput) =>
        createStructuredToolResult(await client.getTransactions(args))
    ),
    get_financial_state: server.registerTool(
      'get_financial_state',
      {
        description:
          'Read-only overview of current financial state from the latest net-worth snapshots plus the exported financial health score.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: getFinancialStateOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.getFinancialState())
    ),
    verify_key: server.registerTool(
      'verify_key',
      {
        description: 'Read-only API key validation for the configured Warm account.',
        inputSchema: emptyInputSchema as unknown as AnySchema,
        outputSchema: verifyKeyOutputSchema as unknown as AnySchema,
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async () => createStructuredToolResult(await client.verifyKey())
    ),
  };
}

export function createWarmServer(options: WarmServerOptions = {}): McpServer {
  const server = new McpServer(options.serverInfo || WARM_SERVER_INFO);
  registerWarmTools(server, options);
  return server;
}

export async function verifyWarmApiKey(apiKey: string): Promise<VerifyKeyOutput> {
  const client = createWarmApiClient({
    apiKeyResolver: () => apiKey,
  });

  return client.verifyKey();
}
