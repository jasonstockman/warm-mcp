import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createWarmServer } from '../dist/server.js';
import { createWarmApiClient } from '../dist/warm-api-client.js';

const sampleContext = {
  version: 'v1',
  updated_at: '2026-07-06T11:58:41.000Z',
  currency: 'USD',
  status: {
    position: {
      date: '2026-07-06',
      net_worth: 84500,
      cash: 18200,
      debt: 6400,
      investments: 72700,
      other_assets: 0,
      total_assets: 90900,
    },
    accounts: [],
  },
  transactions: {
    total: 2,
    months: [{ month: '2026-07', count: 2 }],
  },
  recurring: [],
  budgets: [],
  goals: [],
  snapshots: [],
  liabilities: [],
  holdings: [],
  health: {
    score: 82,
    label: 'Strong',
    level: 'strong',
    summary: 'Strong cash position with low short-term risk.',
    data_completeness: 78,
    pillars: { spend: 84, save: 79, borrow: 88, build: 76 },
  },
};

const sampleMeta = {
  version: 'v1',
  user_id: 'user_1',
  context_id: 'user:user_1:v1',
  generated_at: '2026-07-06T12:00:00.000Z',
  updated_at: '2026-07-06T11:58:41.000Z',
  content_hash: 'sha256:abc',
  byte_length: 1234,
  counts: {
    accounts: 0,
    transaction_months: 1,
    transactions: 2,
    snapshots: 0,
  },
};

const sampleMonth = {
  month: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  count: 1,
  items: [
    {
      id: 'txn_1',
      account_id: 'acct_1',
      date: '2026-07-05',
      amount: 42.18,
      merchant: 'Whole Foods',
      name: 'WHOLE FOODS',
      category: 'FOOD_AND_DRINK',
      subcategory: 'FOOD_AND_DRINK_GROCERIES',
      pending: false,
      currency: 'USD',
    },
  ],
};

const sampleLatest = {
  since: '2026-06-26',
  window_days: 10,
  count: 0,
  items: [],
};

function createMockFetch(assertRequest) {
  return async (input, init) => {
    const url = new URL(input.toString());
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.headers.Accept, 'application/json');

    const body = assertRequest(url);
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  };
}

test('client reads compact FinancialContext from the v6 endpoint', async () => {
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://warm.io',
    fetchImplementation: createMockFetch((url) => {
      assert.equal(url.pathname, '/api/financial-context');
      assert.equal(url.search, '');
      return sampleContext;
    }),
    requestTimeoutMs: 5000,
  });

  assert.deepEqual(await client.getFinancialContext(), sampleContext);
});

test('client reads FinancialContext meta from the v6 endpoint', async () => {
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://warm.io',
    fetchImplementation: createMockFetch((url) => {
      assert.equal(url.pathname, '/api/financial-context/meta');
      assert.equal(url.search, '');
      return sampleMeta;
    }),
    requestTimeoutMs: 5000,
  });

  assert.deepEqual(await client.getFinancialContextMeta(), sampleMeta);
});

test('client requests transactions by month or latest only', async () => {
  const requested = [];
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://warm.io',
    fetchImplementation: createMockFetch((url) => {
      requested.push(`${url.pathname}${url.search}`);
      assert.equal(url.pathname, '/api/financial-context/transactions');

      if (url.searchParams.get('month') === '2026-07') {
        assert.equal(url.searchParams.has('latest'), false);
        return sampleMonth;
      }

      if (url.searchParams.get('latest') === '1') {
        assert.equal(url.searchParams.has('month'), false);
        return sampleLatest;
      }

      assert.fail(`Unexpected request: ${url.toString()}`);
    }),
    requestTimeoutMs: 5000,
  });

  assert.deepEqual(await client.getTransactions({ month: '2026-07' }), sampleMonth);
  assert.deepEqual(await client.getTransactions({ latest: true }), sampleLatest);
  assert.deepEqual(requested, [
    '/api/financial-context/transactions?month=2026-07',
    '/api/financial-context/transactions?latest=1',
  ]);
});

test('MCP server exposes exactly the v6 tools with the transaction contract documented', async () => {
  const { client, server } = await createConnectedMcpServer();
  try {
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ['get_financial_context', 'get_transactions', 'verify_key']);

    const transactionTool = listed.tools.find((tool) => tool.name === 'get_transactions');
    assert.match(transactionTool.description, /YYYY-MM/);
    assert.match(transactionTool.description, /10 days/);
    assert.match(transactionTool.description, /bare call/);
    assert.match(transactionTool.description, /mutually exclusive/);
    assert.match(transactionTool.description, /outside the covered range return an error/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP get_transactions defaults a bare call to latest and rejects mutual exclusion', async () => {
  const requests = [];
  const { client, server } = await createConnectedMcpServer((url) => {
    requests.push(`${url.pathname}${url.search}`);
    return sampleLatest;
  });

  try {
    const result = await client.callTool({ name: 'get_transactions', arguments: {} });
    assert.deepEqual(result.structuredContent, sampleLatest);
    assert.deepEqual(requests, ['/api/financial-context/transactions?latest=1']);

    await assert.rejects(
      client.callTool({
        name: 'get_transactions',
        arguments: { month: '2026-07', latest: true },
      }),
      /mutually exclusive/
    );
  } finally {
    await client.close();
    await server.close();
  }
});

async function createConnectedMcpServer(assertRequest = () => sampleContext) {
  const server = createWarmServer({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://warm.io',
    fetchImplementation: createMockFetch(assertRequest),
    requestTimeoutMs: 5000,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}
