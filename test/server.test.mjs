import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateMcpToolDescriptors } from '@warmio/contracts/mcp';
import { install } from '../dist/install.js';
import { createReadOnlyWarmServer, createWarmServer } from '../dist/server.js';
import { getConfiguredApiKey, resetConfiguredApiKeyCache } from '../dist/warm-api-client.js';

const API_KEY = `warm_${'a'.repeat(43)}`;
const OLD_API_KEY = `warm_${'b'.repeat(43)}`;
const REPLACEMENT_API_KEY = `warm_${'c'.repeat(43)}`;

async function connected(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function withConfigDirectory(root, run) {
  const previousConfigDirectory = process.env.WARM_CONFIG_DIR;
  const previousKey = process.env.WARM_API_KEY;
  const previousKeyFile = process.env.WARM_API_KEY_FILE;
  process.env.WARM_CONFIG_DIR = join(root, 'warm');
  delete process.env.WARM_API_KEY;
  delete process.env.WARM_API_KEY_FILE;
  resetConfiguredApiKeyCache();
  try {
    return await run(join(root, 'warm'));
  } finally {
    if (previousConfigDirectory === undefined) delete process.env.WARM_CONFIG_DIR;
    else process.env.WARM_CONFIG_DIR = previousConfigDirectory;
    if (previousKey === undefined) delete process.env.WARM_API_KEY;
    else process.env.WARM_API_KEY = previousKey;
    if (previousKeyFile === undefined) delete process.env.WARM_API_KEY_FILE;
    else process.env.WARM_API_KEY_FILE = previousKeyFile;
    resetConfiguredApiKeyCache();
  }
}

const financialContextFixture = {
  version: 'v1',
  updated_at: '2026-07-17T00:00:00.000Z',
  currency: 'USD',
  status: { position: null, accounts: [] },
  transactions: { total: 0, months: [] },
  recurring: [],
  budgets: [],
  goals: [],
  snapshots: [],
  liabilities: [],
  holdings: [],
  health: null,
};

test('the API-key server exposes the complete five-tool surface', async () => {
  let fetchCalls = 0;
  const connection = await connected(
    createWarmServer({
      apiKeyResolver: () => API_KEY,
      fetchImplementation: async () => {
        fetchCalls += 1;
        throw new Error('server setup must not call the API');
      },
    })
  );
  try {
    const names = (await connection.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'describe_operation',
      'get_financial_context',
      'get_transactions',
      'invoke_operation',
      'search_operations',
    ]);
    assert.equal(fetchCalls, 0);
  } finally {
    await connection.client.close();
    await connection.server.close();
  }
});

test('the runtime preserves the canonical get_transactions output schema', async () => {
  const connection = await connected(
    createWarmServer({
      apiKeyResolver: () => API_KEY,
      fetchImplementation: async () => {
        throw new Error('server setup must not call the API');
      },
    })
  );
  try {
    const runtimeDescriptor = (await connection.client.listTools()).tools.find(
      (tool) => tool.name === 'get_transactions'
    );
    const canonicalDescriptor = privateMcpToolDescriptors.find(
      (tool) => tool.name === 'get_transactions'
    );
    assert.ok(runtimeDescriptor);
    assert.ok(canonicalDescriptor);
    assert.deepEqual(runtimeDescriptor.outputSchema, {
      ...canonicalDescriptor.output_schema,
      type: 'object',
    });
  } finally {
    await connection.client.close();
    await connection.server.close();
  }
});

test('the read-only server uses only its access-token resolver and registers no automation tools', async () => {
  const connection = await connected(
    createReadOnlyWarmServer({
      accessTokenResolver: () => 'chat-jwt',
      fetchImplementation: async (_input, init) => {
        assert.equal(init.headers.Authorization, 'Bearer chat-jwt');
        return Response.json(financialContextFixture);
      },
    })
  );
  try {
    const names = (await connection.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['get_financial_context', 'get_transactions']);
    const result = await connection.client.callTool({
      name: 'get_financial_context',
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, financialContextFixture);
  } finally {
    await connection.client.close();
    await connection.server.close();
  }
});

test('the installer accepts only a valid-format key and an exact successful verify response before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  await mkdir(join(root, '.cursor'), { recursive: true });
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      const cursorPath = join(root, '.cursor', 'mcp.json');
      await assert.rejects(
        install({
          homeDir: root,
          workingDirectory: root,
          prompt: async () => API_KEY,
          fetchImplementation: async () => Response.json({ valid: true, status: 'ok' }),
        }),
        /validation failed/
      );
      await assert.rejects(readFile(join(configDirectory, 'api_key'), 'utf8'), {
        code: 'ENOENT',
      });
      await assert.rejects(readFile(cursorPath, 'utf8'), { code: 'ENOENT' });

      let calledRemoteVerify = false;
      await assert.rejects(
        install({
          homeDir: root,
          workingDirectory: root,
          prompt: async () => 'not-a-warm-api-key',
          fetchImplementation: async () => {
            calledRemoteVerify = true;
            return Response.json({ valid: true });
          },
        }),
        /validation failed/
      );
      assert.equal(calledRemoteVerify, false);
      await assert.rejects(readFile(join(configDirectory, 'api_key'), 'utf8'), {
        code: 'ENOENT',
      });
      await assert.rejects(readFile(cursorPath, 'utf8'), { code: 'ENOENT' });

      await install({
        homeDir: root,
        workingDirectory: root,
        prompt: async () => API_KEY,
        fetchImplementation: async (input, init) => {
          assert.equal(new URL(input).pathname, '/api/verify');
          assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
          return Response.json({ valid: true });
        },
      });
      assert.equal(await readFile(join(configDirectory, 'api_key'), 'utf8'), `${API_KEY}\n`);
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'));
      assert.deepEqual(cursor.mcpServers.warm, {
        command: 'npx',
        args: ['-y', '@warmio/mcp@latest', 'mcp'],
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the installer validates a stored key even when every client config is already current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  const claudePath = join(root, '.claude.json');
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      const currentConfig = {
        mcpServers: {
          warm: { command: 'npx', args: ['-y', '@warmio/mcp@latest', 'mcp'] },
        },
        unrelated: true,
      };
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, 'api_key'), `${API_KEY}\n`);
      await writeFile(claudePath, `${JSON.stringify(currentConfig)}\n`);
      await install({
        homeDir: root,
        workingDirectory: root,
        prompt: async () => {
          throw new Error('a valid stored key must not be replaced');
        },
        fetchImplementation: async (_input, init) => {
          assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
          return Response.json({ valid: true });
        },
      });
      assert.deepEqual(JSON.parse(await readFile(claudePath, 'utf8')), currentConfig);
      assert.equal(await readFile(join(configDirectory, 'api_key'), 'utf8'), `${API_KEY}\n`);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the installer replaces a stale generic client config without retained Warm fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  const cursorPath = join(root, '.cursor', 'mcp.json');
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      await mkdir(join(root, '.cursor'), { recursive: true });
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, 'api_key'), `${OLD_API_KEY}\n`);
      await writeFile(
        cursorPath,
        JSON.stringify({
          unrelated: true,
          mcpServers: {
            warm: {
              command: 'old-command',
              displayName: 'Warm',
              env: {
                CUSTOM_ENV: 'preserve',
                WARM_AUTOMATION_API_KEY: OLD_API_KEY,
                WARM_CONTEXT_API_KEY: OLD_API_KEY,
                WARM_MCP_API_KEY: OLD_API_KEY,
              },
            },
          },
        })
      );
      const confirmations = [];
      await install({
        homeDir: root,
        workingDirectory: root,
        prompt: async () => REPLACEMENT_API_KEY,
        confirm: async (question) => {
          confirmations.push(question);
          return true;
        },
        fetchImplementation: async (_input, init) => {
          if (init.headers.Authorization === `Bearer ${OLD_API_KEY}`)
            return Response.json({ valid: false }, { status: 401 });
          assert.equal(init.headers.Authorization, `Bearer ${REPLACEMENT_API_KEY}`);
          return Response.json({ valid: true });
        },
      });
      assert.equal(confirmations.length, 2);
      assert.equal(
        await readFile(join(configDirectory, 'api_key'), 'utf8'),
        `${REPLACEMENT_API_KEY}\n`
      );
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'));
      assert.deepEqual(cursor, {
        unrelated: true,
        mcpServers: {
          warm: {
            command: 'npx',
            args: ['-y', '@warmio/mcp@latest', 'mcp'],
          },
        },
      });

      await writeFile(join(configDirectory, 'api_key'), `${OLD_API_KEY}\n`);
      await writeFile(
        cursorPath,
        JSON.stringify({ mcpServers: { warm: { command: 'old-command' } } })
      );
      await install({
        force: true,
        homeDir: root,
        workingDirectory: root,
        prompt: async () => REPLACEMENT_API_KEY,
        confirm: async () => {
          throw new Error('force must not ask for confirmation');
        },
        fetchImplementation: async (_input, init) => {
          assert.equal(init.headers.Authorization, `Bearer ${REPLACEMENT_API_KEY}`);
          return Response.json({ valid: true });
        },
      });
      assert.equal(
        await readFile(join(configDirectory, 'api_key'), 'utf8'),
        `${REPLACEMENT_API_KEY}\n`
      );
      assert.deepEqual(JSON.parse(await readFile(cursorPath, 'utf8')).mcpServers.warm, {
        command: 'npx',
        args: ['-y', '@warmio/mcp@latest', 'mcp'],
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installer writes OpenCode's local MCP dialect and removes its generic legacy entry", async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  const opencodePath = join(root, '.config', 'opencode', 'opencode.json');
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      await mkdir(join(root, '.config', 'opencode'), { recursive: true });
      await writeFile(
        opencodePath,
        JSON.stringify({
          mcp: {
            other: { type: 'remote', url: 'https://example.com/mcp' },
            warm: {
              type: 'local',
              command: ['old-command'],
              env: { WARM_CONTEXT_TOKEN: 'retired' },
            },
          },
          mcpServers: {
            warm: { command: 'old-command', env: { WARM_AUTOMATION_TOKEN: 'retired' } },
          },
          unrelated: true,
        })
      );

      await install({
        force: true,
        homeDir: root,
        workingDirectory: root,
        prompt: async () => API_KEY,
        fetchImplementation: async () => Response.json({ valid: true }),
      });

      assert.deepEqual(JSON.parse(await readFile(opencodePath, 'utf8')), {
        mcp: {
          other: { type: 'remote', url: 'https://example.com/mcp' },
          warm: {
            type: 'local',
            command: ['npx', '-y', '@warmio/mcp@latest', 'mcp'],
          },
        },
        unrelated: true,
      });
      assert.equal(await readFile(join(configDirectory, 'api_key'), 'utf8'), `${API_KEY}\n`);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the installer rolls back client configs when a later atomic replacement fails before storing a replacement key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  const claudePath = join(root, '.claude.json');
  const cursorPath = join(root, '.cursor', 'mcp.json');
  const originalClaude = JSON.stringify({ mcpServers: { warm: { command: 'old-claude' } } });
  const originalCursor = JSON.stringify({ mcpServers: { warm: { command: 'old-cursor' } } });
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      await mkdir(join(root, '.cursor'), { recursive: true });
      await mkdir(configDirectory, { recursive: true });
      await writeFile(claudePath, originalClaude);
      await writeFile(cursorPath, originalCursor);
      await writeFile(join(configDirectory, 'api_key'), `${OLD_API_KEY}\n`);

      await assert.rejects(
        install({
          force: true,
          homeDir: root,
          workingDirectory: root,
          prompt: async () => REPLACEMENT_API_KEY,
          fetchImplementation: async () => Response.json({ valid: true }),
          atomicReplaceFile: (target, content, mode) => {
            if (target === cursorPath) throw new Error('simulated replacement failure');
            writeFileSync(target, content, { encoding: 'utf8', mode });
          },
        }),
        /simulated replacement failure/
      );

      assert.equal(await readFile(claudePath, 'utf8'), originalClaude);
      assert.equal(await readFile(cursorPath, 'utf8'), originalCursor);
      assert.equal(await readFile(join(configDirectory, 'api_key'), 'utf8'), `${OLD_API_KEY}\n`);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the installer only treats the Warm TOML section as current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  const codexPath = join(root, '.codex', 'config.toml');
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      await mkdir(join(root, '.codex'), { recursive: true });
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, 'api_key'), `${API_KEY}\n`);
      await writeFile(
        codexPath,
        [
          '[mcp_servers.other]',
          'command = "npx"',
          'args = ["-y", "@warmio/mcp@latest", "mcp"]',
          '',
          '[mcp_servers.warm]',
          'command = "npx"',
          'display_name = "Warm"',
          '',
          '[mcp_servers.warm.env]',
          'WARM_CONTEXT_TOKEN = "retired"',
          'WARM_AUTOMATION_TOKEN = "retired"',
          '',
        ].join('\n')
      );

      const confirmations = [];
      await install({
        homeDir: root,
        workingDirectory: root,
        confirm: async (question) => {
          confirmations.push(question);
          return true;
        },
        fetchImplementation: async () => Response.json({ valid: true }),
      });

      assert.equal(confirmations.length, 1);
      assert.match(
        await readFile(codexPath, 'utf8'),
        /\[mcp_servers\.warm\][\s\S]*?command = "npx"[\s\S]*?args = \["-y","@warmio\/mcp@latest","mcp"\]/
      );
      const codexConfig = await readFile(codexPath, 'utf8');
      assert.doesNotMatch(codexConfig, /(?:display_name|WARM_CONTEXT_|WARM_AUTOMATION_)/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WARM_API_KEY_FILE overrides the default stored-key path without becoming another key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-mcp-'));
  try {
    await withConfigDirectory(root, async (configDirectory) => {
      const overridePath = join(root, 'override-key');
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, 'api_key'), `${OLD_API_KEY}\n`);
      await writeFile(overridePath, `${API_KEY}\n`);
      process.env.WARM_API_KEY_FILE = overridePath;
      resetConfiguredApiKeyCache();
      assert.equal(getConfiguredApiKey(), API_KEY);
      process.env.WARM_API_KEY = REPLACEMENT_API_KEY;
      resetConfiguredApiKeyCache();
      assert.equal(getConfiguredApiKey(), REPLACEMENT_API_KEY);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
