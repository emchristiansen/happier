import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

describe('materializeConnectedServicesForSpawn atomicity', () => {
  afterEach(() => {
    vi.doUnmock('@/backends/catalog');
    vi.doUnmock('@/utils/fs/replaceDirectoryAtomically');
    vi.resetModules();
  });

  it('cleans only the staging attempt root when provider materialization fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-atomicity-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-atomicity-server-'));
    const activeRoot = join(baseDir, normalizeMaterializationKeyForPath('session-live'), 'codex');
    await mkdir(join(activeRoot, 'codex-home'), { recursive: true });
    await writeFile(join(activeRoot, 'codex-home', 'auth.json'), '{"access_token":"live"}\n');

    vi.doMock('@/backends/catalog', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/backends/catalog')>(),
      getConnectedServiceMaterializer: async () => async (params: { rootDir: string; cleanupRoot: () => void }) => {
        await mkdir(join(params.rootDir, 'codex-home'), { recursive: true });
        await writeFile(join(params.rootDir, 'codex-home', 'auth.json'), '{"access_token":"attempt"}\n');
        params.cleanupRoot();
        throw new Error('materialization failed');
      },
    }));

    const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-test', providerAccountId: null, providerEmail: null },
    });

    await expect(materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-live',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
    })).rejects.toThrow('materialization failed');

    await expect(readFile(join(activeRoot, 'codex-home', 'auth.json'), 'utf8')).resolves.toContain('live');
  });

  it('serializes full materialization work for the same final target root', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-late-materialization-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-late-materialization-server-'));
    const activeRoot = join(baseDir, normalizeMaterializationKeyForPath('session-live'), 'codex');

    let releaseFirst!: () => void;
    let firstEntered!: Promise<void>;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    firstEntered = new Promise<void>((resolve) => {
      vi.doMock('@/backends/catalog', async (importOriginal) => ({
        ...await importOriginal<typeof import('@/backends/catalog')>(),
        getConnectedServiceMaterializer: async () => async (params: {
          rootDir: string;
          processEnv?: NodeJS.ProcessEnv;
          cleanupRoot: () => void;
        }) => {
          const label = String(params.processEnv?.HAPPIER_TEST_MATERIALIZATION_LABEL ?? '');
          if (label === 'A') {
            resolve();
            await firstRelease;
          }
          await mkdir(join(params.rootDir, 'codex-home'), { recursive: true });
          await writeFile(join(params.rootDir, 'history.jsonl'), `history:${label}\n`);
          await writeFile(join(params.rootDir, 'codex-home', 'auth.json'), `{"access_token":"${label}"}\n`);
          return {
            env: {
              HAPPIER_TEST_AUTH_FILE: join(params.rootDir, 'codex-home', 'auth.json'),
            },
            cleanupOnFailure: params.cleanupRoot,
            cleanupOnExit: null,
          };
        },
      }));
    });

    const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-test', providerAccountId: null, providerEmail: null },
    });
    const common = {
      agentId: 'codex' as const,
      materializationKey: 'session-live',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex' as const, record]]),
    };

    const first = materializeConnectedServicesForSpawn({
      ...common,
      processEnv: { HAPPIER_TEST_MATERIALIZATION_LABEL: 'A' },
    });
    await firstEntered;

    const second = materializeConnectedServicesForSpawn({
      ...common,
      processEnv: { HAPPIER_TEST_MATERIALIZATION_LABEL: 'B' },
    });
    const observedBeforeRelease = await Promise.race([
      second.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    expect(observedBeforeRelease).toBe('pending');

    releaseFirst();
    const firstResult = await first;
    expect(firstResult).toMatchObject({
      env: expect.objectContaining({
        HAPPIER_TEST_AUTH_FILE: join(activeRoot, 'codex-home', 'auth.json'),
      }),
    });
    await expect(second).resolves.toMatchObject({
      env: expect.objectContaining({
        HAPPIER_TEST_AUTH_FILE: join(activeRoot, 'codex-home', 'auth.json'),
      }),
    });
    await expect(readFile(join(activeRoot, 'codex-home', 'auth.json'), 'utf8')).resolves.toContain('B');
    const retired = (await readdir(dirname(activeRoot))).find((entry) => entry.startsWith('codex.previous-'));
    expect(retired).toBeDefined();
    expect(await readFile(join(dirname(activeRoot), retired!, 'history.jsonl'), 'utf8')).toBe('history:A\n');
    await expect(readFile(join(dirname(activeRoot), retired!, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await firstResult!.cleanupMaterializationRoot();
    // A late old-run callback must not revoke a successor's current credentials.
    await expect(readFile(join(activeRoot, 'codex-home', 'auth.json'), 'utf8')).resolves.toContain('B');
  });

  it('serializes env-only promotion attempts for the same final target root', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-promotion-race-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-promotion-race-server-'));
    const attemptRootByLabel = new Map<string, string>();

    let releaseFirstPromotion!: () => void;
    let firstReachedPromotion!: Promise<void>;
    const firstPromotionRelease = new Promise<void>((resolve) => {
      releaseFirstPromotion = resolve;
    });
    firstReachedPromotion = new Promise<void>((resolve) => {
      vi.doMock('@/utils/fs/replaceDirectoryAtomically', () => ({
        replaceDirectoryAtomically: async (params: {
          stagedDir: string;
          targetDir: string;
          afterPromote?: () => Promise<void> | void;
        }) => {
          await mkdir(dirname(params.targetDir), { recursive: true });
          if (params.stagedDir === attemptRootByLabel.get('A')) {
            resolve();
            await firstPromotionRelease;
          }
          await rm(params.targetDir, { recursive: true, force: true });
          await rename(params.stagedDir, params.targetDir);
          await params.afterPromote?.();
        },
      }));
    });
    vi.doMock('@/backends/catalog', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/backends/catalog')>(),
      getConnectedServiceMaterializer: async () => async (params: {
        rootDir: string;
        processEnv?: NodeJS.ProcessEnv;
      }) => {
        const label = String(params.processEnv?.HAPPIER_TEST_MATERIALIZATION_LABEL ?? '');
        attemptRootByLabel.set(label, params.rootDir);
        await mkdir(join(params.rootDir, 'codex-home'), { recursive: true });
        return {
          env: {
            HAPPIER_TEST_ENV_ONLY_LABEL: label,
          },
          cleanupOnFailure: null,
          cleanupOnExit: null,
        };
      },
    }));

    const { materializeConnectedServicesForSpawn } = await import('./materializeConnectedServicesForSpawn');
    const common = {
      agentId: 'codex' as const,
      materializationKey: 'session-env-only',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map(),
    };

    const first = materializeConnectedServicesForSpawn({
      ...common,
      processEnv: { HAPPIER_TEST_MATERIALIZATION_LABEL: 'A' },
    });
    await firstReachedPromotion;

    const second = materializeConnectedServicesForSpawn({
      ...common,
      processEnv: { HAPPIER_TEST_MATERIALIZATION_LABEL: 'B' },
    });
    const observedBeforeRelease = await Promise.race([
      second.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    expect(observedBeforeRelease).toBe('pending');
    releaseFirstPromotion();

    await expect(first).resolves.toMatchObject({
      env: expect.objectContaining({
        HAPPIER_TEST_ENV_ONLY_LABEL: 'A',
      }),
    });
    await expect(second).resolves.toMatchObject({
      env: expect.objectContaining({
        HAPPIER_TEST_ENV_ONLY_LABEL: 'B',
      }),
    });
  });
});
