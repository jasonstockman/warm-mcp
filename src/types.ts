import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type {
  GetAccountsOutput,
  GetFinancialStateOutput,
  GetTransactionsInput,
  GetTransactionsOutput,
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
  getFinancialState(): Promise<GetFinancialStateOutput>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
  verifyKey(): Promise<VerifyKeyOutput>;
}

export interface WarmApiAccount {
  account_id?: string | null;
  name?: string | null;
  type?: string | null;
  subtype?: string | null;
  current_balance?: number | null;
  available_balance?: number | null;
  institution_name?: string | null;
  mask?: string | null;
}

export interface WarmApiAccountsResponse {
  accounts?: WarmApiAccount[];
  generated_at?: string;
}

export interface WarmApiTransaction {
  id?: string | null;
  account_id?: string | null;
  date?: string | null;
  amount?: number | null;
  merchant_name?: string | null;
  name?: string | null;
  primary_category?: string | null;
  detailed_category?: string | null;
}

export interface WarmApiTransactionsResponse {
  generated_at?: string;
  next_knowledge?: string;
  transactions?: WarmApiTransaction[];
  pagination?: {
    limit?: number | null;
    next_cursor?: string | null;
  };
}

export interface WarmApiSnapshot {
  snapshot_date?: string | null;
  period_end?: string | null;
  net_worth?: number | null;
  total_assets?: number | null;
  total_liabilities?: number | null;
  total_cash?: number | null;
  investment_value?: number | null;
  asset_value?: number | null;
  total_debt?: number | null;
  liability_value?: number | null;
}

export interface WarmApiSnapshotsResponse {
  snapshots?: WarmApiSnapshot[];
  generated_at?: string;
}

export interface WarmApiRecurring {
  average_amount?: number | null;
  description?: string | null;
  frequency?: string | null;
  is_active?: boolean | null;
  last_amount?: number | null;
  merchant_name?: string | null;
  next_date?: string | null;
  stream_type?: string | null;
}

export interface WarmApiRecurringResponse {
  recurring_transactions?: WarmApiRecurring[];
  generated_at?: string;
}

export interface WarmApiBudget {
  amount?: number | null;
  name?: string | null;
  period?: string | null;
  percent_used?: number | null;
  remaining?: number | null;
  spent?: number | null;
  status?: string | null;
}

export interface WarmApiBudgetsResponse {
  budgets?: WarmApiBudget[];
  generated_at?: string;
}

export interface WarmApiGoal {
  category?: string | null;
  current?: number | null;
  monthly_contribution_needed?: number | null;
  name?: string | null;
  progress_percent?: number | null;
  status?: string | null;
  target?: number | null;
  target_date?: string | null;
}

export interface WarmApiGoalsResponse {
  goals?: WarmApiGoal[];
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

export interface WarmApiLiability {
  account_id?: string | null;
  type?: string | null;
  balance?: number | null;
  apr_percentage?: number | null;
  interest_rate_percentage?: number | null;
  interest_rate_type?: string | null;
  minimum_payment?: number | null;
  next_payment_due_date?: string | null;
  expected_payoff_date?: string | null;
  origination_principal_amount?: number | null;
  is_overdue?: boolean | null;
}

export interface WarmApiLiabilitiesResponse {
  liabilities?: WarmApiLiability[];
  generated_at?: string;
}

export interface WarmApiHolding {
  account_id?: string | null;
  security_name?: string | null;
  symbol?: string | null;
  type?: string | null;
  quantity?: number | null;
  value?: number | null;
  cost_basis?: number | null;
}

export interface WarmApiHoldingsResponse {
  holdings?: WarmApiHolding[];
  generated_at?: string;
}

export interface WarmApiVerifyResponse {
  valid?: boolean;
  status?: string;
  error?: string;
}
