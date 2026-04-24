export const WARM_TOOL_NAMES = [
  'get_accounts',
  'get_transactions',
  'get_financial_state',
  'verify_key',
] as const;

export type WarmToolName = (typeof WARM_TOOL_NAMES)[number];

export type {
  GetAccountsOutput,
  GetTransactionsInput,
  GetTransactionsOutput,
  VerifyKeyOutput,
  WarmApiAccount,
  WarmApiBudget,
  WarmApiClient,
  WarmApiClientOptions,
  WarmApiGoal,
  WarmApiHolding,
  WarmApiLiability,
  WarmApiTransaction,
  WarmFinancialState,
} from './warm-api-client.js';
export type { WarmServerOptions } from './server.js';
