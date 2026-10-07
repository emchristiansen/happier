import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliPathExposureEnsureHandler, createCliPathExposureRemoveHandler } from './cliPathExposure.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const tempDirs: string[] = [];

async function createHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'hsetup-cli-path-'));
  tempDirs.push(homeDir);
  return homeDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
});

async function collectResult(
  handler: (params: unknown, context: Readonly<{ signal: AbortSignal }>) => AsyncGenerator<unknown, unknown, void>,
  params: unknown,
) {
  const iterator = handler(params, { signal: new AbortController().signal });
  const events: unknown[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

const LOCAL_PARAMS = { target: { kind: 'local' }, surface: 'desktop.ui', mode: 'user' } as const;

describe('cli.pathExposure system task handlers', () => {
  it('rejects params that target a non-local machine', async () => {
    const handler = createCliPathExposureEnsureHandler();

    await expect(collectResult(handler, { target: { kind: 'remote' } })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});

posixOnly('cli.pathExposure system task handlers (POSIX)', () => {
  it('exposes the managed CLI bin dir in the shell profile and removes only that entry again', async () => {
    const homeDir = await createHome();
    const processEnv = { HOME: homeDir, SHELL: '/bin/zsh', HAPPIER_HOME_DIR: join(homeDir, '.happier') };
    const zshrcPath = join(homeDir, '.zshrc');
    await writeFile(zshrcPath, '# mine\n', 'utf8');

    const ensured = await collectResult(createCliPathExposureEnsureHandler({ processEnv }), LOCAL_PARAMS);
    expect(ensured.result).toEqual({
      changed: true,
      shellReloadHint: expect.stringContaining(zshrcPath),
      failure: null,
      existingCommand: null,
    });
    expect(await readFile(zshrcPath, 'utf8')).toContain(`export PATH="${join(homeDir, '.happier', 'bin')}:$PATH"`);

    const removed = await collectResult(createCliPathExposureRemoveHandler({ processEnv }), LOCAL_PARAMS);
    expect(removed.result).toEqual({ removed: true, failure: null });
    expect(await readFile(zshrcPath, 'utf8')).toBe('# mine\n');
  });

  it('surfaces a read-only profile as a named task failure', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const homeDir = await createHome();
    const processEnv = { HOME: homeDir, SHELL: '/usr/bin/fish', HAPPIER_HOME_DIR: join(homeDir, '.happier') };
    const profilePath = join(homeDir, '.profile');
    await writeFile(profilePath, '# locked\n', 'utf8');
    await chmod(profilePath, 0o444);
    try {
      await expect(collectResult(createCliPathExposureEnsureHandler({ processEnv }), LOCAL_PARAMS)).rejects.toMatchObject({
        code: 'cli_path_exposure_failed',
        message: expect.stringContaining(profilePath),
      });
    } finally {
      await chmod(profilePath, 0o644);
    }
  });
});
