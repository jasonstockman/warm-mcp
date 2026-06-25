import assert from 'node:assert/strict';
import test from 'node:test';

import { createWarmApiClient } from '../dist/warm-api-client.js';

test('getFinancialState uses export datasets and derives category spending from snapshots', async () => {
  const requestedPaths = [];
  const payloads = {
    snapshots: {
      generated_at: '2026-04-22T00:00:00.000Z',
      snapshots: [
        {
          date: '2026-04-22',
          net_worth: 1000,
          spending_by_category: [{ category: 'GROCERIES', total: 42.12 }],
          total_assets: 1500,
          total_liabilities: 500,
        },
      ],
    },
    recurring: { recurring: [] },
    budgets: { budgets: [] },
    goals: { goals: [] },
    health: { generated_at: '2026-04-22T00:00:00.000Z' },
    liabilities: { liabilities: [] },
    holdings: { holdings: [] },
  };

  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://warm.io',
    fetchImplementation: async (input) => {
      const url = new URL(input.toString());
      requestedPaths.push(url.pathname);

      assert.equal(url.pathname, '/api/export');

      return new Response(JSON.stringify(payloads[url.searchParams.get('dataset')] ?? {}), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    },
    requestTimeoutMs: 5000,
  });

  const state = await client.getFinancialState();

  assert.deepEqual(new Set(requestedPaths), new Set(['/api/export']));
  assert.equal(requestedPaths.includes('/api/spending'), false);
  assert.deepEqual(state.category_spending, [{ amount: 42.12, category: 'GROCERIES' }]);
});
