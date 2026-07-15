import { privateMcpToolDefinitions } from '@warmio/contracts/mcp';

export const WARM_CONTEXT_TOOL_NAMES = privateMcpToolDefinitions
  .filter((tool) => tool.mode === 'context')
  .map((tool) => tool.name);

export const WARM_AUTOMATION_TOOL_NAMES = privateMcpToolDefinitions
  .filter((tool) => tool.mode === 'automation')
  .map((tool) => tool.name);

export const WARM_TOOL_NAMES = privateMcpToolDefinitions.map((tool) => tool.name);

export type WarmToolName = (typeof privateMcpToolDefinitions)[number]['name'];

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
export type { PrivateMcpMode } from '@warmio/contracts/mcp';
export type { WarmServerOptions } from './server.js';
