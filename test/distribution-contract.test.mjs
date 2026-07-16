import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WARM_MCP_MANIFEST, WARM_MCP_MINIMUM_NODE_VERSION } from '@warmio/contracts/mcp';

test('package and installer consume the canonical MCP distribution contract', async () => {
  const packageManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );

  assert.equal(WARM_MCP_MANIFEST.packageName, packageManifest.name);
  assert.equal(packageManifest.engines.node, WARM_MCP_MINIMUM_NODE_VERSION);
  assert.equal(packageManifest.exports['./manifest'], undefined);
  assert.equal(WARM_MCP_MANIFEST.installCommand, 'npx -y @warmio/mcp@latest');
  assert.deepEqual(
    WARM_MCP_MANIFEST.clients.map((client) => client.name),
    [
      'Claude Code',
      'Claude Desktop',
      'Cursor',
      'Windsurf',
      'OpenCode',
      'Codex CLI',
      'Antigravity',
      'Gemini CLI',
    ]
  );
  assert.deepEqual(WARM_MCP_MANIFEST.projectConfigs, [
    '.mcp.json',
    '.cursor/mcp.json',
    '.vscode/mcp.json',
  ]);

  const serialized = JSON.stringify(WARM_MCP_MANIFEST);
  assert.doesNotMatch(serialized, /Users\/|C:\\\\Users\/|\/home\//);
  assert.doesNotMatch(serialized, /WARM_API_KEY(?:_FILE)?/);
});
