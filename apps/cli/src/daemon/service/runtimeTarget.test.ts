import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectPath } from '@/projectPath';

import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn(),
}));

describe('resolveDaemonServiceRuntimeTarget', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    process.argv = [process.execPath, join(projectPath(), 'bin', 'happier.mjs')];
    vi.mocked(fs.existsSync).mockImplementation((path) => String(path) === join(projectPath(), 'package-dist', 'index.mjs'));
  });
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps a source wrapper on its own dist even when a managed CLI is installed', () => {
    vi.stubEnv('HAPPIER_HOME_DIR', '/test-happier-home');
    const entryPath = join(projectPath(), 'dist', 'index.mjs');
    vi.mocked(fs.existsSync).mockImplementation((path) => [
      entryPath,
      '/test-happier-home/cli/current/package-dist/index.mjs',
    ].includes(String(path)));

    expect(resolveDaemonServiceRuntimeTarget({ currentExecPath: process.execPath }).entryPath).toBe(entryPath);
  });

  it('uses the running source checkout dist when no package-dist exists', () => {
    const entryPath = join(projectPath(), 'dist', 'index.mjs');
    vi.mocked(fs.existsSync).mockImplementation((path) => String(path) === entryPath);

    expect(resolveDaemonServiceRuntimeTarget({ currentExecPath: process.execPath })).toEqual({
      nodePath: process.execPath,
      entryPath,
    });
  });

  it('prefers the bundled package-dist entrypoint when the current runtime executable is bun', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/opt/homebrew/bin/bun',
        runtimeExecutable: '/opt/homebrew/bin/bun',
      }),
    ).toEqual({
      nodePath: '/opt/homebrew/bin/bun',
      entryPath: expect.stringContaining('/apps/cli/package-dist/index.mjs'),
    });
  });

  it('prefers the bundled package-dist entrypoint for an explicit managed js runtime wrapper', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        explicitNodePath: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
      }),
    ).toEqual({
      nodePath: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
      entryPath: expect.stringContaining('/apps/cli/package-dist/index.mjs'),
    });
  });

  it('keeps an empty entrypoint for a self-contained binary with no explicit runtime override', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
      }),
    ).toEqual({
      nodePath: '/Applications/Happier.app/Contents/MacOS/happier',
      entryPath: '',
    });
  });
});
