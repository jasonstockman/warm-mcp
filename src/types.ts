export const WARM_CONTEXT_TOOL_NAMES = [
  'get_financial_context',
  'get_transactions',
  'verify_key',
] as const;

export const WARM_AUTOMATION_TOOL_NAMES = [
  'search_operations',
  'describe_operation',
  'invoke_operation',
] as const;

export const WARM_TOOL_NAMES = [...WARM_CONTEXT_TOOL_NAMES, ...WARM_AUTOMATION_TOOL_NAMES] as const;

export type WarmToolName = (typeof WARM_TOOL_NAMES)[number];

export type {
  Account,
  AutomationInput,
  AutomationOperation,
  AutomationOperationDescription,
  Budget,
  DescribeOperationOutput,
  FinancialContext,
  FinancialContextMeta,
  GetTransactionsInput,
  GetTransactionsOutput,
  Goal,
  Health,
  Holding,
  InvokeOperationOutput,
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
export type { WarmApiAudience } from './config-paths.js';
export type { WarmServerOptions } from './server.js';
