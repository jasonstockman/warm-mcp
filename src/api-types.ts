/**
 * TypeScript API type definitions for MCP code mode.
 * Embedded in the run_analysis tool description so the LLM
 * knows the shape of each warm.* function.
 *
 * All monetary amounts are positive (normalized).
 */

export function generateApiTypeString(): string {
  return `declare const warm: {
  /** Get all connected bank accounts with balances */
  getAccounts(): Promise<{
    accounts: Array<{ name: string; type: string; balance: number; institution: string }>;
  }>;

  /** Get transactions with pagination. Amounts: positive = expense, negative = income. Category c: "INCOME"/"TRANSFER_IN" = income, others = expenses. Summary covers full date range; txns are paginated. */
  getTransactions(params?: {
    since?: string;   // YYYY-MM-DD inclusive
    until?: string;   // YYYY-MM-DD inclusive
    limit?: number;   // max per page (default 200, max 500)
    offset?: number;  // skip N transactions (default 0)
  }): Promise<{
    summary: { total: number; count: number; avg: number };
    txns: Array<{ d: string; a: number; m: string; c: string | null }>;
    total: number;
    has_more: boolean;
  }>;

  /** Get daily net worth history */
  getSnapshots(params?: {
    limit?: number;
    since?: string;
  }): Promise<{
    snapshots: Array<{ d: string; nw: number; a: number; l: number }>;
  }>;
};`;
}
