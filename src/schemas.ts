import { z } from 'zod';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date.');
const dateTimeSchema = z.string().datetime({ offset: true });

export const emptyInputSchema = {};

export const accountTypeSchema = z.enum([
  'depository',
  'credit',
  'loan',
  'investment',
  'other',
]);

export const getAccountsOutputSchema = {
  accounts: z.array(
    z
      .object({
        balance: z.number().finite(),
        institution: z.string().nullable(),
        mask: z.string().nullable(),
        name: z.string(),
        subtype: z.string().nullable(),
        type: accountTypeSchema,
      })
      .strict()
  ),
};

export const getTransactionsInputSchema = {
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('Opaque pagination cursor from a prior get_transactions response.'),
  last_knowledge: dateTimeSchema
    .optional()
    .describe('Incremental sync checkpoint. Cannot be combined with cursor.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(500)
    .describe('Maximum transactions to return (default 500, max 1000).'),
  search: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Optional merchant or description search query.'),
};

export const getTransactionsOutputSchema = {
  generated_at: dateTimeSchema.nullable(),
  next_knowledge: dateTimeSchema.nullable(),
  pagination: z
    .object({
      has_more: z.boolean(),
      limit: z.number().int().min(1).max(1000),
      next_cursor: z.string().nullable(),
    })
    .strict(),
  txns: z.array(
    z
      .object({
        amount: z.number().finite(),
        category: z.string().nullable(),
        date: dateSchema.nullable(),
        description: z.string().nullable(),
        detailed_category: z.string().nullable(),
        id: z.string().nullable(),
        merchant: z.string().nullable(),
      })
      .strict()
  ),
};

export const getFinancialStateOutputSchema = {
  budgets: z.array(
    z
      .object({
        amount: z.number().finite(),
        name: z.string(),
        percent_used: z.number().finite(),
        period: z.string(),
        remaining: z.number().finite(),
        spent: z.number().finite(),
        status: z.string().nullable(),
      })
      .strict()
  ),
  category_spending: z.array(
    z
      .object({
        amount: z.number().finite(),
        category: z.string(),
      })
      .strict()
  ),
  generated_at: dateTimeSchema,
  goals: z.array(
    z
      .object({
        category: z.string().nullable(),
        current: z.number().finite(),
        monthly_contribution_needed: z.number().finite().nullable(),
        name: z.string(),
        progress_percent: z.number().finite(),
        status: z.string().nullable(),
        target: z.number().finite(),
        target_date: dateSchema.nullable(),
      })
      .strict()
  ),
  health: z
    .object({
      data_completeness: z.number().finite().nullable(),
      label: z.string().nullable(),
      message: z.string().nullable(),
      pillars: z
        .object({
          borrow: z.number().finite().nullable(),
          build: z.number().finite().nullable(),
          save: z.number().finite().nullable(),
          spend: z.number().finite().nullable(),
        })
        .strict()
        .nullable(),
      score: z.number().finite().nullable(),
    })
    .strict(),
  holdings: z.array(
    z
      .object({
        account_id: z.string(),
        cost_basis: z.number().finite().nullable(),
        quantity: z.number().finite(),
        security_name: z.string().nullable(),
        symbol: z.string().nullable(),
        type: z.string().nullable(),
        value: z.number().finite().nullable(),
      })
      .strict()
  ),
  liabilities: z.array(
    z
      .object({
        account_id: z.string(),
        apr_percentage: z.number().finite().nullable(),
        balance: z.number().finite().nullable(),
        is_overdue: z.boolean().nullable(),
        minimum_payment: z.number().finite().nullable(),
        next_payment_due_date: dateSchema.nullable(),
        type: z.string(),
      })
      .strict()
  ),
  recurring: z.array(
    z
      .object({
        active: z.boolean(),
        amount: z.number().finite(),
        frequency: z.string(),
        merchant: z.string(),
        next_date: dateSchema.nullable(),
        type: z.string().nullable(),
      })
      .strict()
  ),
  snapshots: z.array(
    z
      .object({
        date: dateSchema,
        net_worth: z.number().finite(),
        total_assets: z.number().finite(),
        total_liabilities: z.number().finite(),
      })
      .strict()
  ),
};

export const verifyKeyOutputSchema = {
  status: z.string(),
  valid: z.boolean(),
};
