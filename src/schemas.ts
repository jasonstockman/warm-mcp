import { z } from 'zod';

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM month.');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date.');
const dateTimeSchema = z.string().datetime({ offset: true });

export const emptyInputSchema = {};

export const automationInputSchema = z
  .object({
    body: z.record(z.unknown()).optional(),
    params: z.record(z.string()).optional(),
  })
  .strict();

export const searchOperationsInputSchema = {
  query: z.string().max(200).optional().describe('Words describing the action or data you need.'),
};

export const describeOperationInputSchema = {
  operation_id: z.string().min(1),
  input: automationInputSchema
    .optional()
    .describe('Exact intended input. Required to obtain approval for a write operation.'),
};

export const invokeOperationInputSchema = {
  operation_id: z.string().min(1),
  input: automationInputSchema.optional(),
  approval_id: z
    .string()
    .uuid()
    .optional()
    .describe('Approval ID returned by describe_operation for the exact write input.'),
};

export const transactionIndexSchema = z
  .object({
    total: z.number().int().nonnegative(),
    months: z.array(
      z
        .object({
          month: monthSchema,
          count: z.number().int().nonnegative(),
        })
        .strict()
    ),
  })
  .strict();

export const positionSchema = z
  .object({
    date: dateSchema.nullable(),
    net_worth: z.number().finite().nullable(),
    cash: z.number().finite().nullable(),
    debt: z.number().finite().nullable(),
    investments: z.number().finite().nullable(),
    other_assets: z.number().finite().nullable(),
    total_assets: z.number().finite().nullable(),
  })
  .strict();

export const accountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['depository', 'credit', 'loan', 'investment', 'brokerage', 'other']),
    subtype: z.string().nullable(),
    group: z.enum(['cash', 'debt', 'investments']).nullable(),
    institution: z.string().nullable(),
    mask: z.string().nullable(),
    balance: z.number().finite().nullable(),
    available: z.number().finite().nullable(),
    currency: z.string().nullable(),
    updated_at: dateTimeSchema.nullable(),
  })
  .strict();

export const statusSchema = z
  .object({
    position: positionSchema.nullable(),
    accounts: z.array(accountSchema),
  })
  .strict();

export const recurringSchema = z
  .object({
    id: z.string(),
    account_id: z.string().nullable(),
    direction: z.enum(['inflow', 'outflow']).nullable(),
    frequency: z
      .enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY'])
      .nullable(),
    status: z.enum(['active', 'inactive', 'dismissed']).nullable(),
    merchant: z.string().nullable(),
    amount: z.number().finite().nullable(),
    next_date: dateSchema.nullable(),
  })
  .strict();

export const budgetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['category', 'merchant']),
    period: z.enum(['weekly', 'biweekly', 'monthly']),
    status: z.enum(['under', 'warning', 'over']),
    amount: z.number().finite(),
    spent: z.number().finite(),
    remaining: z.number().finite(),
    used_percent: z.number().finite(),
  })
  .strict();

export const goalSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
    status: z.enum(['not_started', 'in_progress', 'on_track', 'behind', 'completed']),
    target: z.number().finite(),
    current: z.number().finite(),
    progress_percent: z.number().finite(),
    target_date: dateSchema.nullable(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    date: dateSchema,
    net_worth: z.number().finite().nullable(),
    cash: z.number().finite().nullable(),
    debt: z.number().finite().nullable(),
    income: z.number().finite().nullable(),
    expenses: z.number().finite().nullable(),
    cash_flow: z.number().finite().nullable(),
    savings_rate: z.number().finite().nullable(),
    investments: z.number().finite().nullable(),
    assets: z.number().finite().nullable(),
    health_score: z.number().finite().nullable(),
  })
  .strict();

export const liabilitySchema = z
  .object({
    account_id: z.string().nullable(),
    type: z.enum(['credit', 'student', 'mortgage', 'other']).nullable(),
    balance: z.number().finite().nullable(),
    minimum_payment: z.number().finite().nullable(),
    due_date: dateSchema.nullable(),
    interest_rate: z.number().finite().nullable(),
    rate_type: z.enum(['fixed', 'variable']).nullable(),
    overdue: z.boolean().nullable(),
  })
  .strict();

export const holdingSchema = z
  .object({
    account_id: z.string().nullable(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    type: z
      .enum(['cash', 'derivative', 'equity', 'etf', 'fixed_income', 'mutual_fund', 'other'])
      .nullable(),
    quantity: z.number().finite().nullable(),
    value: z.number().finite().nullable(),
    cost_basis: z.number().finite().nullable(),
  })
  .strict();

export const healthSchema = z
  .object({
    score: z.number().finite(),
    label: z.enum(['Needs Attention', 'Good', 'Strong']),
    level: z.enum(['critical', 'poor', 'fair', 'good', 'strong']),
    summary: z.string(),
    data_completeness: z.number().finite(),
    pillars: z
      .object({
        spend: z.number().finite().nullable(),
        save: z.number().finite().nullable(),
        borrow: z.number().finite().nullable(),
        build: z.number().finite().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const financialContextSchema = z
  .object({
    version: z.literal('v1'),
    updated_at: dateTimeSchema,
    currency: z.literal('USD'),
    status: statusSchema,
    transactions: transactionIndexSchema,
    recurring: z.array(recurringSchema),
    budgets: z.array(budgetSchema),
    goals: z.array(goalSchema),
    snapshots: z.array(snapshotSchema),
    liabilities: z.array(liabilitySchema),
    holdings: z.array(holdingSchema),
    health: healthSchema.nullable(),
  })
  .strict();

export const transactionSchema = z
  .object({
    id: z.string(),
    account_id: z.string().nullable(),
    date: dateSchema.nullable(),
    amount: z.number().finite(),
    merchant: z.string().nullable(),
    name: z.string().nullable(),
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
    pending: z.boolean().nullable(),
    currency: z.string().nullable(),
  })
  .strict();

export const transactionMonthSchema = z
  .object({
    month: monthSchema,
    start_date: dateSchema,
    end_date: dateSchema,
    count: z.number().int().nonnegative(),
    items: z.array(transactionSchema),
  })
  .strict();

export const latestTransactionsSchema = z
  .object({
    since: dateSchema,
    window_days: z.literal(10),
    count: z.number().int().nonnegative(),
    items: z.array(transactionSchema),
  })
  .strict();

export const getTransactionsInputSchema = {
  month: monthSchema
    .optional()
    .describe(
      'Transaction month in YYYY-MM format. Mutually exclusive with latest. Months outside the covered range return an error.'
    ),
  latest: z
    .boolean()
    .optional()
    .describe(
      'When true, return the fixed 10-day latest window. Mutually exclusive with month. A bare call with no arguments defaults to latest: true.'
    ),
};

export const financialContextMetaSchema = z
  .object({
    version: z.literal('v1'),
    user_id: z.string(),
    context_id: z.string(),
    generated_at: dateTimeSchema,
    updated_at: dateTimeSchema,
    content_hash: z.string(),
    byte_length: z.number().int().nonnegative(),
    counts: z
      .object({
        accounts: z.number().int().nonnegative(),
        transaction_months: z.number().int().nonnegative(),
        transactions: z.number().int().nonnegative(),
        snapshots: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const verifyKeyOutputSchema = {
  status: z.string(),
  valid: z.boolean(),
};
