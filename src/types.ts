import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type {
  GetAccountsOutput,
  GetFinancialStateOutput,
  GetTransactionsInput,
  GetTransactionsOutput,
  TransactionSummary,
  VerifyKeyOutput,
} from './schemas.js';

export const WARM_TOOL_NAMES = [
  'get_accounts',
  'get_transactions',
  'get_financial_state',
  'verify_key',
] as const;

export type WarmToolName = (typeof WARM_TOOL_NAMES)[number];

export interface WarmApiClientOptions {
  apiUrl?: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  apiKeyResolver?: () => string | null;
}

export interface WarmServerOptions extends WarmApiClientOptions {
  serverInfo?: Implementation;
}

export type WarmToolRegistrationTarget = McpServer;

export type RegisteredWarmTools = Record<WarmToolName, RegisteredTool>;

export interface WarmApiClient {
  getAccounts(): Promise<GetAccountsOutput>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
  getFinancialState(): Promise<GetFinancialStateOutput>;
  verifyKey(): Promise<VerifyKeyOutput>;
}

export interface WarmApiAccount {
  name?: string | null;
  type?: string | null;
  current_balance?: number | null;
  institution_name?: string | null;
}

export interface WarmApiAccountsResponse {
  accounts?: WarmApiAccount[];
  generated_at?: string;
}

export interface WarmApiTransaction {
  id?: string | null;
  date?: string | null;
  amount?: number | null;
  merchant_name?: string | null;
  name?: string | null;
  primary_category?: string | null;
}

export interface WarmApiTransactionsResponse {
  transactions?: WarmApiTransaction[];
  pagination?: {
    next_cursor?: string | null;
  };
}

export interface WarmApiSnapshot {
  snapshot_date?: string | null;
  date?: string | null;
  d?: string | null;
  net_worth?: number | null;
  nw?: number | null;
  total_assets?: number | null;
  a?: number | null;
  total_liabilities?: number | null;
  l?: number | null;
}

export interface WarmApiSnapshotsResponse {
  snapshots?: WarmApiSnapshot[];
  generated_at?: string;
}

export interface WarmApiHealthResponse {
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

export interface WarmApiVerifyResponse {
  valid?: boolean;
  status?: string;
  error?: string;
}

export interface TransactionCursorPosition {
  date: string;
  id: string;
}

export interface WarmTransactionCursorPayload {
  v: 1;
  since: string | null;
  until: string | null;
  last: TransactionCursorPosition;
}

export interface NormalizedTransaction {
  id: string;
  date: string;
  amount: number;
  merchant: string;
  category: string | null;
}

export interface TransactionSummaryCacheEntry {
  expiresAt: number;
  summary: TransactionSummary;
}
