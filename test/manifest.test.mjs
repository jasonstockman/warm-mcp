import assert from 'node:assert/strict';
import test from 'node:test';

test('manifest exposes installer-owned facts without machine-specific paths', async () => {
  const manifestModule = await import('../dist/manifest.js');
  const manifest = manifestModule.WARM_MCP_MANIFEST;

  assert.equal(manifest.packageName, '@warmio/mcp');
  assert.equal(manifest.installCommand, 'npx -y @warmio/mcp@latest');
  assert.deepEqual(
    manifest.clients.map((client) => client.name),
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

  const serialized = JSON.stringify(manifest);
  if (process.env.HOME) {
    assert.equal(serialized.includes(process.env.HOME), false);
  }
});
