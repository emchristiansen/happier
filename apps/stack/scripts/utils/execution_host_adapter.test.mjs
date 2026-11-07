import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runCommandCapture } from '../testkit/core/run_node_capture.mjs';

import { resolveExecutionHostController, runExecutionHostAdapter } from './execution_host_adapter.mjs';

test('0.2 execution-host adapter is absent by default and ignores Linux and guarded re-entry', () => {
  const fileOps = { existsSync: () => false, readFileSync: () => '' };
  assert.equal(resolveExecutionHostController({ env: {}, platform: 'darwin', fileOps }), null);
  assert.equal(resolveExecutionHostController({
    env: { HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY: '1' },
    platform: 'darwin',
    fileOps,
  }), null);
  assert.equal(resolveExecutionHostController({ env: {}, platform: 'linux', fileOps }), null);
});

test('0.2 adapter delegates only to the controller entrypoint materialized by 0.3', async () => {
  const calls = [];
  const controller = '/Users/dev/happier/dev/apps/stack/scripts/execution_host_bridge.mjs';
  const resolved = resolveExecutionHostController({
    env: { HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack' },
    platform: 'darwin',
    fileOps: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ version: 2, controllerEntrypoint: controller }),
    },
  });
  assert.equal(resolved, controller);

  const outcome = await runExecutionHostAdapter({
    controllerEntrypoint: resolved,
    localEntrypoint: '/Users/dev/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    stackName: 'repo-remote-dev-d72117acdb',
    argv: ['tui', '--json'],
    cwd: '/Users/dev/happier/remote-dev',
    env: { PATH: '/usr/bin' },
    boundary: {
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return {
          once(event, listener) {
            if (event === 'close') queueMicrotask(() => listener(19, null));
            return this;
          },
          kill() {},
        };
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(outcome, { exitCode: 19, signal: null });
  assert.deepEqual(calls[0].args, [
    controller,
    '--workspace-id=0.2',
    '--local-entrypoint=/Users/dev/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    '--', 'tui', '--json',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.HAPPIER_STACK_STACK, 'repo-remote-dev-d72117acdb');
});

test('0.2 adapter fails closed when the configured 0.3 controller profile is malformed', () => {
  assert.throws(() => resolveExecutionHostController({
    env: { HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack' },
    platform: 'darwin',
    fileOps: { existsSync: () => true, readFileSync: () => '{broken' },
  }), /failed to read execution-host controller/);
});

test('0.2 yarn dev-vm reaches the same controller with the SSH primary assignment contract', async (t) => {
  const fixture = await createTempFixture(t);
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/\/$/, '');
  const controller = fixture.path('controller.mjs');
  const platform = fixture.path('mac-platform.mjs');
  const home = fixture.path('home');
  await mkdir(home);
  // The external 0.3 program and OS platform are the genuine boundaries here;
  // the root Yarn command, repo-local wrapper and 0.2 adapter run unchanged.
  await writeFile(platform, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
  await writeFile(controller, "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n");
  await writeFile(join(home, 'execution-host.json'), JSON.stringify({
    version: 2, mode: 'ssh-dev-target', activation: 'active',
    sshPrimary: { targetName: 'nl2', stackName: 'lane' }, controllerEntrypoint: controller,
  }));
  const before = await readFile(join(home, 'execution-host.json'), 'utf8');
  const result = await runCommandCapture('corepack', ['yarn', '-s', 'dev-vm', 'primary', 'assign', 'nl2', '--stack=lane', '--json'], {
    cwd: repoRoot,
    env: { ...process.env, NODE_OPTIONS: `--import=${platform}`, HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_INVOKED_CWD: repoRoot,
      HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY: '', HAPPIER_STACK_REPO_LOCAL_AUTO_INSTALL: '0' },
  });
  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(observed.cwd, repoRoot);
  assert.deepEqual(observed.argv, ['--workspace-id=0.2',
    `--local-entrypoint=${join(repoRoot, 'apps/stack/scripts/repo_local.mjs')}`,
    '--', 'dev-vm', 'primary', 'assign', 'nl2', '--stack=lane', '--json']);
  assert.equal(await readFile(join(home, 'execution-host.json'), 'utf8'), before);
});
