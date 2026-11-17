import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { removeTempDir } from '@/testkit/fs/tempDir';
import { resolveConnectedServiceSelectionHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { createCodexConnectedServicesMaterializer } from './createCodexConnectedServicesMaterializer';
import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';

const sharedSettings = {
  connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {} },
};

function record(accessToken: string) {
  return buildConnectedServiceCredentialRecord({
    now: 2_000_000_000_000, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
    oauth: {
      accessToken, refreshToken: 'synthetic-refresh', idToken: null, scope: null, tokenType: null,
      providerAccountId: 'synthetic', providerEmail: null,
    },
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ kind: 'success'; value: T } | { kind: 'error'; code: unknown; error: unknown }> {
  try {
    return { kind: 'success', value: await promise };
  } catch (error) {
    return { kind: 'error', code: (error as { code?: unknown })?.code, error };
  }
}

async function exists(path: string): Promise<boolean> {
  return await readdir(path).then(() => true, () => false);
}

/**
 * Codex provenance boundary through the real auth materializer, home sync, manifest I/O, locks and
 * canonical group selection. Malformed provenance is written raw to disk, never through the manifest
 * writer (which normalizes it away).
 */
describe('Codex connected-service home native source provenance boundary', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await removeTempDir(root);
  });

  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'codex-provenance-'));
    roots.push(dir);
    const source = join(dir, 'source');
    await mkdir(source);
    await writeFile(join(source, 'AGENTS.md'), 'synthetic config');
    const rootDir = join(dir, 'target');
    return { dir, source, rootDir, home: join(rootDir, 'codex-home') };
  }

  describe('SP-CX1: conflict refusal precedes source locking', () => {
    it('refuses a conflicting absent source without creating it or its parent', async () => {
      const f = await fixture();
      await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      });
      const authBefore = await readFile(join(f.home, 'auth.json'), 'utf8');
      const rejectedParent = join(f.dir, 'not-admitted');
      const result = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: join(rejectedParent, 'absent-source') },
      }));
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_conflict' });
      expect(await exists(rejectedParent)).toBe(false);
      expect(await readdir(f.dir)).not.toContain('not-admitted.happier-state-sharing.lock');
      expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(authBefore);
      expect(await readlink(join(f.home, 'sessions'))).toBe(join(f.source, 'sessions'));
    });

    it('refuses an existing conflicting source and still shares a same-source home', async () => {
      const f = await fixture();
      await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      });
      const other = join(f.dir, 'other');
      await mkdir(other);
      const otherEntriesBefore = await readdir(other);
      const conflict = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: other },
      }));
      expect(conflict).toMatchObject({ kind: 'error', code: 'connected_service_native_source_conflict' });
      expect(await readdir(other)).toEqual(otherEntriesBefore);
      const same = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('third'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      }));
      expect(same.kind).toBe('success');
    });

    it('refuses a source that conflicts with the session previous home record before creating it', async () => {
      const f = await fixture();
      const previous = await materializeCodexConnectedServiceAuth({
        rootDir: join(f.dir, 'previous'), record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      });
      const rejected = join(f.dir, 'changed-daemon', 'codex');
      const result = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'caller_env',
        previousCodexHome: previous.env.CODEX_HOME,
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: rejected },
      }));
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_conflict' });
      expect(await exists(join(f.dir, 'changed-daemon'))).toBe(false);
      expect(await exists(f.home)).toBe(false);
    });
  });

  describe('SP-CX2: a self-source home is admitted, recorded and conflict-checked', () => {
    it('records a self-source producer so recorded refresh keeps its exact SQLite home', async () => {
      const f = await fixture();
      const sqlite = join(f.dir, 'sqlite');
      const first = await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.home, CODEX_SQLITE_HOME: sqlite },
      });
      expect(first.env).toEqual({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: sqlite });
      expect((await readConnectedServiceStateSharingManifest(f.home)).nativeSourceEnv)
        .toEqual({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: sqlite });
      const refresh = await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'recorded',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: join(f.dir, 'excluded-daemon') },
      });
      expect(refresh.env).toEqual({ CODEX_HOME: f.home, CODEX_SQLITE_HOME: sqlite });
      expect(JSON.parse(await readFile(join(f.home, 'auth.json'), 'utf8')).tokens.access_token).toBe('second');
      expect(await exists(join(f.dir, 'excluded-daemon'))).toBe(false);
    });

    it('refuses a caller naming the recorded destination itself with a different SQLite home', async () => {
      const f = await fixture();
      await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      });
      const manifestBefore = await readFile(join(f.home, '.happier-state-sharing.json'), 'utf8');
      const authBefore = await readFile(join(f.home, 'auth.json'), 'utf8');
      const result = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings,
        processEnv: { CODEX_HOME: f.home, CODEX_SQLITE_HOME: join(f.dir, 'different-sqlite') },
      }));
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_conflict' });
      expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe(authBefore);
      expect(await readFile(join(f.home, '.happier-state-sharing.json'), 'utf8')).toBe(manifestBefore);
      expect(await exists(join(f.dir, 'different-sqlite'))).toBe(false);
    });
  });

  describe('SP-CX3: invalid destination provenance never inherits the previous home record', () => {
    async function groupFixture() {
      const f = await fixture();
      const activeServerDir = join(f.dir, 'server');
      const create = createCodexConnectedServicesMaterializer();
      const common = {
        agentId: 'codex' as const, activeServerDir, rootDir: join(f.dir, 'attempt'),
        accountSettings: sharedSettings, cleanupRoot: () => {},
      };
      const previous = await create({
        ...common, nativeSourceAuthority: 'caller_env', processEnv: { CODEX_HOME: f.source },
        recordsByServiceId: new Map([['openai-codex' as const, record('first')]]),
      });
      const selection = {
        kind: 'group' as const, serviceId: 'openai-codex' as const, groupId: 'team', activeProfileId: 'work',
        fallbackProfileId: 'work', generation: 1, record: record('second'), policy: null,
      };
      const target = join(resolveConnectedServiceSelectionHomeDir({
        activeServerDir, serviceId: 'openai-codex', agentId: 'codex', fallbackProfileId: 'work', selection,
      }), 'codex-home');
      const other = join(f.dir, 'other-source');
      await mkdir(other);
      await writeFile(join(other, 'AGENTS.md'), 'other');
      const produceGroupFrom = async (source: string) => await create({
        ...common, nativeSourceAuthority: 'caller_env', processEnv: { CODEX_HOME: source },
        recordsByServiceId: new Map([['openai-codex' as const, record('first')]]),
        selectionsByServiceId: new Map([['openai-codex' as const, selection]]),
      });
      const rematerializeGroup = async () => await settle(create({
        ...common, nativeSourceAuthority: 'recorded', processEnv: { CODEX_HOME: join(f.dir, 'excluded-daemon') },
        previousMaterializedRoot: previous!.targetMaterializedRoot,
        recordsByServiceId: new Map([['openai-codex' as const, record('second')]]),
        selectionsByServiceId: new Map([['openai-codex' as const, selection]]),
      }));
      return { ...f, target, other, produceGroupFrom, rematerializeGroup };
    }

    it('lets a fresh canonical group home inherit the valid previous source', async () => {
      const g = await groupFixture();
      const result = await g.rematerializeGroup();
      expect(result.kind).toBe('success');
      expect(await readlink(join(g.target, 'sessions'))).toBe(join(g.source, 'sessions'));
      expect((await readConnectedServiceStateSharingManifest(g.target)).nativeSourceEnv?.CODEX_HOME).toBe(g.source);
      expect(await exists(join(g.dir, 'excluded-daemon'))).toBe(false);
    });

    it('refuses a group home validly recorded from a conflicting source', async () => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_conflict' });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
    });

    it.each([
      ['relative SQLite home', (other: string) => JSON.stringify({ v: 1, nativeSourceEnv: { CODEX_HOME: other, CODEX_SQLITE_HOME: 'relative' } })],
      ['missing SQLite field', (other: string) => JSON.stringify({ v: 1, nativeSourceEnv: { CODEX_HOME: other } })],
      ['invalid JSON', () => 'not json'],
      ['unsupported version', (other: string) => JSON.stringify({ v: 2, nativeSourceEnv: { CODEX_HOME: other, CODEX_SQLITE_HOME: other } })],
    ] as const)('refuses an occupied group home whose raw provenance has a %s', async (_label, raw) => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      const manifestPath = join(g.target, '.happier-state-sharing.json');
      const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
      const rawManifest = raw(g.other);
      await writeFile(manifestPath, rawManifest.startsWith('{')
        ? JSON.stringify({ ...existing, ...JSON.parse(rawManifest) })
        : rawManifest);
      const manifestBefore = await readFile(manifestPath, 'utf8');
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const linkBefore = await readlink(join(g.target, 'sessions'));
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_invalid' });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
      expect(await readlink(join(g.target, 'sessions'))).toBe(linkBefore);
      expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(await exists(join(g.dir, 'excluded-daemon'))).toBe(false);
    });

    it('refuses an occupied legacy group home that records no source rather than inheriting the previous one', async () => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      const manifestPath = join(g.target, '.happier-state-sharing.json');
      const { nativeSourceEnv: _recorded, ...legacy } = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(manifestPath, JSON.stringify(legacy));
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_unrecorded' });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
    });

    it('lets an existing but empty group home inherit the valid previous source', async () => {
      const g = await groupFixture();
      await mkdir(g.target, { recursive: true });
      const result = await g.rematerializeGroup();
      expect(result.kind).toBe('success');
      expect(await readlink(join(g.target, 'sessions'))).toBe(join(g.source, 'sessions'));
      expect((await readConnectedServiceStateSharingManifest(g.target)).nativeSourceEnv?.CODEX_HOME).toBe(g.source);
    });

    // SP-CX4: a missing or dangling manifest does not make an occupied home fresh.
    it.each([
      ['no manifest entry', 'unrecorded'],
      ['a dangling manifest link', 'invalid'],
    ] as const)('refuses an occupied group home with %s instead of inheriting the previous source', async (label, kind) => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      const manifestPath = join(g.target, '.happier-state-sharing.json');
      await rm(manifestPath);
      if (label === 'a dangling manifest link') await symlink(join(g.dir, 'missing-record'), manifestPath);
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const linkBefore = await readlink(join(g.target, 'sessions'));
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: `connected_service_native_source_${kind}` });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
      expect(await readlink(join(g.target, 'sessions'))).toBe(linkBefore);
      expect(await readdir(g.target)).not.toContain('.happier-state-sharing.json.tmp');
      expect(await exists(join(g.dir, 'excluded-daemon'))).toBe(false);
    });

    it('imports no local state from an occupied manifestless group home into the previous source', async () => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      await rm(join(g.target, '.happier-state-sharing.json'));
      await rm(join(g.target, 'history.jsonl'));
      await writeFile(join(g.target, 'history.jsonl'), 'unknown-origin-history\n');
      await rm(join(g.target, 'sessions'));
      await mkdir(join(g.target, 'sessions'));
      await writeFile(join(g.target, 'sessions', 'unknown.jsonl'), 'unknown-origin-session\n');
      const sourceHistoryBefore = await readFile(join(g.source, 'history.jsonl'), 'utf8').catch(() => null);
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_unrecorded' });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
      expect(await readFile(join(g.source, 'history.jsonl'), 'utf8').catch(() => null)).toBe(sourceHistoryBefore);
      await expect(readFile(join(g.source, 'sessions', 'unknown.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(g.target, 'history.jsonl'), 'utf8')).toBe('unknown-origin-history\n');
    });

    it('refuses a group home whose manifest path is a directory', async () => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      const manifestPath = join(g.target, '.happier-state-sharing.json');
      await rm(manifestPath);
      await mkdir(manifestPath);
      const authBefore = await readFile(join(g.target, 'auth.json'), 'utf8');
      const result = await g.rematerializeGroup();
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_invalid' });
      expect(await readFile(join(g.target, 'auth.json'), 'utf8')).toBe(authBefore);
    });

    it('lets the producing caller re-admit an occupied manifestless home from its own source', async () => {
      const g = await groupFixture();
      await g.produceGroupFrom(g.other);
      await rm(join(g.target, '.happier-state-sharing.json'));
      await g.produceGroupFrom(g.other);
      expect((await readConnectedServiceStateSharingManifest(g.target)).nativeSourceEnv?.CODEX_HOME).toBe(g.other);
    });

    it('refuses when the previous home record itself is invalid', async () => {
      const f = await fixture();
      const previousHome = join(f.dir, 'previous', 'codex-home');
      await materializeCodexConnectedServiceAuth({
        rootDir: join(f.dir, 'previous'), record: record('first'), nativeSourceAuthority: 'caller_env',
        accountSettings: sharedSettings, processEnv: { CODEX_HOME: f.source },
      });
      await writeFile(join(previousHome, '.happier-state-sharing.json'), 'not json');
      const result = await settle(materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'recorded',
        previousCodexHome: previousHome, accountSettings: sharedSettings,
        processEnv: { CODEX_HOME: join(f.dir, 'excluded-daemon') },
      }));
      expect(result).toMatchObject({ kind: 'error', code: 'connected_service_native_source_invalid' });
      expect(await exists(f.home)).toBe(false);
      expect(await exists(join(f.dir, 'excluded-daemon'))).toBe(false);
    });
  });

  it.each([
    ['absent manifest', null, 'connected_service_native_source_unrecorded'],
    ['relative SQLite home', (d: string) => JSON.stringify({ v: 1, nativeSourceEnv: { CODEX_HOME: d, CODEX_SQLITE_HOME: 'relative' } }), 'connected_service_native_source_invalid'],
    ['missing key', (d: string) => JSON.stringify({ v: 1, nativeSourceEnv: { CODEX_HOME: d } }), 'connected_service_native_source_invalid'],
    ['invalid JSON', () => 'not json', 'connected_service_native_source_invalid'],
    ['wrong version', (d: string) => JSON.stringify({ v: 2, nativeSourceEnv: { CODEX_HOME: d, CODEX_SQLITE_HOME: d } }), 'connected_service_native_source_invalid'],
  ] as const)('refuses a recorded rematerialization of a home with %s and no previous home', async (_label, raw, code) => {
    const f = await fixture();
    const daemon = join(f.dir, 'excluded-daemon');
    await mkdir(f.home, { recursive: true });
    await writeFile(join(f.home, 'auth.json'), 'original-auth-bytes');
    if (raw) await writeFile(join(f.home, '.happier-state-sharing.json'), raw(daemon));
    const result = await settle(materializeCodexConnectedServiceAuth({
      rootDir: f.rootDir, record: record('second'), nativeSourceAuthority: 'recorded', processEnv: { CODEX_HOME: daemon },
    }));
    expect(result).toMatchObject({ kind: 'error', code });
    expect(await readFile(join(f.home, 'auth.json'), 'utf8')).toBe('original-auth-bytes');
    expect(await exists(daemon)).toBe(false);
  });

  it('keeps the same source and SQLite home across caller, recorded and caller materializations', async () => {
    const f = await fixture();
    const sqlite = join(f.dir, 'sqlite');
    for (const authority of ['caller_env', 'recorded', 'caller_env'] as const) {
      const result = await materializeCodexConnectedServiceAuth({
        rootDir: f.rootDir, record: record(authority), nativeSourceAuthority: authority, accountSettings: sharedSettings,
        processEnv: authority === 'recorded'
          ? { CODEX_HOME: join(f.dir, 'excluded-daemon') }
          : { CODEX_HOME: f.source, CODEX_SQLITE_HOME: sqlite },
      });
      expect(result.env.CODEX_SQLITE_HOME).toBe(sqlite);
    }
    expect((await readConnectedServiceStateSharingManifest(f.home)).nativeSourceEnv)
      .toEqual({ CODEX_HOME: f.source, CODEX_SQLITE_HOME: sqlite });
    expect(await readlink(join(f.home, 'sessions'))).toBe(join(f.source, 'sessions'));
    expect(await exists(join(f.dir, 'excluded-daemon'))).toBe(false);
  });
});
