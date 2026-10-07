import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkspaceBuildArgs,
  runWorkspacePackageBuild,
} from './ensureWorkspacePackagesBuiltCli.mjs';

test('parses package names and component-owned workspace admission without duplicating either owner', () => {
  assert.deepEqual(
    parseWorkspaceBuildArgs([
      '@happier-dev/cli-common',
      '@happier-dev/cli-common',
      '--for-component=apps/website',
    ]),
    {
      packageNames: ['@happier-dev/cli-common', '@happier-dev/cli-common'],
      componentDirs: ['apps/website'],
    },
  );
  assert.throws(() => parseWorkspaceBuildArgs(['--for-component=']), /requires a repository-relative path/u);
  assert.throws(() => parseWorkspaceBuildArgs(['--unknown']), /Unknown workspace build option/u);
});

test('delegates de-duplicated requests to the existing workspace build owners', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    packageNames: ['@happier-dev/cli-common', '@happier-dev/cli-common'],
    componentDirs: ['apps/website', 'apps/website'],
    ensureWorkspacePackagesBuiltByNameImpl: async (root, names) => {
      calls.push(['packages', root, names]);
      return { ok: true, built: ['cli-common'], skipped: [] };
    },
    ensureWorkspacePackagesBuiltForComponentImpl: async (dir) => {
      calls.push(['component', dir]);
      return { ok: true, built: ['brand'], skipped: [] };
    },
  });

  assert.deepEqual(calls, [
    ['packages', '/repo', ['@happier-dev/cli-common']],
    ['component', '/repo/apps/website'],
  ]);
  assert.deepEqual(result, { ok: true, built: ['cli-common', 'brand'], skipped: [] });
});

test('rejects an empty invocation instead of reporting a vacuous build', async () => {
  await assert.rejects(runWorkspacePackageBuild(), /requires at least one workspace package name or component/u);
});
