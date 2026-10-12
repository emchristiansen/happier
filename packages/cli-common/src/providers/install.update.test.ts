import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { runCommandCapture } from '../process/index.js';
import { installProviderCli } from './install.js';
import { resolveProviderCliManagedCommandPath } from './resolution.js';

type SpawnSyncMockFn = (
  command: string,
  args?: ReadonlyArray<string>,
  options?: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

function succeededSpawn(): SpawnSyncReturns<Buffer> {
  return {
    pid: 0,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

function runCommandFrom(mock: SpawnSyncMockFn): typeof runCommandCapture {
  return async ({ cmd, args, cwd, env }) => {
    const result = mock(cmd, args, { cwd, env });
    return { kind: 'exited', status: result.status, signal: result.signal, stdout: '', stderr: '' };
  };
}

function writeExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  return path;
}

describe.skipIf(process.platform === 'win32')('installProviderCli update intent', () => {
  let root: string;
  let home: string;
  let logDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-provider-cli-install-update-'));
    home = join(root, 'home');
    logDir = join(root, 'logs');
    mkdirSync(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function nativeClaudeLauncher(): string {
    const versioned = writeExecutable(join(home, '.local', 'share', 'claude', 'versions', '2.1.0'));
    const launcher = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(versioned, launcher);
    return launcher;
  }

  it('runs the vendor updater against the resolved native executable only after consent', async () => {
    const launcher = nativeClaudeLauncher();
    const spawnSyncMock = vi.fn<SpawnSyncMockFn>(() => succeededSpawn());
    const base = {
      providerId: 'claude' as const,
      platform: 'linux' as const,
      intent: 'update' as const,
      updateTarget: { command: launcher, source: 'system' as const },
      env: { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' },
      logDir,
      deps: { runCommand: runCommandFrom(spawnSyncMock) },
    };

    const refused = await installProviderCli(base);
    expect(refused).toMatchObject({ ok: false, errorCode: 'vendor-recipe-disallowed' });
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const updated = await installProviderCli({ ...base, allowVendorRecipeExecution: true });
    expect(updated).toMatchObject({ ok: true, alreadyInstalled: false });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(launcher);
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(['update']);
  });

  it('refuses to update a package-manager install and names the owner command', async () => {
    const packageBin = writeExecutable(join(root, 'prefix', 'lib', 'node_modules', 'opencode-ai', 'bin', 'opencode'));
    const shim = join(root, 'prefix', 'bin', 'opencode');
    mkdirSync(join(root, 'prefix', 'bin'), { recursive: true });
    symlinkSync(packageBin, shim);
    const spawnSyncMock = vi.fn<SpawnSyncMockFn>(() => succeededSpawn());

    const result = await installProviderCli({
      providerId: 'opencode',
      platform: 'linux',
      intent: 'update',
      updateTarget: { command: shim, source: 'system' },
      allowVendorRecipeExecution: true,
      env: { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' },
      logDir,
      deps: { runCommand: runCommandFrom(spawnSyncMock) },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'update-not-available' });
    if (result.ok) return;
    expect(result.errorMessage).toContain('npm install -g opencode-ai@latest');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('reinstalls a Happier-managed CLI through the managed owner even though it is already installed', async () => {
    const env = { HOME: home, HAPPIER_HOME_DIR: home, PATH: '' };
    const managedCommand = writeExecutable(resolveProviderCliManagedCommandPath('gemini', { processEnv: env }));
    const spawnSyncMock = vi.fn<SpawnSyncMockFn>(() => succeededSpawn());

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      intent: 'update',
      updateTarget: { command: managedCommand, source: 'managed' },
      env,
      logDir,
      deps: {
        ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
        ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
        runCommand: runCommandFrom(spawnSyncMock),
      },
    });

    expect(result).toMatchObject({ ok: true, alreadyInstalled: false, plan: { installMode: 'managed_package' } });
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['add', '@google/gemini-cli']));
  });
});
