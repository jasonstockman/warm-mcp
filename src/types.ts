export const WARM_TOOL_NAMES = [
  'get_financial_context',
  'get_transactions',
  'verify_key',
] as const;

export type WarmToolName = (typeof WARM_TOOL_NAMES)[number];

export type {
  Account,
  Budget,
  FinancialContext,
  FinancialContextMeta,
  GetTransactionsInput,
  GetTransactionsOutput,
  Goal,
  Health,
  Holding,
  LatestTransactions,
  Liability,
  Position,
  Recurring,
  Snapshot,
  Status,
  Transaction,
  TransactionIndex,
  TransactionMonth,
  VerifyKeyOutput,
  WarmApiClient,
  WarmApiClientOptions,
} from './warm-api-client.js';
export type { WarmServerOptions } from './server.js';
