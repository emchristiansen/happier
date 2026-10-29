import { existsSync, mkdirSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { runCommandCapture } from '@happier-dev/cli-common/process';
import { installProviderCli } from '@happier-dev/cli-common/providers';

import { cliCapability as claudeCliCapability } from '@/backends/claude/cli/capability';
import { createDeferred } from '@/testkit/async/deferred';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { withProviderCliUpdates } from './providerCliUpdates';

const SCOPED_ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'HAPPIER_HOME_DIR', 'HAPPIER_CLAUDE_PATH'] as const;

function writeClaudeVersion(dir: string, version: string, options: { startupSeconds?: number } = {}): string {
  const path = join(dir, version);
  mkdirSync(dir, { recursive: true });
  // Use the test runtime directly: the deliberately minimal fixture PATH may not contain sleep.
  writeFileSync(path, `#!${process.execPath}
setTimeout(() => process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)}), ${(options.startupSeconds ?? 0) * 1_000});
`, { mode: 0o755 });
  return path;
}

/**
 * The real detect path (daemon PATH resolution, `--version` probe, snapshot cache)
 * against real executables; only the vendor updater process is replaced, by one that
 * does what `claude update` does: install a new version and re-point the launcher.
 */
describe.skipIf(process.platform === 'win32')('withProviderCliUpdates with the real detect path', () => {
  let envBaseline: Record<string, string | undefined>;
  let root: string;
  let home: string;
  let versionsDir: string;
  let launcher: string;

  beforeEach(() => {
    envBaseline = snapshotEnvValues(SCOPED_ENV_KEYS);
    root = createTempDirSync('happier-provider-cli-updates-real-detect-');
    home = join(root, 'home');
    versionsDir = join(home, '.local', 'share', 'claude', 'versions');
    const binDir = join(home, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    launcher = join(binDir, 'claude');
    symlinkSync(writeClaudeVersion(versionsDir, '2.1.282'), launcher);
    applyEnvValues({
      HOME: home,
      USERPROFILE: home,
      HAPPIER_HOME_DIR: home,
      PATH: `${binDir}:/usr/bin:/bin`,
      HAPPIER_CLAUDE_PATH: undefined,
    });
  });

  afterEach(() => {
    restoreEnvValues(envBaseline);
    removeTempDirSync(root);
  });

  it('verifies a native update that re-points the launcher to the new version', async () => {
    const runCommand: typeof runCommandCapture = async () => {
      const next = writeClaudeVersion(versionsDir, '2.1.283');
      rmSync(launcher);
      symlinkSync(next, launcher);
      return { kind: 'exited', status: 0, signal: null, stdout: 'Successfully updated from 2.1.282 to version 2.1.283\n', stderr: '' };
    };
    const cap = withProviderCliUpdates(claudeCliCapability, 'claude', {
      fetchLatestVersion: async () => ({ latestVersion: null, heldVersion: null }),
      installProviderCli: (params) => installProviderCli({ ...params, logDir: join(root, 'logs'), deps: { runCommand } }),
    });

    // The Updates surface detects before offering the action (this primes the snapshot cache).
    await expect(cap.detect({ request: { id: 'cli.claude' }, context: await detectContext() }))
      .resolves.toMatchObject({ version: '2.1.282', installSource: 'native' });

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({ ok: true, result: { previousVersion: '2.1.282', version: '2.1.283' } });

    // The row refresh that follows (an ordinary detect) must see the new version at once.
    await expect(cap.detect({ request: { id: 'cli.claude' }, context: await detectContext() }))
      .resolves.toMatchObject({ version: '2.1.283' });
  });

  it('does not cache an old ordinary snapshot completed after update verification', async () => {
    const held = join(root, 'hold-next-tmux');
    const claimed = join(root, 'tmux-held');
    const release = join(root, 'release-tmux');
    writeFileSync(held, '');
    writeFileSync(join(home, '.local', 'bin', 'tmux'), `#!${process.execPath}
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const held = ${JSON.stringify(held)};
const claimed = ${JSON.stringify(claimed)};
const release = ${JSON.stringify(release)};
if (fs.existsSync(held)) {
  let finished = false;
  const finish = () => {
    if (finished || !fs.existsSync(release)) return;
    finished = true;
    watcher.close();
    process.stdout.write('tmux 3.4\\n');
  };
  const watcher = fs.watch(root, finish);
  fs.renameSync(held, claimed);
  finish();
} else {
  process.stdout.write('tmux 3.4\\n');
}
`, { mode: 0o755 });
    const runCommand: typeof runCommandCapture = async () => {
      const next = writeClaudeVersion(versionsDir, '2.1.283');
      rmSync(launcher);
      symlinkSync(next, launcher);
      return { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
    };
    const cap = withProviderCliUpdates(claudeCliCapability, 'claude', {
      fetchLatestVersion: async () => ({ latestVersion: null, heldVersion: null }),
      installProviderCli: (params) => installProviderCli({ ...params, logDir: join(root, 'logs'), deps: { runCommand } }),
    });
    const holding = createDeferred();
    const watcher = watch(root, () => { if (existsSync(claimed)) holding.resolve(); });
    const oldSnapshot = detectContext();
    try {
      // CLI versions are read before tmux, so this snapshot owns V1 but cannot publish yet.
      await holding.promise;
      await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
        .resolves.toMatchObject({ ok: true, result: { previousVersion: '2.1.282', version: '2.1.283' } });
      writeFileSync(release, '');
      await expect(cap.detect({ request: { id: 'cli.claude' }, context: await oldSnapshot }))
        .resolves.toMatchObject({ version: '2.1.282' });
      // The late old caller may receive V1, but it must not replace the post-update cache.
      await expect(cap.detect({ request: { id: 'cli.claude' }, context: await detectContext() }))
        .resolves.toMatchObject({ version: '2.1.283' });
    } finally {
      writeFileSync(release, '');
      watcher.close();
      await oldSnapshot;
    }
  }, 20_000);

  it('verifies an update whose new executable needs over a second to print its version', async () => {
    // Observed: the managed Copilot launcher (node) takes 0.8–1.2 s for `--version` on a warm,
    // loaded host; right after an install it is slower still.
    const runCommand: typeof runCommandCapture = async () => {
      const next = writeClaudeVersion(versionsDir, '2.1.283', { startupSeconds: 1.6 });
      rmSync(launcher);
      symlinkSync(next, launcher);
      return { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
    };
    const cap = withProviderCliUpdates(claudeCliCapability, 'claude', {
      fetchLatestVersion: async () => ({ latestVersion: null, heldVersion: null }),
      installProviderCli: (params) => installProviderCli({ ...params, logDir: join(root, 'logs'), deps: { runCommand } }),
    });

    await expect(cap.invoke!({ method: 'install', params: { intent: 'update', allowVendorRecipeExecution: true } }))
      .resolves.toMatchObject({ ok: true, result: { previousVersion: '2.1.282', version: '2.1.283' } });
  }, 30_000);
});

async function detectContext() {
  const { buildDetectContext } = await import('@/capabilities/context/buildDetectContext');
  return await buildDetectContext([{ id: 'cli.claude' }]);
}
