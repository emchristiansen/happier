import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can npm-release in dry-run using env-only secrets', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-release',
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NPM_TOKEN: 'npm-token',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm release: channel=preview/);
  assert.match(out, /scripts\/pipeline\/npm\/release-packages\.mjs/);
  assert.match(out, /apps\/cli/);
});

test('npm-release local preview suffix starts at the first unpublished rolling version when no versions exist', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-release',
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'true',
      '--publish-server',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NPM_TOKEN: 'npm-token',
        GITHUB_RUN_NUMBER: '',
        GITHUB_RUN_ATTEMPT: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.doesNotMatch(out, /-preview\.0\.1\b/, 'rolling preview allocation must never publish run zero');
  assert.match(out, /-preview\.1\b/, 'first rolling preview version should start from the published-version allocator');
});
