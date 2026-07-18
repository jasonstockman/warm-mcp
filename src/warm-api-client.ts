import { API_ORIGIN, apiEndpointManifest } from '@warmio/contracts/api';
import { WARM_MCP_CREDENTIALS, WARM_MCP_INSTALLER_COMMAND } from '@warmio/contracts/mcp';
import type {
  AutomationInput,
  AutomationOperation,
  FinancialContext,
  FinancialContextMeta,
  LatestTransactions,
  TransactionMonth,
} from '@warmio/contracts/types';
import { getWarmApiKeyPath, readConfigFile } from './config-paths.js';

export type {
  AutomationInput,
  AutomationOperation,
  FinancialContext,
  FinancialContextMeta,
  LatestTransactions,
  TransactionMonth,
} from '@warmio/contracts/types';

export interface WarmApiClientOptions {
  apiKeyResolver?: () => string | null;
  apiUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface ReadOnlyWarmApiClientOptions extends Omit<WarmApiClientOptions, 'apiKeyResolver'> {
  accessTokenResolver: () => string | null;
}

export type GetTransactionsInput =
  | { month: string; latest?: never }
  | { latest: true; month?: never };
export type GetTransactionsOutput = TransactionMonth | LatestTransactions;
export type AutomationOperationDescription = AutomationOperation & {
  input_schema: Record<string, unknown>;
};
export interface DescribeOperationOutput {
  approval?: {
    approval_url: string;
    expires_at: string;
    id: string;
    status: string;
  };
  operation: AutomationOperationDescription;
}
export interface InvokeOperationOutput {
  body: unknown;
  headers: Record<string, string>;
  operation_id: string;
  status: number;
}
export interface ReadOnlyWarmApiClient {
  getFinancialContext(): Promise<FinancialContext>;
  getFinancialContextMeta(): Promise<FinancialContextMeta>;
  getTransactions(input: GetTransactionsInput): Promise<GetTransactionsOutput>;
}
export interface WarmApiClient extends ReadOnlyWarmApiClient {
  searchOperations(query?: string): Promise<{ operations: AutomationOperation[] }>;
  describeOperation(operationId: string, input?: AutomationInput): Promise<DescribeOperationOutput>;
  invokeOperation(
    operationId: string,
    input?: AutomationInput,
    approvalId?: string
  ): Promise<InvokeOperationOutput>;
}

export const API_URL = process.env.WARM_API_URL || API_ORIGIN;
const DEFAULT_TIMEOUT_MS = Number(process.env.WARM_API_TIMEOUT_MS || 10_000) || 10_000;
const endpointByOperationId = Object.fromEntries(
  apiEndpointManifest.map((endpoint) => [endpoint.operation_id, endpoint.path])
) as Record<(typeof apiEndpointManifest)[number]['operation_id'], string>;
let cachedApiKey: string | null | undefined;

export function getConfiguredApiKey(): string | null {
  if (cachedApiKey !== undefined) return cachedApiKey;
  cachedApiKey =
    process.env[WARM_MCP_CREDENTIALS.apiKeyEnv]?.trim() || readConfigFile(getWarmApiKeyPath());
  return cachedApiKey || null;
}

export function resetConfiguredApiKeyCache(): void {
  cachedApiKey = undefined;
}

interface WarmApiResponse<TBody> {
  body: TBody;
  headers: Record<string, string>;
  status: number;
}

export class WarmApiError extends Error {
  constructor(
    message: string,
    readonly response: WarmApiResponse<unknown>
  ) {
    super(message);
    this.name = 'WarmApiError';
  }

  get body(): unknown {
    return this.response.body;
  }
  get headers(): Record<string, string> {
    return this.response.headers;
  }
  get status(): number {
    return this.response.status;
  }
}

type AuthorizationResolver = () => string | null;
type WarmApiRequest = {
  body?: Record<string, unknown>;
  endpoint: string;
  method?: 'POST';
  query?: Record<string, string | undefined>;
};

function requestSignal(timeoutMs: number): AbortSignal {
  return typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : new AbortController().signal;
}

function errorFromResponse(response: WarmApiResponse<unknown>): WarmApiError {
  const knownMessages: Record<number, string> = {
    401: 'Invalid API key. Regenerate it in Warm Settings.',
    403: 'API access is available on paid plans only.',
    429: 'Rate limit exceeded. Try again in a few minutes.',
  };
  const bodyError =
    typeof response.body === 'object' &&
    response.body !== null &&
    'error' in response.body &&
    typeof (response.body as { error?: unknown }).error === 'string'
      ? (response.body as { error: string }).error
      : undefined;
  return new WarmApiError(
    knownMessages[response.status] || bodyError || `Request failed with status ${response.status}`,
    response
  );
}

function createRequest(
  authorizationResolver: AuthorizationResolver,
  options: Omit<WarmApiClientOptions, 'apiKeyResolver'>
): <TResponse>(input: WarmApiRequest) => Promise<TResponse> {
  const apiUrl = options.apiUrl || API_URL;
  const fetchImplementation = options.fetchImplementation || fetch;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_TIMEOUT_MS;

  return async <TResponse>(input: WarmApiRequest): Promise<TResponse> => {
    const token = authorizationResolver();
    if (!token)
      throw new Error(
        `No Warm API key configured. Run \"${WARM_MCP_INSTALLER_COMMAND}\" or set ${WARM_MCP_CREDENTIALS.apiKeyEnv}.`
      );
    const url = new URL(input.endpoint, apiUrl);
    for (const [key, value] of Object.entries(input.query || {}))
      if (value) url.searchParams.set(key, value);
    const response = await fetchImplementation(url, {
      ...(input.method ? { method: input.method } : {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: requestSignal(requestTimeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const apiResponse = {
      body,
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    };
    if (!response.ok) throw errorFromResponse(apiResponse);
    return body as TResponse;
  };
}

function createReadOnlyClient(
  request: <TResponse>(input: WarmApiRequest) => Promise<TResponse>
): ReadOnlyWarmApiClient {
  return {
    getFinancialContext: () => request({ endpoint: endpointByOperationId.getFinancialContext }),
    getFinancialContextMeta: () =>
      request({ endpoint: endpointByOperationId.getFinancialContextMeta }),
    getTransactions: (input) => {
      if ('month' in input)
        return request({
          endpoint: endpointByOperationId.getFinancialContextTransactions,
          query: { month: input.month },
        });
      return request({
        endpoint: endpointByOperationId.getFinancialContextTransactions,
        query: { latest: '1' },
      });
    },
  };
}

function createClient(
  authorizationResolver: AuthorizationResolver,
  options: Omit<WarmApiClientOptions, 'apiKeyResolver'>
): WarmApiClient {
  const request = createRequest(authorizationResolver, options);
  return {
    ...createReadOnlyClient(request),
    searchOperations: (query) =>
      request({
        endpoint: endpointByOperationId.searchOperations,
        method: 'POST',
        body: query ? { query } : {},
      }),
    describeOperation: (operation_id, input) =>
      request({
        endpoint: endpointByOperationId.describeOperation,
        method: 'POST',
        body: { operation_id, ...(input ? { input } : {}) },
      }),
    invokeOperation: (operation_id, input, approval_id) =>
      request({
        endpoint: endpointByOperationId.invokeOperation,
        method: 'POST',
        body: {
          operation_id,
          input: input ?? {},
          ...(approval_id ? { approval_id } : {}),
        },
      }),
  };
}

export function createWarmApiClient(options: WarmApiClientOptions = {}): WarmApiClient {
  return createClient(options.apiKeyResolver || getConfiguredApiKey, options);
}

export function createReadOnlyWarmApiClient(
  options: ReadOnlyWarmApiClientOptions
): ReadOnlyWarmApiClient {
  return createReadOnlyClient(createRequest(options.accessTokenResolver, options));
}
