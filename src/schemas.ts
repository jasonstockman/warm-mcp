import * as z from 'zod/v4';

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date in YYYY-MM-DD format.');

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
    name: z.string(),
    type: accountTypeSchema,
    balance: z.number().finite(),
    institution: z.string().nullable(),
  })
  .strict();

export const getAccountsOutputSchema = z
  .object({
    accounts: z.array(accountSchema),
  })
  .strict();

const getTransactionsInputObjectSchema = z
  .object({
    since: dateSchema
      .optional()
      .describe('Start date inclusive (YYYY-MM-DD). Omit for the oldest available data.'),
    until: dateSchema
      .optional()
      .describe('End date inclusive (YYYY-MM-DD). Omit for the newest available data.'),
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
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.since && value.until && value.since > value.until) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['since'],
        message: '`since` must be on or before `until`.',
      });
    }
  });

export const getTransactionsInputSchema = getTransactionsInputObjectSchema.default({
  limit: 500,
});

export const compactTransactionSchema = z
  .object({
    d: dateSchema,
    a: z.number().finite(),
    m: z.string(),
    c: z.string().nullable(),
  })
  .strict();

export const transactionSummaryKindSchema = z.enum([
  'matching_range',
  'partial_matching_range',
]);

export const transactionSummarySchema = z
  .object({
    total: z.number().finite(),
    count: z.int().nonnegative(),
    avg: z.number().finite(),
    kind: transactionSummaryKindSchema,
    incomplete_reason: z.enum(['scan_limit_reached']).nullable(),
  })
  .strict();

export const getTransactionsOutputSchema = z
  .object({
    query: z
      .object({
        since: dateSchema.nullable(),
        until: dateSchema.nullable(),
        limit: z.int().min(1).max(1000),
      })
      .strict(),
    summary: transactionSummarySchema,
    txns: z.array(compactTransactionSchema),
    page: z
      .object({
        returned: z.int().nonnegative(),
        has_more: z.boolean(),
        next_cursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const financialPositionSchema = z
  .object({
    as_of: dateSchema.nullable(),
    net_worth: z.number().finite().nullable(),
    total_assets: z.number().finite().nullable(),
    total_liabilities: z.number().finite().nullable(),
  })
  .strict();

export const healthLabelSchema = z.enum([
  'Critical',
  'Urgent',
  'Needs Attention',
  'Good',
  'Strong',
]);

export const healthPillarsSchema = z
  .object({
    spend: z.number().finite(),
    save: z.number().finite(),
    borrow: z.number().finite(),
    build: z.number().finite(),
  })
  .strict();

export const financialHealthSchema = z
  .object({
    score: z.number().int().min(0).max(100).nullable(),
    label: healthLabelSchema.nullable(),
    data_completeness: z.number().min(0).max(100).nullable(),
    pillars: healthPillarsSchema.nullable(),
    message: z.string().nullable(),
  })
  .strict();

export const getFinancialStateOutputSchema = z
  .object({
    current: financialPositionSchema,
    previous: financialPositionSchema.nullable(),
    health: financialHealthSchema,
  })
  .strict();

export const verifyKeyOutputSchema = z
  .object({
    valid: z.boolean(),
    status: z.string(),
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;
export type CompactTransaction = z.infer<typeof compactTransactionSchema>;
export type FinancialHealth = z.infer<typeof financialHealthSchema>;
export type FinancialPosition = z.infer<typeof financialPositionSchema>;
export type GetAccountsOutput = z.infer<typeof getAccountsOutputSchema>;
export type GetFinancialStateOutput = z.infer<typeof getFinancialStateOutputSchema>;
export type GetTransactionsInput = z.infer<typeof getTransactionsInputSchema>;
export type GetTransactionsOutput = z.infer<typeof getTransactionsOutputSchema>;
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;
export type VerifyKeyOutput = z.infer<typeof verifyKeyOutputSchema>;
