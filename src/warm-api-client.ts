import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';
import {
  API_ORIGIN,
  apiEndpointManifest,
} from '@warmio/contracts/api';
import {
  WARM_MCP_CREDENTIALS,
  WARM_MCP_INSTALLER_COMMANDS,
  type PrivateMcpMode,
} from '@warmio/contracts/mcp';
import type {
  AutomationInput,
  AutomationOperation,
  FinancialContext,
  FinancialContextAccount,
  FinancialContextBudget,
  FinancialContextGoal,
  FinancialContextHealth,
  FinancialContextHolding,
  FinancialContextLiability,
  FinancialContextMeta,
  FinancialContextPosition,
  FinancialContextRecurring,
  FinancialContextSnapshot,
  FinancialContextStatus,
  FinancialContextTransaction,
  FinancialContextTransactionIndex,
  LatestTransactions,
  TransactionMonth,
} from '@warmio/contracts/types';

export type {
  AutomationInput,
  AutomationOperation,
  FinancialContext,
  FinancialContextMeta,
  LatestTransactions,
  TransactionMonth,
} from '@warmio/contracts/types';

export interface WarmApiClientOptions {
  audience?: PrivateMcpMode;
  apiKeyResolver?: () => string | null;
  apiUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export type Account = FinancialContextAccount;
export type Budget = FinancialContextBudget;
export type Goal = FinancialContextGoal;
export type Health = FinancialContextHealth;
export type Holding = FinancialContextHolding;
export type Liability = FinancialContextLiability;
export type Position = FinancialContextPosition;
export type Recurring = FinancialContextRecurring;
export type Snapshot = FinancialContextSnapshot;
export type Status = FinancialContextStatus;
export type Transaction = FinancialContextTransaction;
export type TransactionIndex = FinancialContextTransactionIndex;
export type GetTransactionsInput =
  | { month: string; latest?: never }
  | { latest: true; month?: never };
export type GetTransactionsOutput = TransactionMonth | LatestTransactions;

export interface VerifyKeyOutput extends Record<string, unknown> {
  audience?: 'automation' | 'context' | 'oauth';
  status: string;
  valid: boolean;
}

export type AutomationOperationDescription = AutomationOperation & {
  input_schema: Record<string, unknown>;
};

export interface DescribeOperationOutput extends Record<string, unknown> {
  approval?: {
    approval_url: string;
    expires_at: string;
    id: string;
    status: string;
  };
  operation: AutomationOperationDescription;
}

export interface InvokeOperationOutput extends Record<string, unknown> {
  body: unknown;
  headers: Record<string, string>;
  operation_id: string;
  status: number;
}

export interface WarmApiClient {
  getFinancialContext(): Promise<FinancialContext>;
  getFinancialContextMeta(): Promise<FinancialContextMeta>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
  searchOperations(query?: string): Promise<{ operations: AutomationOperation[] }>;
  describeOperation(operationId: string, input?: AutomationInput): Promise<DescribeOperationOutput>;
  invokeOperation(
    operationId: string,
    input?: AutomationInput,
    approvalId?: string
  ): Promise<InvokeOperationOutput>;
  validateAudience(): Promise<VerifyKeyOutput>;
  verifyKey(): Promise<VerifyKeyOutput>;
}

interface WarmApiVerifyResponse {
  audience?: 'automation' | 'context' | 'oauth';
  status?: string;
  valid?: boolean;
}

const DEFAULT_API_URL = process.env.WARM_API_URL || API_ORIGIN;
const DEFAULT_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WARM_API_TIMEOUT_MS || 10_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();
const cachedApiKeys = new Map<PrivateMcpMode, string | null>();

const endpointByOperationId = Object.fromEntries(
  apiEndpointManifest.map((endpoint) => [endpoint.operation_id, endpoint])
) as Record<(typeof apiEndpointManifest)[number]['operation_id'], (typeof apiEndpointManifest)[number]>;

function getEndpointPath(
  operationId: keyof typeof endpointByOperationId,
  audience: PrivateMcpMode
): string {
  const endpoint = endpointByOperationId[operationId];
  if (endpoint.audience !== audience) {
    throw new Error(`API operation ${operationId} is not available to ${audience}.`);
  }
  return endpoint.path;
}

function getRequestSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

function createWarmApiClientConfig(options: WarmApiClientOptions) {
  return {
    audience: options.audience || 'context',
    apiKeyResolver: options.apiKeyResolver,
    apiUrl: options.apiUrl || DEFAULT_API_URL,
    fetchImplementation: options.fetchImplementation || fetch,
    requestTimeoutMs: options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export function getConfiguredApiKey(audience: PrivateMcpMode = 'context'): string | null {
  if (cachedApiKeys.has(audience)) {
    return cachedApiKeys.get(audience) ?? null;
  }

  const environmentKey = WARM_MCP_CREDENTIALS[audience].apiKeyEnv;
  const apiKey = process.env[environmentKey]?.trim() || readConfigFile(getWarmApiKeyPath(audience));
  cachedApiKeys.set(audience, apiKey);
  return apiKey;
}

export function resetConfiguredApiKeyCache(): void {
  cachedApiKeys.clear();
}

interface WarmApiResponse<TBody> {
  body: TBody;
  headers: Record<string, string>;
  status: number;
}

export class WarmApiError extends Error {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly status: number;

  constructor(message: string, response: WarmApiResponse<unknown>) {
    super(message);
    this.name = 'WarmApiError';
    this.body = response.body;
    this.headers = response.headers;
    this.status = response.status;
  }
}

interface WarmApiRequest {
  body?: Record<string, unknown>;
  endpoint: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
}

function toWarmApiError(response: WarmApiResponse<unknown>): WarmApiError {
  const errorMessages: Record<number, string> = {
    401: 'Invalid or expired API key. Regenerate at https://warm.io/settings',
    403: 'API access is available on paid plans only. Upgrade at https://warm.io/settings',
    429: 'Rate limit exceeded. Try again in a few minutes.',
  };
  if (errorMessages[response.status]) {
    return new WarmApiError(errorMessages[response.status], response);
  }

  const detail =
    typeof response.body === 'object' && response.body !== null && 'error' in response.body
      ? String((response.body as { error: unknown }).error)
      : `HTTP ${response.status}`;
  return new WarmApiError(detail, response);
}

async function requestWarmApi<TResponse>(
  request: WarmApiRequest,
  options: WarmApiClientOptions
): Promise<WarmApiResponse<TResponse>> {
  const requestOptions = createWarmApiClientConfig(options);
  const apiKey = requestOptions.apiKeyResolver?.() ?? getConfiguredApiKey(requestOptions.audience);

  if (!apiKey) {
    throw new Error(
      `No ${requestOptions.audience} API key configured. Run "${WARM_MCP_INSTALLER_COMMANDS[requestOptions.audience]}" or set ${WARM_MCP_CREDENTIALS[requestOptions.audience].apiKeyEnv}.`
    );
  }

  const url = new URL(request.endpoint, requestOptions.apiUrl);
  Object.entries(request.query || {}).forEach(([key, value]) => {
    if (value) {
      url.searchParams.append(key, value);
    }
  });

  let response: Response;
  try {
    response = await requestOptions.fetchImplementation(url.toString(), {
      ...(request.method && request.method !== 'GET' ? { method: request.method } : {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(request.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: getRequestSignal(requestOptions.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Warm API timed out after ${requestOptions.requestTimeoutMs}ms`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Warm API request aborted after ${requestOptions.requestTimeoutMs}ms`);
    }
    throw error;
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    body: body as TResponse,
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
}

async function requestSuccessfulJson<TResponse>(
  request: WarmApiRequest,
  options: WarmApiClientOptions
): Promise<TResponse> {
  const response = await requestWarmApi<TResponse>(request, options);
  if (response.status >= 400) {
    throw toWarmApiError(response);
  }
  return response.body;
}

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  const getFinancialContext = async (): Promise<FinancialContext> =>
    await requestSuccessfulJson<FinancialContext>(
      { endpoint: getEndpointPath('getFinancialContext', 'context') },
      options
    );

  const getFinancialContextMeta = async (): Promise<FinancialContextMeta> =>
    await requestSuccessfulJson<FinancialContextMeta>(
      { endpoint: getEndpointPath('getFinancialContextMeta', 'context') },
      options
    );

  const getTransactions = async (input: GetTransactionsInput): Promise<GetTransactionsOutput> => {
    const rawInput = input as { latest?: unknown; month?: unknown };
    if (typeof rawInput.month === 'string' && rawInput.latest !== undefined) {
      throw new Error('`month` and `latest` are mutually exclusive.');
    }
    if (typeof rawInput.month === 'string') {
      return await requestSuccessfulJson<GetTransactionsOutput>(
        {
          endpoint: getEndpointPath('getFinancialContextTransactions', 'context'),
          query: { month: rawInput.month },
        },
        options
      );
    }
    if (rawInput.latest === true) {
      return await requestSuccessfulJson<GetTransactionsOutput>(
        {
          endpoint: getEndpointPath('getFinancialContextTransactions', 'context'),
          query: { latest: '1' },
        },
        options
      );
    }

    throw new Error('Call getTransactions with `month` in YYYY-MM format or `latest: true`.');
  };

  const verifyKey = async (): Promise<VerifyKeyOutput> => {
    const response = await requestSuccessfulJson<WarmApiVerifyResponse>(
      { endpoint: getEndpointPath('verifyApiAccess', 'context') },
      options
    );
    return {
      audience: response.audience,
      status: response.status || (response.valid ? 'ok' : 'invalid'),
      valid: response.valid === true,
    };
  };

  const validateAudience = async (): Promise<VerifyKeyOutput> => {
    const result = await verifyKey();
    const expectedAudience = createWarmApiClientConfig(options).audience;
    if (!result.valid || result.audience !== expectedAudience) {
      const article = expectedAudience === 'automation' ? 'an' : 'a';
      throw new Error(
        `This MCP mode requires ${article} ${expectedAudience} API key. Run "${WARM_MCP_INSTALLER_COMMANDS[expectedAudience]}" to configure a separate key.`
      );
    }
    return result;
  };

  const searchOperations = async (query?: string) =>
    await requestSuccessfulJson<{ operations: AutomationOperation[] }>(
      {
        body: query ? { query } : {},
        endpoint: getEndpointPath('searchOperations', 'automation'),
        method: 'POST',
      },
      options
    );

  const describeOperation = async (operationId: string, input?: AutomationInput) =>
    await requestSuccessfulJson<DescribeOperationOutput>(
      {
        body: { operation_id: operationId, ...(input ? { input } : {}) },
        endpoint: getEndpointPath('describeOperation', 'automation'),
        method: 'POST',
      },
      options
    );

  const invokeOperation = async (
    operationId: string,
    input?: AutomationInput,
    approvalId?: string
  ): Promise<InvokeOperationOutput> =>
    await requestSuccessfulJson<InvokeOperationOutput>(
      {
        body: {
          operation_id: operationId,
          input: input ?? {},
          ...(approvalId ? { approval_id: approvalId } : {}),
        },
        endpoint: getEndpointPath('invokeOperation', 'automation'),
        method: 'POST',
      },
      options
    );

  return {
    getFinancialContext,
    getFinancialContextMeta,
    getTransactions,
    searchOperations,
    describeOperation,
    invokeOperation,
    validateAudience,
    verifyKey,
  };
}

export async function verifyWarmApiKey(
  apiKey: string,
  audience: PrivateMcpMode = 'context'
): Promise<VerifyKeyOutput> {
  return createWarmApiClient({
    audience,
    apiKeyResolver: () => apiKey,
  }).verifyKey();
}
