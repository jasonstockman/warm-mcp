/**
 * TypeScript API type definitions for MCP code mode.
 * Embedded in the run_analysis tool description so the LLM
 * knows the shape of each warm.* function.
 */

export function generateApiTypeString(): string {
  return `declare const warm: {
  /** Get all connected bank accounts with balances. Returns: { accounts: Array<{ name: string; type: string; balance: number; institution: string }> } */
  getAccounts(): Promise<{ accounts: Array<{ name: string; type: string; balance: number; institution: string }> }>;

  /** Get transactions with optional date filtering. Returns: { summary: { total: number; count: number; avg: number }, txns: Array<{ d: string; a: number; m: string; c: string | null }> } */
  getTransactions(params?: { since?: string; until?: string; limit?: number }): Promise<{ summary: { total: number; count: number; avg: number }; txns: Array<{ d: string; a: number; m: string; c: string | null }> }>;

  /** Get recurring payments and subscriptions. Returns: { recurring: Array<{ merchant: string; amount: number; frequency: string; next_date: string | null }> } */
  getRecurring(): Promise<{ recurring: Array<{ merchant: string; amount: number; frequency: string; next_date: string | null }> }>;

  /** Get net worth history snapshots. Returns: { snapshots: Array<{ d: string; nw: number; a: number; l: number }> } */
  getSnapshots(params?: { granularity?: "daily" | "monthly"; limit?: number; since?: string }): Promise<{ snapshots: Array<{ d: string; nw: number; a: number; l: number }> }>;

  /** Get budgets with spending progress. Returns: { budgets: Array<{ name: string; amount: number; spent: number; remaining: number; percent_used: number; period: string; status: string }> } */
  getBudgets(): Promise<{ budgets: Array<{ name: string; amount: number; spent: number; remaining: number; percent_used: number; period: string; status: string }> }>;

  /** Get savings goals with progress. Returns: { goals: Array<{ name: string; target: number; current: number; progress_percent: number; target_date: string | null; status: string }> } */
  getGoals(): Promise<{ goals: Array<{ name: string; target: number; current: number; progress_percent: number; target_date: string | null; status: string }> }>;

  /** Get financial health score. Returns: { score: number | null; label: string | null; pillars: { spend: number; save: number; borrow: number; build: number } | null } */
  getHealth(): Promise<{ score: number | null; label: string | null; pillars: { spend: number; save: number; borrow: number; build: number } | null }>;

  /** Get spending breakdown by category. Returns: { spending: Array<{ category: string; total: number; count: number }>, period: { start: string; end: string } } */
  getSpending(params?: { months?: number }): Promise<{ spending: Array<{ category: string; total: number; count: number }>; period: { start: string; end: string } }>;
};`;
}
