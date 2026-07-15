export {
  automationInputSchema,
  financialContextAccountSchema as accountSchema,
  financialContextMetaSchema,
  financialContextSchema,
  financialContextTransactionSchema as transactionSchema,
  latestTransactionsSchema,
  transactionMonthSchema,
} from '@warmio/contracts/schemas';

export {
  describeOperationMcpInputShape as describeOperationInputSchema,
  emptyMcpInputShape as emptyInputSchema,
  getTransactionsMcpInputShape as getTransactionsInputSchema,
  invokeOperationMcpInputShape as invokeOperationInputSchema,
  searchOperationsMcpInputShape as searchOperationsInputSchema,
} from '@warmio/contracts/mcp';
