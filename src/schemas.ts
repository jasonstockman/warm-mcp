import * as z from 'zod/v4';

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date in YYYY-MM-DD format.');

const dateTimeSchema = z.string().datetime({ offset: true });

export const emptyInputSchema = z.object({}).strict().default({});

export const accountTypeSchema = z.enum([
  'depository',
  'credit',
  'loan',
  'investment',
  'other',
]);

export const accountSchema = z
  .object({
    account_id: z.string().nullable(),
    name: z.string(),
    type: accountTypeSchema,
    subtype: z.string().nullable(),
    balance: z.number().finite(),
    available_balance: z.number().finite().nullable(),
    institution: z.string().nullable(),
    mask: z.string().nullable(),
  })
  .strict();

export const getAccountsOutputSchema = z
  .object({
    accounts: z.array(accountSchema),
  })
  .strict();

const getTransactionsInputObjectSchema = z
  .object({
    limit: z
      .int()
      .min(1)
      .max(1000)
      .default(500)
      .describe('Maximum transactions to return in this page (default 500, max 1000).'),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe('Opaque pagination cursor from a previous get_transactions response.'),
    last_knowledge: dateTimeSchema
      .optional()
      .describe(
        'Incremental sync checkpoint from a prior get_transactions response. Cannot be combined with cursor.'
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cursor && value.last_knowledge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: '`cursor` cannot be combined with `last_knowledge`.',
      });
    }
  });

export const getTransactionsInputSchema = getTransactionsInputObjectSchema;

export const transactionSchema = z
  .object({
    id: z.string().nullable(),
    account_id: z.string().nullable(),
    date: dateSchema.nullable(),
    amount: z.number().finite(),
    merchant: z.string().nullable(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    detailed_category: z.string().nullable(),
  })
  .strict();

export const getTransactionsOutputSchema = z
  .object({
    generated_at: dateTimeSchema.nullable(),
    next_knowledge: dateTimeSchema.nullable(),
    txns: z.array(transactionSchema),
    pagination: z
      .object({
        limit: z.int().min(1).max(1000),
        next_cursor: z.string().nullable(),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    date: dateSchema,
    net_worth: z.number().finite(),
    total_assets: z.number().finite(),
    total_liabilities: z.number().finite(),
  })
  .strict();

export const recurringSchema = z
  .object({
    merchant: z.string(),
    amount: z.number().finite(),
    frequency: z.string(),
    next_date: dateSchema.nullable(),
    type: z.string().nullable(),
    active: z.boolean(),
  })
  .strict();

export const budgetSchema = z
  .object({
    name: z.string(),
    amount: z.number().finite(),
    spent: z.number().finite(),
    remaining: z.number().finite(),
    percent_used: z.number().finite(),
    period: z.string(),
    status: z.string().nullable(),
  })
  .strict();

export const goalSchema = z
  .object({
    name: z.string(),
    target: z.number().finite(),
    current: z.number().finite(),
    progress_percent: z.number().finite(),
    target_date: dateSchema.nullable(),
    status: z.string().nullable(),
    category: z.string().nullable(),
    monthly_contribution_needed: z.number().finite().nullable(),
  })
  .strict();

export const healthPillarsSchema = z
  .object({
    spend: z.number().finite().nullable(),
    save: z.number().finite().nullable(),
    borrow: z.number().finite().nullable(),
    build: z.number().finite().nullable(),
  })
  .strict();

export const liabilitySchema = z
  .object({
    account_id: z.string(),
    type: z.string(),
    balance: z.number().finite().nullable(),
    apr_percentage: z.number().finite().nullable(),
    minimum_payment: z.number().finite().nullable(),
    next_payment_due_date: dateSchema.nullable(),
    is_overdue: z.boolean().nullable(),
  })
  .strict();

export const holdingSchema = z
  .object({
    account_id: z.string(),
    security_name: z.string().nullable(),
    symbol: z.string().nullable(),
    type: z.string().nullable(),
    quantity: z.number().finite(),
    value: z.number().finite().nullable(),
    cost_basis: z.number().finite().nullable(),
  })
  .strict();

export const categorySpendingSchema = z
  .object({
    category: z.string(),
    amount: z.number().finite(),
  })
  .strict();

export const financialHealthSchema = z
  .object({
    score: z.number().finite().nullable(),
    label: z.string().nullable(),
    data_completeness: z.number().finite().nullable(),
    pillars: healthPillarsSchema.nullable(),
    message: z.string().nullable(),
  })
  .strict();

export const getFinancialStateOutputSchema = z
  .object({
    generated_at: dateTimeSchema,
    snapshots: z.array(snapshotSchema),
    recurring: z.array(recurringSchema),
    budgets: z.array(budgetSchema),
    goals: z.array(goalSchema),
    health: financialHealthSchema,
    liabilities: z.array(liabilitySchema),
    holdings: z.array(holdingSchema),
    category_spending: z.array(categorySpendingSchema),
  })
  .strict();

export const getStateInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        'GraphQL-like selection string over accounts and financial_state. Example: { accounts { account_id name balance } financial_state { health { score label } recurring { merchant amount next_date } } }'
      ),
  })
  .strict();

export const getStateOutputSchema = z
  .object({
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export const verifyKeyOutputSchema = z
  .object({
    valid: z.boolean(),
    status: z.string(),
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;
export type FinancialHealth = z.infer<typeof financialHealthSchema>;
export type GetAccountsOutput = z.infer<typeof getAccountsOutputSchema>;
export type GetFinancialStateOutput = z.infer<typeof getFinancialStateOutputSchema>;
export type GetStateInput = z.infer<typeof getStateInputSchema>;
export type GetStateOutput = z.infer<typeof getStateOutputSchema>;
export type GetTransactionsInput = z.infer<typeof getTransactionsInputSchema>;
export type GetTransactionsOutput = z.infer<typeof getTransactionsOutputSchema>;
export type VerifyKeyOutput = z.infer<typeof verifyKeyOutputSchema>;
