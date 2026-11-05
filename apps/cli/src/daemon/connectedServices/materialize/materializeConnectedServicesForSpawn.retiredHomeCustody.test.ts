import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ConnectedServiceMaterializedHomeCleanupScheduler } from './cleanup/ConnectedServiceMaterializedHomeCleanupScheduler';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'happier-retired-home-custody-'));
  roots.push(root);
  const record = buildConnectedServiceCredentialRecord({
    now: 10, serviceId: 'openai-codex', profileId: 'synthetic', kind: 'oauth', expiresAt: null,
    oauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
  });
  const params = {
    agentId: 'codex' as const, materializationKey: 'retired-home-custody', materializationPurpose: 'probe' as const,
    baseDir: join(root, 'materialized'), activeServerDir: join(root, 'server'),
    recordsByServiceId: new Map([['openai-codex' as const, record]]),
    processEnv: { HOME: root, CODEX_HOME: join(root, 'native') },
    accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {} } },
  };
  return { root, params };
}

/** Fails exactly one unlink whose path matches; every other filesystem operation is real. */
function failOneUnlink(matches: (path: string) => boolean): { failures: () => number } {
  const unlink = fs.unlink;
  let failures = 0;
  vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
    if (failures === 0 && matches(String(path))) {
      failures += 1;
      throw Object.assign(new Error('one synthetic transient unlink EACCES'), { code: 'EACCES' });
    }
    await unlink(path);
  });
  syncBuiltinESMExports();
  return { failures: () => failures };
}

function reconstructedScheduler(baseDir: string) {
  // A fresh owner after restart: default TTLs, and the canonical successor is live.
  return new ConnectedServiceMaterializedHomeCleanupScheduler({
    baseDir, nowMs: () => Date.now(), hasLiveTarget: () => true, listRetainedIdentityIds: () => [],
  });
}

async function readSuccessor(home: string) {
  const auth = join(home, 'codex-home', 'auth.json');
  const credential = await exists(auth) ? { content: await fs.readFile(auth, 'utf8'), ino: (await fs.stat(auth)).ino } : null;
  return { home: (await fs.stat(home)).ino, credential, history: await fs.readFile(join(home, 'history-witness.jsonl'), 'utf8') };
}

describe('retired connected-service home credential custody', () => {
  it.each([
    ['previous', 'retry'], ['previous', 'restart'], ['rejected', 'retry'], ['rejected', 'restart'],
  ] as const)('revokes %s-home credentials after one transient unlink failure via %s, retaining both histories', async (kind, recovery) => {
    const { params } = await fixture();
    const first = (await materializeConnectedServicesForSpawn(params))!;
    const home = first.materializationRoot;
    await fs.writeFile(join(home, 'history-witness.jsonl'), 'old unique history\n');
    const injected = failOneUnlink((path) => path.includes(`codex.${kind}-`) && path.endsWith('/codex-home/auth.json'));

    await expect(materializeConnectedServicesForSpawn({
      ...params,
      validatePromotedMaterialization: async ({ materializationRoot }) => {
        await fs.writeFile(join(materializationRoot, 'history-witness.jsonl'), 'new unique history\n');
        if (kind === 'rejected') throw new Error('synthetic validation rejection');
      },
    })).rejects.toThrow();
    expect(injected.failures()).toBe(1);
    const retiredName = (await fs.readdir(dirname(home))).find((name) => name.startsWith(`codex.${kind}-`));
    expect(retiredName).toBeDefined();
    const retired = join(dirname(home), retiredName!);
    expect(await exists(join(retired, 'codex-home', 'auth.json'))).toBe(true);

    let successor;
    if (recovery === 'retry') {
      // The next successful materialization of the same root owns the earlier retirement.
      successor = (await materializeConnectedServicesForSpawn(params))!;
      await fs.writeFile(join(successor.materializationRoot, 'history-witness.jsonl'), 'successor history\n');
      expect(await exists(join(successor.materializationRoot, 'codex-home', 'auth.json'))).toBe(true);
      expect(await exists(join(retired, 'codex-home', 'auth.json'))).toBe(false);
    } else {
      successor = { materializationRoot: home };
    }
    const successorBefore = await readSuccessor(successor.materializationRoot);
    // A reconstructed cleanup owner discovers the same custody without any in-process handle.
    for (let tick = 0; tick < 2; tick += 1) {
      const scheduler = reconstructedScheduler(params.baseDir);
      await scheduler.reconcileMaterializedHomes();
      await scheduler.cleanupPendingMaterializedHomes();
    }

    expect(await exists(join(retired, 'codex-home', 'auth.json'))).toBe(false);
    await expect(fs.readFile(join(retired, 'history-witness.jsonl'), 'utf8')).resolves.toBe(
      kind === 'previous' ? 'old unique history\n' : 'new unique history\n',
    );
    // Every history byte string survives somewhere; the live successor is untouched.
    const histories = [];
    for (const name of await fs.readdir(dirname(home))) {
      if (await exists(join(dirname(home), name, 'history-witness.jsonl'))) {
        histories.push(await fs.readFile(join(dirname(home), name, 'history-witness.jsonl'), 'utf8'));
      }
    }
    expect(histories).toEqual(expect.arrayContaining(['old unique history\n', 'new unique history\n']));
    expect(await readSuccessor(successor.materializationRoot)).toEqual(successorBefore);
  }, 30_000);

  it('does not revoke a claimed previous home while its promotion can still roll back', async () => {
    const { params } = await fixture();
    const first = (await materializeConnectedServicesForSpawn(params))!;
    const auth = join(first.materializationRoot, 'codex-home', 'auth.json');
    const before = await fs.readFile(auth, 'utf8');
    let reconcile: Promise<unknown> | undefined;
    await expect(materializeConnectedServicesForSpawn({
      ...params,
      validatePromotedMaterialization: async () => {
        // A cleanup owner ticks while the old home is a claimed `.previous-*` sibling.
        reconcile = reconstructedScheduler(params.baseDir).reconcileMaterializedHomes();
        await Promise.race([reconcile, new Promise((resolve) => setTimeout(resolve, 500))]);
        throw new Error('synthetic validation rejection');
      },
    })).rejects.toThrow('synthetic validation rejection');
    await reconcile;
    // Rollback restored the old home as the live canonical root, with its credential intact.
    await expect(fs.readFile(auth, 'utf8')).resolves.toBe(before);
  });

  it('does not infer revocation authority from a retired-looking directory name', async () => {
    const { params } = await fixture();
    const first = (await materializeConnectedServicesForSpawn(params))!;
    const lookalike = `${first.materializationRoot}.previous-00000000-0000-4000-8000-000000000000`;
    await fs.mkdir(join(lookalike, 'codex-home'), { recursive: true });
    await fs.writeFile(join(lookalike, 'codex-home', 'auth.json'), 'unowned synthetic credential');
    const scheduler = reconstructedScheduler(params.baseDir);
    await scheduler.reconcileMaterializedHomes();
    await expect(fs.readFile(join(lookalike, 'codex-home', 'auth.json'), 'utf8')).resolves.toBe('unowned synthetic credential');
  });

  it('does not revoke a different directory that later occupies a retired path', async () => {
    const { params } = await fixture();
    const first = (await materializeConnectedServicesForSpawn(params))!;
    failOneUnlink((path) => path.includes('codex.previous-') && path.endsWith('/codex-home/auth.json'));
    await expect(materializeConnectedServicesForSpawn(params)).rejects.toThrow();
    const retiredName = (await fs.readdir(dirname(first.materializationRoot))).find((name) => name.startsWith('codex.previous-'))!;
    const retired = join(dirname(first.materializationRoot), retiredName);
    await fs.rename(retired, `${retired}-moved`);
    await fs.mkdir(join(retired, 'codex-home'), { recursive: true });
    await fs.writeFile(join(retired, 'codex-home', 'auth.json'), 'different synthetic credential');
    const scheduler = reconstructedScheduler(params.baseDir);
    await scheduler.reconcileMaterializedHomes();
    await expect(fs.readFile(join(retired, 'codex-home', 'auth.json'), 'utf8')).resolves.toBe('different synthetic credential');
  });
});

describe('registered onCleanup callback retry', () => {
  it('propagates a transient revocation failure and retries on the next call, retaining history', async () => {
    const { params } = await fixture();
    let release: (() => Promise<void>) | undefined;
    const result = (await materializeConnectedServicesForSpawn({ ...params, onCleanup: (cleanup) => { release = cleanup; } }))!;
    await fs.writeFile(join(result.materializationRoot, 'history-witness.jsonl'), 'cancelled history\n');
    const auth = join(result.env.CODEX_HOME!, 'auth.json');
    const injected = failOneUnlink((path) => path === auth);

    await expect(release!()).rejects.toMatchObject({ code: 'EACCES' });
    expect(await exists(auth)).toBe(true);
    await expect(release!()).resolves.toBeUndefined();
    expect(injected.failures()).toBe(1);
    expect(await exists(auth)).toBe(false);
    await expect(fs.readFile(join(result.materializationRoot, 'history-witness.jsonl'), 'utf8')).resolves.toBe('cancelled history\n');
  });

  it('does not revoke a successor home when the callback is retried after replacement', async () => {
    const { params } = await fixture();
    let release: (() => Promise<void>) | undefined;
    const result = (await materializeConnectedServicesForSpawn({ ...params, onCleanup: (cleanup) => { release = cleanup; } }))!;
    await fs.writeFile(join(result.materializationRoot, 'history-witness.jsonl'), 'cancelled history\n');
    const auth = join(result.env.CODEX_HOME!, 'auth.json');
    failOneUnlink((path) => path === auth);
    await expect(release!()).rejects.toMatchObject({ code: 'EACCES' });

    const successor = (await materializeConnectedServicesForSpawn(params))!;
    const successorAuth = join(successor.env.CODEX_HOME!, 'auth.json');
    const before = await fs.readFile(successorAuth, 'utf8');
    await expect(release!()).resolves.toBeUndefined();
    await expect(fs.readFile(successorAuth, 'utf8')).resolves.toBe(before);
    const retiredName = (await fs.readdir(dirname(result.materializationRoot))).find((name) => name.startsWith('codex.previous-'))!;
    await expect(fs.readFile(join(dirname(result.materializationRoot), retiredName, 'history-witness.jsonl'), 'utf8')).resolves.toBe('cancelled history\n');
    expect(await exists(join(dirname(result.materializationRoot), retiredName, 'codex-home', 'auth.json'))).toBe(false);
  });
});
