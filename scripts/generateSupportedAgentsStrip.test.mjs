import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);
const manifestUrl = new URL('packages/agents/src/manifest.ts', repoRoot);

function readAgentIds(source) {
  const block = source.match(/export const AGENTS_CORE = \{([\s\S]*?)^\}/mu);
  assert.ok(block, 'expected the shared agent manifest to declare AGENTS_CORE');
  return [...block[1].matchAll(/^    ([A-Za-z0-9_]+): \{$/gmu)]
    .map((entry) => entry[1])
    .filter((agentId) => agentId !== 'customAcp');
}

function readRenderedAgentIds(svg) {
  return [...svg.matchAll(/^  <!-- ([A-Za-z0-9_]+) -->$/gmu)].map((entry) => entry[1]);
}

test('generates both supported-agent strips in shared manifest order', async () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/generateSupportedAgentsStrip.mjs'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifestIds = readAgentIds(await readFile(manifestUrl, 'utf8'));
  for (const variant of ['light', 'dark']) {
    const svg = await readFile(new URL(`.github/supported-agents-${variant}.svg`, repoRoot), 'utf8');
    assert.deepEqual(readRenderedAgentIds(svg), manifestIds);
  }
});
