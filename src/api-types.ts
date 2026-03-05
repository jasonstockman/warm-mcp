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

  /** Get transactions (primary tool for spending analysis). Amounts: positive = expense, negative = income. Category c: "INCOME"/"TRANSFER_IN" = income, others = expenses. */
  getTransactions(params?: {
    since?: string;   // YYYY-MM-DD inclusive
    until?: string;   // YYYY-MM-DD inclusive
  }): Promise<{
    summary: { total: number; count: number; avg: number };
    txns: Array<{ d: string; a: number; m: string; c: string | null }>;
    more?: number;
  }>;

  /** Get recurring payments and subscriptions. Amounts are positive. */
  getRecurring(): Promise<{
    recurring: Array<{ merchant: string; amount: number; frequency: string; next_date: string | null }>;
  }>;

  /** Get net worth history snapshots */
  getSnapshots(params?: {
    granularity?: "daily" | "monthly";
    limit?: number;
    since?: string;
  }): Promise<{
    granularity: string;
    snapshots: Array<{ d: string; nw: number; a: number; l: number }>;
  }>;

  /** Get budgets with spending progress */
  getBudgets(): Promise<{
    budgets: Array<{ name: string; amount: number; spent: number; remaining: number; percent_used: number; period: string; status: string }>;
  }>;

  /** Get savings goals with progress */
  getGoals(): Promise<{
    goals: Array<{ name: string; target: number; current: number; progress_percent: number; target_date: string | null; status: string }>;
  }>;

  /** Get financial health score (0-100) with pillar breakdown */
  getHealth(): Promise<{
    score: number | null;
    label: string | null;
    pillars: { spend: number; save: number; borrow: number; build: number } | null;
    data_completeness: number | null;
  }>;

  /** REQUIRES PRO — Get spending breakdown by category. Prefer getTransactions() with category filtering. */
  getSpending(params?: { months?: number }): Promise<{
    spending: Array<{ category: string; total: number; count: number }>;
    period: { start: string; end: string };
  }>;
};`;
}
