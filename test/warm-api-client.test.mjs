import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { API_URL, createWarmServer } from '../dist/server.js';
import {
  hasValidTransportBearerToken,
  startHttpServer,
  validateHttpSecurity,
} from '../dist/http.js';
import { createWarmApiClient } from '../dist/warm-api-client.js';
import { getWarmApiKeyPath } from '../dist/config-paths.js';

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

test('shared API origin defaults to app.warm.io while honoring WARM_API_URL', async () => {
  const expectedApiUrl = process.env.WARM_API_URL || 'https://app.warm.io';
  assert.equal(API_URL, expectedApiUrl);
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    fetchImplementation: async (input) => {
      assert.equal(new URL(input.toString()).origin, new URL(expectedApiUrl).origin);
      return Response.json(sampleContext);
    },
  });
  await client.getFinancialContext();
});

test('server manifest describes the v9 mode selector and current credentials', () => {
  const manifest = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const packageManifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(packageManifest.mcpName, manifest.name);
  assert.equal(manifest.packages.length, 1);
  const packageEntry = manifest.packages[0];
  assert.equal(packageEntry.version, packageManifest.version);
  assert.deepEqual(
    packageEntry.packageArguments.map((argument) => argument.value ?? argument.valueHint),
    ['mcp', '--mode', 'mode']
  );
  assert.deepEqual(packageEntry.packageArguments[2].choices, ['context', 'automation']);
  const environmentNames = packageEntry.environmentVariables.map((entry) => entry.name);
  assert.deepEqual(environmentNames, [
    'WARM_CONTEXT_API_KEY',
    'WARM_CONTEXT_API_KEY_FILE',
    'WARM_AUTOMATION_API_KEY',
    'WARM_AUTOMATION_API_KEY_FILE',
    'WARM_CONFIG_DIR',
    'WARM_API_URL',
    'WARM_API_TIMEOUT_MS',
  ]);
  assert.equal(JSON.stringify(manifest).includes('WARM_API_KEY"'), false);
  assert.equal(JSON.stringify(manifest).includes('5.0.1'), false);
});

test('client reads compact FinancialContext from the context endpoint', async () => {
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://app.warm.io',
    fetchImplementation: createMockFetch((url) => {
      assert.equal(url.pathname, '/api/financial-context');
      assert.equal(url.search, '');
      return sampleContext;
    }),
    requestTimeoutMs: 5000,
  });

  assert.deepEqual(await client.getFinancialContext(), sampleContext);
});

test('client reads FinancialContext meta from the context endpoint', async () => {
  const client = createWarmApiClient({
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://app.warm.io',
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
    apiUrl: 'https://app.warm.io',
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

test('context MCP mode exposes exactly three tools with the transaction contract documented', async () => {
  const { client, server } = await createConnectedMcpServer();
  try {
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ['get_financial_context', 'get_transactions', 'verify_key']);

    const transactionTool = listed.tools.find((tool) => tool.name === 'get_transactions');
    assert.ok(listed.tools.every((tool) => tool.outputSchema));
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

test('verify_key structured content matches its advertised output schema', async () => {
  const { client, server } = await createConnectedMcpServer();
  try {
    const result = await client.callTool({ name: 'verify_key', arguments: {} });
    assert.deepEqual(result.structuredContent, {
      audience: 'context',
      status: 'ok',
      valid: true,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP modes expose separate three-tool surfaces with mode-specific annotations', async () => {
  const { client, server } = await createConnectedMcpServer(() => sampleContext, 'automation');
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.every((tool) => tool.outputSchema));
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'describe_operation',
      'invoke_operation',
      'search_operations',
    ]);
    assert.equal(
      listed.tools.find((tool) => tool.name === 'search_operations').annotations.readOnlyHint,
      true
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'describe_operation').annotations.readOnlyHint,
      false
    );
    const invoke = listed.tools.find((tool) => tool.name === 'invoke_operation');
    assert.equal(invoke.annotations.readOnlyHint, false);
    assert.equal(invoke.annotations.destructiveHint, true);
    assert.ok(invoke.inputSchema.properties.approval_id);
    assert.equal(invoke.inputSchema.properties.approval_id.format, 'uuid');
    assert.equal(invoke.inputSchema.properties.confirmation_token, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test('automation approval contract returns approval details and invokes with approval_id', async () => {
  const approval = {
    approval_url: 'https://app.warm.io/approvals/approval_1',
    expires_at: '2026-07-14T20:00:00.000Z',
    id: 'approval_1',
    status: 'pending',
  };
  const operation = {
    confirmation_required: true,
    description: 'Pay a supported bill from a linked account.',
    input_schema: {
      additionalProperties: false,
      properties: { amount: { type: 'number' } },
      required: ['amount'],
      type: 'object',
    },
    method: 'POST',
    operation_id: 'pay_bill',
    path: '/api/automation/bills/pay',
    risk: ['write', 'external_effect'],
    summary: 'Pay bill',
  };
  const client = createWarmApiClient({
    audience: 'automation',
    apiKeyResolver: () => 'automation-key',
    fetchImplementation: async (input, init) => {
      const url = new URL(input.toString());
      const body = JSON.parse(init.body);
      if (url.pathname.endsWith('/describe')) {
        return Response.json({ approval, operation });
      }
      assert.equal(url.pathname, '/api/automation/operations/invoke');
      assert.equal(body.approval_id, approval.id);
      assert.equal(body.confirmation_token, undefined);
      return Response.json({
        body: { ok: true },
        headers: {},
        operation_id: 'pay_bill',
        status: 200,
      });
    },
  });

  const described = await client.describeOperation('pay_bill', { body: { amount: 20 } });
  assert.deepEqual(described.approval, approval);
  assert.deepEqual(described.operation, operation);
  const invoked = await client.invokeOperation('pay_bill', { body: { amount: 20 } }, approval.id);
  assert.equal(invoked.status, 200);
});

test('automation MCP input rejects unsupported query and non-UUID approval IDs', async () => {
  const { client, server } = await createConnectedMcpServer(() => ({}), 'automation');
  try {
    await assert.rejects(
      client.callTool({
        name: 'describe_operation',
        arguments: {
          operation_id: 'pay_bill',
          input: { query: { account_id: 'account_1' } },
        },
      }),
      /Invalid arguments/
    );
    await assert.rejects(
      client.callTool({
        name: 'invoke_operation',
        arguments: { approval_id: 'not-a-uuid', operation_id: 'pay_bill' },
      }),
      /Invalid arguments/
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('automation requests use a POST JSON body and the automation bearer key', async () => {
  const requests = [];
  const client = createWarmApiClient({
    audience: 'automation',
    apiKeyResolver: () => 'automation-key',
    apiUrl: 'https://app.warm.io',
    fetchImplementation: async (input, init) => {
      requests.push({
        body: init.body,
        headers: init.headers,
        method: init.method,
        path: new URL(input.toString()).pathname,
      });
      return new Response(JSON.stringify({ operations: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    },
  });

  await client.searchOperations('pay bill');
  assert.deepEqual(requests, [
    {
      body: JSON.stringify({ query: 'pay bill' }),
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer automation-key',
        'Content-Type': 'application/json',
      },
      method: 'POST',
      path: '/api/automation/operations/search',
    },
  ]);
});

test('audience validation rejects a context key in automation mode', async () => {
  const client = createWarmApiClient({
    audience: 'automation',
    apiKeyResolver: () => 'wrong-key',
    fetchImplementation: async () =>
      new Response(JSON.stringify({ audience: 'context', status: 'ok', valid: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
  });

  await assert.rejects(client.validateAudience(), /requires an automation API key/);
});

test('tool handler failures become structured MCP error results', async () => {
  const server = createWarmServer({
    mode: 'automation',
    apiKeyResolver: () => 'context-key',
    fetchImplementation: async () =>
      Response.json({ audience: 'context', status: 'ok', valid: true }),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'search_operations', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(
      JSON.parse(result.content[0].text).error.message,
      /requires an automation API key/
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('failed automation operations preserve their status and body as an MCP error result', async () => {
  const failure = { error: 'Insufficient funds', code: 'insufficient_funds' };
  const { client, server } = await createConnectedMcpServer((url) => {
    assert.equal(url.pathname, '/api/automation/operations/invoke');
    return {
      body: failure,
      headers: {},
      operation_id: 'pay_bill',
      status: 422,
    };
  }, 'automation');
  try {
    const result = await client.callTool({
      name: 'invoke_operation',
      arguments: { operation_id: 'pay_bill', input: { body: { amount: 20 } } },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      body: failure,
      headers: {},
      operation_id: 'pay_bill',
      status: 422,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('API failures become structured MCP error results with status, body, and headers', async () => {
  const server = createWarmServer({
    apiKeyResolver: () => 'test-key',
    fetchImplementation: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/verify') {
        return Response.json({ audience: 'context', status: 'ok', valid: true });
      }
      return Response.json(
        { error: 'Financial context is temporarily unavailable.' },
        { headers: { 'Retry-After': '5' }, status: 503 }
      );
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'get_financial_context', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.status, 503);
    assert.deepEqual(error.body, {
      error: 'Financial context is temporarily unavailable.',
    });
    assert.equal(error.headers['retry-after'], '5');
  } finally {
    await client.close();
    await server.close();
  }
});

test('mode-specific credential paths and HTTP transport security stay separate', () => {
  assert.notEqual(getWarmApiKeyPath('context'), getWarmApiKeyPath('automation'));
  assert.doesNotThrow(() => validateHttpSecurity({ host: '127.0.0.1', mode: 'context' }));
  assert.throws(
    () => validateHttpSecurity({ host: '0.0.0.0', mode: 'context' }),
    /Non-loopback MCP HTTP requires WARM_MCP_AUTH_TOKEN/
  );
  assert.throws(
    () => validateHttpSecurity({ host: '127.0.0.2', mode: 'context' }),
    /Non-loopback MCP HTTP requires WARM_MCP_AUTH_TOKEN/
  );
  assert.throws(
    () => validateHttpSecurity({ host: '::ffff:127.0.0.1', mode: 'context' }),
    /Non-loopback MCP HTTP requires WARM_MCP_AUTH_TOKEN/
  );
  assert.throws(
    () => validateHttpSecurity({ host: '127.0.0.1', mode: 'automation' }),
    /Automation MCP HTTP requires WARM_MCP_AUTH_TOKEN/
  );
  assert.doesNotThrow(() =>
    validateHttpSecurity({ authToken: 'transport-only-token', host: '0.0.0.0', mode: 'automation' })
  );
  assert.equal(
    hasValidTransportBearerToken('Bearer transport-only-token', 'transport-only-token'),
    true
  );
  assert.equal(hasValidTransportBearerToken('Bearer wrong', 'transport-only-token'), false);
});

test('automation HTTP rejects requests without its independent transport bearer token', async () => {
  const listener = await startHttpServer({
    authToken: 'transport-only-token',
    host: '127.0.0.1',
    mode: 'automation',
    port: 0,
  });
  try {
    const address = listener.address();
    assert.equal(typeof address, 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Unauthorized MCP transport request/);
  } finally {
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
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
    await assert.rejects(
      client.callTool({ name: 'get_transactions', arguments: { latest: false } }),
      /Invalid arguments/
    );
  } finally {
    await client.close();
    await server.close();
  }
});

const installerCliPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function runInstallerFixture(setup, input = '', extraArgs = []) {
  const home = mkdtempSync(join(tmpdir(), 'warm-mcp-installer-'));
  const warmConfigDir = join(home, 'warm-config');
  setup?.({ home, warmConfigDir });
  const result = spawnSync(
    process.execPath,
    [installerCliPath, 'install', '--mode', 'context', '--no-validate', ...extraArgs],
    {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        WARM_AUTOMATION_API_KEY: '',
        WARM_AUTOMATION_API_KEY_FILE: '',
        WARM_CONFIG_DIR: warmConfigDir,
        WARM_CONTEXT_API_KEY: '',
        WARM_CONTEXT_API_KEY_FILE: '',
      },
      input,
    }
  );
  return { home, result, warmConfigDir };
}

test('installer does not treat configured MCP command as complete when its key is missing', () => {
  const fixture = runInstallerFixture(({ home }) => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          warm: {
            args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
            command: 'npx',
            env: { WARM_AUTOMATION_API_KEY: 'remove-this-opposite-mode-key' },
          },
        },
      })
    );
  }, 'context-key\n');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.doesNotMatch(fixture.result.stdout, /All clients already configured/);
    assert.match(fixture.result.stdout, /All set!/);
    assert.equal(
      readFileSync(join(fixture.warmConfigDir, 'context_api_key'), 'utf8').trim(),
      'context-key'
    );
    assert.equal(statSync(join(fixture.warmConfigDir, 'context_api_key')).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(join(fixture.home, '.claude.json'), 'utf8'));
    assert.equal(config.mcpServers.warm.env, undefined);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer resolves a usable mode-specific API key file override', () => {
  const fixture = runInstallerFixture(({ home }) => {
    const overridePath = join(home, 'context-key.override');
    writeFileSync(overridePath, 'context-key\n');
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          warm: {
            args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
            command: 'npx',
            env: { WARM_CONTEXT_API_KEY_FILE: overridePath },
          },
        },
      })
    );
  });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /All clients already configured/);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer exits nonzero and omits success when a client config write fails', () => {
  const fixture = runInstallerFixture(({ home }) => {
    const configPath = join(home, '.claude.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(configPath, 0o400);
  }, 'context-key\n');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stdout, /Claude Code\s+failed:/);
    assert.doesNotMatch(fixture.result.stdout, /All set!/);
    assert.match(fixture.result.stderr, /Failed to configure MCP clients/);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer leaves unparsable JSON, JSONC, and trailing-comma configs byte-for-byte untouched', () => {
  const cases = [
    ['unparsable JSON', '{"mcpServers": {'],
    ['JSONC', '{\n  // existing comment\n  "mcpServers": {}\n}\n'],
    ['trailing comma', '{\n  "mcpServers": {},\n}\n'],
  ];
  for (const [label, original] of cases) {
    const fixture = runInstallerFixture(({ home }) => {
      writeFileSync(join(home, '.claude.json'), original);
    }, 'context-key\n');
    try {
      assert.notEqual(fixture.result.status, 0, label);
      assert.equal(readFileSync(join(fixture.home, '.claude.json'), 'utf8'), original, label);
      assert.doesNotMatch(fixture.result.stdout, /All set!/, label);
      assert.match(fixture.result.stderr, /Refusing to overwrite unparsable JSON config/, label);
    } finally {
      rmSync(fixture.home, { force: true, recursive: true });
    }
  }
});

test('installer rejects non-object mcpServers without changing the config', () => {
  const original = '{\n  "mcpServers": []\n}\n';
  const fixture = runInstallerFixture(({ home }) => {
    writeFileSync(join(home, '.claude.json'), original);
  }, 'context-key\n');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.equal(readFileSync(join(fixture.home, '.claude.json'), 'utf8'), original);
    assert.match(fixture.result.stderr, /mcpServers must be an object/);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer prompts for a default key when one mixed-client target lacks credentials', () => {
  const fixture = runInstallerFixture(({ home }) => {
    const overridePath = join(home, 'context-key.override');
    writeFileSync(overridePath, 'override-context-key\n');
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          warm: {
            args: ['-y', '@warmio/mcp@latest', 'mcp'],
            command: 'npx',
            env: { WARM_CONTEXT_API_KEY_FILE: overridePath },
          },
        },
      })
    );
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          warm: {
            args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
            command: 'npx',
          },
        },
      })
    );
  }, 'default-context-key\n');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.doesNotMatch(
      fixture.result.stdout,
      /Reusing existing WARM_CONTEXT_API_KEY_FILE override/
    );
    assert.equal(
      readFileSync(join(fixture.warmConfigDir, 'context_api_key'), 'utf8').trim(),
      'default-context-key'
    );
    const claude = JSON.parse(readFileSync(join(fixture.home, '.claude.json'), 'utf8'));
    assert.equal(
      claude.mcpServers.warm.env.WARM_CONTEXT_API_KEY_FILE,
      join(fixture.home, 'context-key.override')
    );
    assert.deepEqual(claude.mcpServers.warm.args.slice(-2), ['--mode', 'context']);
    const cursor = JSON.parse(readFileSync(join(fixture.home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.warm.env, undefined);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer updates CRLF Codex TOML without losing custom env or config lines', () => {
  let overridePath;
  const fixture = runInstallerFixture(({ home, warmConfigDir }) => {
    mkdirSync(warmConfigDir, { recursive: true });
    writeFileSync(join(warmConfigDir, 'context_api_key'), 'default-context-key\n', { mode: 0o600 });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          warm: {
            args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
            command: 'npx',
          },
        },
      })
    );

    overridePath = join(home, 'codex-context-key.override');
    writeFileSync(overridePath, 'codex-override-key\n');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const crlf = '\r\n';
    const originalToml = [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      '',
      '[mcp_servers.warm]',
      'command = "npx"',
      'args = ["-y", "@warmio/mcp@latest", "mcp"]',
      '',
      '[mcp_servers.warm.env]',
      `WARM_CONTEXT_API_KEY_FILE = "${overridePath}"`,
      'CUSTOM_KEEP = "preserved"',
      'WARM_AUTOMATION_API_KEY_FILE = "/remove/opposite-key"',
      '',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      '',
    ].join(crlf);
    writeFileSync(join(home, '.codex', 'config.toml'), originalToml);
  });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const updated = readFileSync(join(fixture.home, '.codex', 'config.toml'), 'utf8');
    assert.equal(/(^|[^\r])\n/.test(updated), false);
    assert.match(updated, /model_reasoning_effort = "high"/);
    assert.match(updated, /CUSTOM_KEEP = "preserved"/);
    assert.match(updated, /trust_level = "trusted"/);
    assert.match(
      updated,
      new RegExp(
        `WARM_CONTEXT_API_KEY_FILE = "${overridePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`
      )
    );
    assert.doesNotMatch(updated, /WARM_AUTOMATION_API_KEY_FILE/);
    assert.match(updated, /args = \["-y", "@warmio\/mcp@latest", "mcp", "--mode", "context"\]/);
    assert.equal((updated.match(/\[mcp_servers\.warm\]/g) || []).length, 1);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer restores 0600 permissions when overwriting a stored key', () => {
  const fixture = runInstallerFixture(
    ({ home, warmConfigDir }) => {
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            warm: {
              args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
              command: 'npx',
            },
          },
        })
      );
      mkdirSync(warmConfigDir, { recursive: true });
      writeFileSync(join(warmConfigDir, 'context_api_key'), 'old-key\n', { mode: 0o644 });
    },
    'new-key\n',
    ['--force']
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const keyPath = join(fixture.warmConfigDir, 'context_api_key');
    assert.equal(readFileSync(keyPath, 'utf8').trim(), 'new-key');
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('--force rotates away from an existing selected key-file override', () => {
  let overridePath;
  const fixture = runInstallerFixture(
    ({ home }) => {
      overridePath = join(home, 'old-context-key.override');
      writeFileSync(overridePath, 'old-override-key\n');
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            warm: {
              args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
              command: 'npx',
              env: { WARM_CONTEXT_API_KEY_FILE: overridePath },
            },
          },
        })
      );
    },
    'rotated-context-key\n',
    ['--force']
  );
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(
      readFileSync(join(fixture.warmConfigDir, 'context_api_key'), 'utf8').trim(),
      'rotated-context-key'
    );
    assert.equal(readFileSync(overridePath, 'utf8').trim(), 'old-override-key');
    const config = JSON.parse(readFileSync(join(fixture.home, '.claude.json'), 'utf8'));
    assert.equal(config.mcpServers.warm.env, undefined);
  } finally {
    rmSync(fixture.home, { force: true, recursive: true });
  }
});

test('installer validates an already-configured effective key and blocks typed 403 failures', async () => {
  const apiServer = createServer((_request, response) => {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Automation access is not allowed for this account.' }));
  });
  await new Promise((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(0, '127.0.0.1', resolve);
  });

  const home = mkdtempSync(join(tmpdir(), 'warm-mcp-installer-403-'));
  const configPath = join(home, '.claude.json');
  const originalConfig =
    JSON.stringify({
      mcpServers: {
        warm: {
          args: ['-y', '@warmio/mcp@latest', 'mcp', '--mode', 'context'],
          command: 'npx',
        },
      },
    }) + '\n';
  writeFileSync(configPath, originalConfig);
  const warmConfigDir = join(home, 'warm-config');
  mkdirSync(warmConfigDir, { recursive: true });
  writeFileSync(join(warmConfigDir, 'context_api_key'), 'stored-context-key\n', { mode: 0o600 });
  const address = apiServer.address();
  assert.equal(typeof address, 'object');

  try {
    const child = spawn(process.execPath, [installerCliPath, 'install', '--mode', 'context'], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        WARM_API_URL: `http://127.0.0.1:${address.port}`,
        WARM_AUTOMATION_API_KEY: '',
        WARM_AUTOMATION_API_KEY_FILE: '',
        WARM_CONFIG_DIR: warmConfigDir,
        WARM_CONTEXT_API_KEY: '',
        WARM_CONTEXT_API_KEY_FILE: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end();
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    assert.equal(exitCode, 1, stderr);
    assert.match(stdout, /Validating API key/);
    assert.match(stdout, /Validation failed: API access is available on paid plans only/);
    assert.doesNotMatch(stdout, /Continuing setup/);
    assert.doesNotMatch(stdout, /All set!/);
    assert.equal(readFileSync(configPath, 'utf8'), originalConfig);
  } finally {
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(home, { force: true, recursive: true });
  }
});

async function createConnectedMcpServer(assertRequest = () => sampleContext, mode = 'context') {
  const server = createWarmServer({
    mode,
    apiKeyResolver: () => 'test-key',
    apiUrl: 'https://app.warm.io',
    fetchImplementation: createMockFetch((url) => {
      if (url.pathname === '/api/verify') {
        return { audience: mode, status: 'ok', valid: true };
      }
      return assertRequest(url);
    }),
    requestTimeoutMs: 5000,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}
