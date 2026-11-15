import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceBindingsV1Schema,
  type AccountSettings,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { removeTempDir } from '@/testkit/fs/tempDir';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from '@/daemon/types';
import type { ExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

import { resolveConnectedServiceHomesDir, resolveConnectedServiceSelectionHomeDir } from './homes/resolveConnectedServiceHomeDir';
import { createConnectedServiceMaterializationIdentity } from './materialize/createConnectedServiceMaterializationIdentity';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import {
  DEFAULT_MANIFEST_NAME,
  readConnectedServiceStateSharingManifest,
} from './stateSharing/connectedServiceStateSharingManifest';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import {
  NEW_CALLER_SPAWN_NATIVE_SOURCE,
  resolveExistingSessionSpawnNativeSource,
} from './connectedServiceSpawnNativeSource';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
} from './connectedServiceChildEnvironment';
import { materializeConnectedServicesForSpawn } from './materialize/materializeConnectedServicesForSpawn';
import { buildResolvedSelectionsForTarget } from './refresh/rematerialization';
import type { SpawnTarget } from './refresh/refreshTypes';
import { ConnectedServiceRefreshCoordinator } from './refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import { registerConnectedServiceTrackedSessionTargetsForDaemon } from './startup/runtimeTargetRegistration';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';

/**
 * A connected Codex profile whose persistent home was produced from a retained source R. A fresh
 * managed (daemon) spawn whose daemon environment names an unrelated ambient source A is refused,
 * as before. The requester may instead nominate its own new native source N (home + SQLite) on the
 * profile binding: the spawn then produces a separate home for that profile, bound to exactly N,
 * and never reads, links, imports into or rewrites R, A or the profile's default home. Every later
 * materialization of that session (respawn, account switch) keeps N or is refused.
 *
 * Real spawn resolver, provider materializer, home sync, manifests and locks; server HTTP and the
 * authenticated session read are synthetic. All native sources are private fixture directories.
 */
const { syntheticApi } = vi.hoisted(() => ({ syntheticApi: { current: null as unknown } }));
vi.mock('@/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api')>();
  return { ...actual, ApiClient: { ...actual.ApiClient, create: async () => syntheticApi.current } };
});

const NOW = 2_000_000_000_000;
const credentials = {
  token: 'synthetic',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
} satisfies Credentials;
const sharedSettings = {
  connectedServicesProviderStateSharingSettingsV1: {
    v: 1,
    defaults: { configMode: 'linked', stateMode: 'shared' },
    byAgentId: {},
  },
} as unknown as AccountSettings;

type CodexSource = Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }>;

function oauthRecord(profileId: string, accessToken: string): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: 'openai-codex',
    profileId,
    kind: 'oauth',
    expiresAt: NOW + 3_600_000,
    oauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      idToken: null,
      scope: null,
      tokenType: 'Bearer',
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

function profileBindings(profileId: string, nativeSource?: CodexSource): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected', selection: 'profile', profileId, ...(nativeSource ? { nativeSource } : {}) },
    },
  };
}

function attachContext(metadata: Record<string, unknown> | null): ExistingSessionAttachContext {
  return {
    ok: true,
    attachPayload: {} as ExistingSessionAttachContext['attachPayload'],
    vendorResumeId: null,
    sessionPath: null,
    metadata,
  };
}

const settle = <T>(work: () => Promise<T>) => Promise.resolve().then(work).then(
  (result) => ({ kind: 'applied' as const, result }),
  (error: unknown) => ({ kind: 'failed' as const, message: String(error), error }),
);

/** Every file and directory below `root`, with file bytes: a sentinel that any write or link changes. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        out[`${key}/`] = 'dir';
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        out[key] = 'symlink';
      } else {
        out[key] = await readFile(path, 'utf8');
      }
    }
  };
  await walk(root);
  return out;
}

function defaultCodexHome(profileId: string): string {
  return join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'openai-codex',
    agentId: 'codex',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'codex-home');
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

async function createFixture(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `happier-nominated-codex-${prefix}-`));
  roots.push(dir);
  const records = new Map<string, ConnectedServiceCredentialRecordV1>();
  const api: Record<string, unknown> = {
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async (input: { serviceId: string; profileId: string }) => {
      const record = records.get(`${input.serviceId}/${input.profileId}`);
      return record
        ? { revisionSemantics: 'revisioned' as const, credentialRevision: `csr_${'a'.repeat(22)}`, content: { t: 'plain', v: record } }
        : null;
    },
    getConnectedServiceCredentialSealed: async () => null,
    readConnectedServiceCredentialHealth: async () => ({ kind: 'found' as const, status: 'connected' as const, health: null }),
    updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
  };
  syntheticApi.current = api;

  const source = async (name: string): Promise<CodexSource> => {
    const pair = { CODEX_HOME: join(dir, `${name}-home`), CODEX_SQLITE_HOME: join(dir, `${name}-sqlite`) };
    await mkdir(pair.CODEX_HOME, { recursive: true });
    await mkdir(pair.CODEX_SQLITE_HOME, { recursive: true });
    await writeFile(join(pair.CODEX_HOME, 'AGENTS.md'), `# ${name}\n`);
    await mkdir(join(pair.CODEX_HOME, 'sessions'), { recursive: true });
    await writeFile(join(pair.CODEX_HOME, 'sessions', `${name}-sentinel.jsonl`), `{"source":"${name}"}\n`);
    return pair;
  };

  /** A fresh managed spawn: the daemon is the producing caller and its own environment is `daemonEnv`. */
  const freshDaemonSpawn = async (input: Readonly<{ bindings: unknown; daemonEnv: NodeJS.ProcessEnv }>) => {
    const identity = createConnectedServiceMaterializationIdentity();
    return {
      identity,
      outcome: await settle(() => resolveConnectedServiceAuthForSpawn({
        agentId: 'codex',
        sessionDirectory: dir,
        connectedServicesBindingsRaw: input.bindings,
        materializationKey: identity.id,
        connectedServiceMaterializationIdentityV1: identity,
        activeServerDir: configuration.activeServerDir,
        baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
        credentials,
        api: api as unknown as ApiClient,
        accountSettings: sharedSettings,
        processEnv: input.daemonEnv,
        nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      })),
    };
  };

  /** The daemon's spawn of an existing session, with the source derived from its authenticated read. */
  const daemonSpawn = async (input: Readonly<{
    sessionId: string;
    bindings: unknown;
    identity: ConnectedServiceMaterializationIdentityV1;
    daemonEnv: NodeJS.ProcessEnv;
    persistedMetadata: Record<string, unknown>;
  }>) => await settle(() => resolveConnectedServiceAuthForSpawn({
    agentId: 'codex',
    sessionDirectory: dir,
    connectedServicesBindingsRaw: input.bindings,
    materializationKey: input.identity.id,
    connectedServiceMaterializationIdentityV1: input.identity,
    activeServerDir: configuration.activeServerDir,
    baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
    credentials,
    api: api as unknown as ApiClient,
    sessionId: input.sessionId,
    accountSettings: sharedSettings,
    processEnv: input.daemonEnv,
    nativeSource: resolveExistingSessionSpawnNativeSource({
      existingSessionId: input.sessionId,
      attachContext: attachContext(input.persistedMetadata),
      materializationIdentity: input.identity,
    }),
    existingSessionMetadata: input.persistedMetadata,
  }));

  return { dir, records, api, source, freshDaemonSpawn, daemonSpawn };
}

/**
 * The retained state of the scenario: profile `profile`'s default home was produced from R by an
 * earlier caller, and the daemon's own environment names an unrelated ambient source A.
 */
async function retainedProfileFixture(prefix: string, profile: string) {
  const f = await createFixture(prefix);
  f.records.set(`openai-codex/${profile}`, oauthRecord(profile, `${prefix}-access`));
  const retained = await f.source('retained');
  const ambient = await f.source('ambient');
  const nominated = await f.source('nominated');
  const ambientEnv = { HOME: join(f.dir, 'daemon-home'), ...ambient };

  const produced = await f.freshDaemonSpawn({ bindings: profileBindings(profile), daemonEnv: { HOME: f.dir, ...retained } });
  expect(produced.outcome).toMatchObject({ kind: 'applied' });
  expect((await readConnectedServiceStateSharingManifest(defaultCodexHome(profile))).nativeSourceEnv).toEqual(retained);

  const sentinels = async () => ({
    retained: await snapshotTree(retained.CODEX_HOME),
    retainedSqlite: await snapshotTree(retained.CODEX_SQLITE_HOME),
    ambient: await snapshotTree(ambient.CODEX_HOME),
    ambientSqlite: await snapshotTree(ambient.CODEX_SQLITE_HOME),
    defaultHome: await snapshotTree(defaultCodexHome(profile)),
  });
  return { ...f, profile, retained, ambient, nominated, ambientEnv, sentinels };
}

describe('a fresh managed Codex spawn may nominate its own new native source for a selected profile', () => {
  it('without a nomination, the daemon ambient source still conflicts with the profile home (unchanged guard)', async () => {
    const f = await retainedProfileFixture('unnominated', 'nom-unnominated');
    const before = await f.sentinels();

    const refused = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile), daemonEnv: f.ambientEnv });

    expect(refused.outcome).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(await f.sentinels()).toEqual(before);
  });

  it('a nominated source produces a separate home bound to exactly that pair, touching no retained, ambient or default state', async () => {
    const f = await retainedProfileFixture('fresh', 'nom-fresh');
    const before = await f.sentinels();

    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });

    expect(fresh.outcome).toMatchObject({ kind: 'applied' });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const env = fresh.outcome.result.env;
    const home = env.CODEX_HOME;
    expect(home).toBeTruthy();
    expect(home).not.toBe(defaultCodexHome(f.profile));
    // Still the selected profile's own Codex home tree, never another profile's or a source.
    expect(relative(dirname(defaultCodexHome(f.profile)), home).startsWith('..')).toBe(false);
    expect(env.CODEX_SQLITE_HOME).toBe(f.nominated.CODEX_SQLITE_HOME);
    expect((await readConnectedServiceStateSharingManifest(home)).nativeSourceEnv).toEqual(f.nominated);
    // The new home shares the nominated source's state, not R's or A's.
    expect(await readdir(join(home, 'sessions'))).toEqual(['nominated-sentinel.jsonl']);
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.access_token).toBe('fresh-access');
    expect(await f.sentinels()).toEqual(before);

    // The nomination is part of the session's canonical bindings, so its continuations carry it.
    expect(fresh.outcome.result.connectedServicesBindings.bindingsByServiceId['openai-codex']).toMatchObject({
      source: 'connected', selection: 'profile', profileId: f.profile, nativeSource: f.nominated,
    });
    // ...and of the child's serialized selection, which refresh-driven rematerialization reads.
    const childSelections = readConnectedServiceChildSelectionsFromEnv(env);
    expect(childSelections).toEqual([expect.objectContaining({ kind: 'profile', profileId: f.profile, nativeSource: f.nominated })]);
  });

  it('the composed child environment runs on the nominated home even when the requester also passes CODEX_HOME/CODEX_SQLITE_HOME', async () => {
    const f = await retainedProfileFixture('child-env', 'nom-child-env');
    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const auth = fresh.outcome.result;
    // A runnable stand-in for the Codex CLI, so admission never discovers or runs a host install.
    const stub = join(f.dir, 'codex-cli-stub');
    await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('HAPPIER_CODEX_PATH', stub);

    const child = await resolveSpawnChildEnvironment({
      options: {
        directory: f.dir,
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        environmentVariables: { CODEX_HOME: f.ambient.CODEX_HOME, CODEX_SQLITE_HOME: f.ambient.CODEX_SQLITE_HOME },
        connectedServices: auth.connectedServicesBindings,
      } as Parameters<typeof resolveSpawnChildEnvironment>[0]['options'],
      profileEnvironmentVariables: { CODEX_HOME: f.ambient.CODEX_HOME, CODEX_SQLITE_HOME: f.ambient.CODEX_SQLITE_HOME },
      daemonSpawnHooks: null,
      processEnv: { ...f.ambientEnv, HAPPIER_CODEX_PATH: stub },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: auth,
    });

    expect(child.ok ? 'ok' : `${child.errorCode}: ${child.errorMessage}`).toBe('ok');
    if (!child.ok) return;
    expect(child.extraEnvForChild.CODEX_HOME).toBe(auth.env.CODEX_HOME);
    expect(child.extraEnvForChild.CODEX_SQLITE_HOME).toBe(f.nominated.CODEX_SQLITE_HOME);
    expect(JSON.parse(child.extraEnvForChild[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]!)
      .bindingsByServiceId['openai-codex'].nativeSource).toEqual(f.nominated);
  });

  it('refresh-driven rematerialization of the child reads its serialized nomination and keeps the nominated home', async () => {
    const f = await retainedProfileFixture('refresh', 'nom-refresh');
    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const home = fresh.outcome.result.env.CODEX_HOME;
    const before = await f.sentinels();

    // What the refresh coordinator reads back from the running child's environment.
    const selections = readConnectedServiceChildSelectionsFromEnv(fresh.outcome.result.env);
    const target = {
      agentId: 'codex',
      materializationKey: fresh.identity.id,
      selectionsByServiceId: new Map(selections.map((selection) => [selection.serviceId, selection])),
    } as unknown as SpawnTarget;
    const refreshed = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: fresh.identity.id,
      connectedServiceMaterializationIdentityV1: fresh.identity,
      activeServerDir: configuration.activeServerDir,
      baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      recordsByServiceId: new Map([['openai-codex', oauthRecord(f.profile, 'refreshed-access')]]),
      selectionsByServiceId: buildResolvedSelectionsForTarget(target, new Map([['openai-codex', {
        record: oauthRecord(f.profile, 'refreshed-access'), revisionSemantics: 'legacy_unfenced', credentialRevision: null,
      }]]) as Parameters<typeof buildResolvedSelectionsForTarget>[1]),
      accountSettings: sharedSettings,
      processEnv: f.ambientEnv,
      nativeSourceAuthority: 'recorded',
    });

    expect(refreshed?.env).toMatchObject({ CODEX_HOME: home, CODEX_SQLITE_HOME: f.nominated.CODEX_SQLITE_HOME });
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.access_token).toBe('refreshed-access');
    expect(await f.sentinels()).toEqual(before);
  });

  it('a child selection whose serialized nomination cannot be read is dropped whole, not read as the default home', () => {
    const env = {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile', serviceId: 'openai-codex', profileId: 'p', credentialRevision: null,
        nativeSource: { CODEX_HOME: 'relative', CODEX_SQLITE_HOME: '/abs' },
      }]),
    };
    expect(readConnectedServiceChildSelectionsFromEnv(env)).toEqual([]);
  });

  it('a direct (terminal) launch with the same nomination produces the same nominated home, ignoring its own ambient source', async () => {
    const f = await retainedProfileFixture('direct', 'nom-direct');
    const before = await f.sentinels();
    const stub = join(f.dir, 'codex-cli-stub');
    await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { resolveDirectConnectedServiceEnvironment } = await import('@/cli/connectedServices/resolveDirectConnectedServiceEnvironment');
    vi.stubEnv('HAPPIER_CODEX_PATH', stub);
    for (const [key, value] of Object.entries(f.ambientEnv)) vi.stubEnv(key, value);
    const direct = await settle(() => resolveDirectConnectedServiceEnvironment({
      agentId: 'codex',
      credentials,
      accountSettings: sharedSettings,
      directory: f.dir,
      sessionId: 'session-nominated-direct',
      connectedServices: profileBindings(f.profile, f.nominated),
      sessionMetadata: { connectedServiceMaterializationIdentityV1: createConnectedServiceMaterializationIdentity() },
    }));
    vi.unstubAllEnvs();
    const managed = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });

    expect(direct.kind === 'applied' ? 'applied' : direct.message).toBe('applied');
    if (direct.kind !== 'applied' || managed.outcome.kind !== 'applied' || !managed.outcome.result) return;
    const directEnv = (direct.result as { env?: Record<string, string> }).env ?? {};
    expect(directEnv.CODEX_HOME).toBe(managed.outcome.result.env.CODEX_HOME);
    expect(directEnv.CODEX_SQLITE_HOME).toBe(f.nominated.CODEX_SQLITE_HOME);
    expect(await f.sentinels()).toEqual(before);
  });

  it('the same nomination always reaches the same home; a different pair (home or SQLite) reaches a different one', async () => {
    const f = await retainedProfileFixture('key', 'nom-key');
    const first = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    const again = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    const otherSqlite = { ...f.nominated, CODEX_SQLITE_HOME: join(f.dir, 'other-sqlite') };
    await mkdir(otherSqlite.CODEX_SQLITE_HOME);
    const changed = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, otherSqlite), daemonEnv: f.ambientEnv });

    const homeOf = (o: typeof first) => (o.outcome.kind === 'applied' ? o.outcome.result?.env.CODEX_HOME : null);
    expect(homeOf(first)).toBeTruthy();
    expect(homeOf(again)).toBe(homeOf(first));
    expect(homeOf(changed)).toBeTruthy();
    expect(homeOf(changed)).not.toBe(homeOf(first));
    expect((await readConnectedServiceStateSharingManifest(homeOf(first)!)).nativeSourceEnv).toEqual(f.nominated);
    expect((await readConnectedServiceStateSharingManifest(homeOf(changed)!)).nativeSourceEnv).toEqual(otherSqlite);
  });

  it('a nominated home whose manifest was rewritten to another pair is refused, never re-produced', async () => {
    const f = await retainedProfileFixture('forged', 'nom-forged');
    const first = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (first.outcome.kind !== 'applied' || !first.outcome.result) throw new Error('nominated spawn did not materialize');
    const firstResult = first.outcome.result;
    const home = firstResult.env.CODEX_HOME;
    const manifestPath = join(home, DEFAULT_MANIFEST_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const forged of [
      { ...f.nominated, CODEX_HOME: f.retained.CODEX_HOME },
      { ...f.nominated, CODEX_SQLITE_HOME: f.retained.CODEX_SQLITE_HOME },
    ]) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, nativeSourceEnv: forged }));
      const before = await f.sentinels();
      const refused = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
      expect(refused.outcome).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
      // A continuation keeps the record it finds, but never one that is not the nominated pair.
      const continued = await f.daemonSpawn({
        sessionId: 'session-nominated-forged',
        bindings: firstResult.connectedServicesBindings,
        identity: first.identity,
        daemonEnv: f.ambientEnv,
        persistedMetadata: {
          connectedServiceMaterializationIdentityV1: first.identity,
          connectedServices: firstResult.connectedServicesBindings,
        },
      });
      expect(continued).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
      expect(await f.sentinels()).toEqual(before);
    }
  });

  it('a respawn of the nominated session keeps its source; a changed nomination is refused', async () => {
    const f = await retainedProfileFixture('respawn', 'nom-respawn');
    const sessionId = 'session-nominated-respawn';
    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const home = fresh.outcome.result.env.CODEX_HOME;
    const persistedBindings = fresh.outcome.result.connectedServicesBindings;
    const persistedMetadata = {
      connectedServiceMaterializationIdentityV1: fresh.identity,
      connectedServices: persistedBindings,
    };

    const respawned = await f.daemonSpawn({
      sessionId, bindings: persistedBindings, identity: fresh.identity, daemonEnv: f.ambientEnv, persistedMetadata,
    });
    expect(respawned).toMatchObject({ kind: 'applied' });
    if (respawned.kind !== 'applied') return;
    expect(respawned.result?.env).toMatchObject({ CODEX_HOME: home, CODEX_SQLITE_HOME: f.nominated.CODEX_SQLITE_HOME });

    const other = await f.source('other');
    const before = await f.sentinels();
    const otherBefore = await snapshotTree(other.CODEX_HOME);
    const changed = await f.daemonSpawn({
      sessionId, bindings: profileBindings(f.profile, other), identity: fresh.identity, daemonEnv: f.ambientEnv, persistedMetadata,
    });
    expect(changed).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_unrecorded' } });
    expect(await f.sentinels()).toEqual(before);
    expect(await snapshotTree(other.CODEX_HOME)).toEqual(otherBefore);
    expect((await readConnectedServiceStateSharingManifest(home)).nativeSourceEnv).toEqual(f.nominated);
  });

  it('an account switch of a nominated session that does not carry the nomination is refused, leaving the default home untouched', async () => {
    const f = await retainedProfileFixture('switch', 'nom-switch-a');
    const backup = 'nom-switch-b';
    f.records.set(`openai-codex/${backup}`, oauthRecord(backup, 'backup-access'));
    const sessionId = 'session-nominated-switch';
    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const nominatedBindings = fresh.outcome.result.connectedServicesBindings;
    const home = fresh.outcome.result.env.CODEX_HOME;
    const before = await f.sentinels();
    const backupDefaultBefore = await snapshotTree(defaultCodexHome(backup));

    const switched = await settle(() => materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: f.api as unknown as ApiClient,
      activeServerDir: configuration.activeServerDir,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: sessionId,
          pid: 5401,
          spawnOptions: {
            directory: f.dir,
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            connectedServices: nominatedBindings,
            environmentVariables: { CODEX_HOME: home },
          },
        } as unknown as TrackedSession,
        persistedSessionMetadata: {
          connectedServiceMaterializationIdentityV1: fresh.identity,
          connectedServices: nominatedBindings,
        },
        sessionId,
        agentId: 'codex',
        serviceId: 'openai-codex',
        previous: { source: 'connected', selection: 'profile', serviceId: 'openai-codex', profileId: f.profile },
        next: { source: 'connected', selection: 'profile', serviceId: 'openai-codex', profileId: backup },
        previousBindings: nominatedBindings,
        normalizedBindings: profileBindings(backup),
      } as unknown as Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'],
      accountSettings: sharedSettings,
      processEnv: f.ambientEnv,
    }));

    expect(switched).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(switched.kind === 'failed' ? switched.message : '').toContain('which was not nominated that source');
    expect(await f.sentinels()).toEqual(before);
    expect(await snapshotTree(defaultCodexHome(backup))).toEqual(backupDefaultBefore);
    expect((await readConnectedServiceStateSharingManifest(home)).nativeSourceEnv).toEqual(f.nominated);
  });

  it('a nominated source inside the managed homes tree is refused before any home is produced', async () => {
    const f = await retainedProfileFixture('managed', 'nom-managed');
    const homesBefore = await snapshotTree(resolveConnectedServiceHomesDir({ activeServerDir: configuration.activeServerDir }));
    const before = await f.sentinels();
    const aliased = { CODEX_HOME: defaultCodexHome(f.profile), CODEX_SQLITE_HOME: f.nominated.CODEX_SQLITE_HOME };

    const refused = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, aliased), daemonEnv: f.ambientEnv });

    expect(refused.outcome).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_invalid' } });
    expect(await f.sentinels()).toEqual(before);
    expect(await snapshotTree(resolveConnectedServiceHomesDir({ activeServerDir: configuration.activeServerDir }))).toEqual(homesBefore);
  });
});

describe('the nomination is a typed openai-codex profile binding field', () => {
  const pair = { CODEX_HOME: '/srv/codex/source', CODEX_SQLITE_HOME: '/srv/codex/sqlite' };

  it('accepts an absolute pair on an openai-codex profile binding', () => {
    expect(ConnectedServiceBindingsV1Schema.safeParse(profileBindings('p', pair)).success).toBe(true);
  });

  it.each([
    ['a relative home', { ...pair, CODEX_HOME: 'relative/source' }],
    ['a relative SQLite home', { ...pair, CODEX_SQLITE_HOME: 'sqlite' }],
    ['a missing SQLite home', { CODEX_HOME: pair.CODEX_HOME }],
    ['an extra operand', { ...pair, HOME: '/srv/home' }],
  ])('rejects %s', (_label, nativeSource) => {
    expect(ConnectedServiceBindingsV1Schema.safeParse({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'p', nativeSource } },
    }).success).toBe(false);
  });

  it('rejects it on a group binding and on another service, rather than stripping it', () => {
    expect(ConnectedServiceBindingsV1Schema.safeParse({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'g', nativeSource: pair } },
    }).success).toBe(false);
    expect(ConnectedServiceBindingsV1Schema.safeParse({
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'p', nativeSource: pair } },
    }).success).toBe(false);
  });
});

/**
 * Q-CODEX-NOMINATION-01 (independent review t_9ae6211c/run20885): a direct (terminal) session reports
 * itself to the daemon through the session webhook with its bindings in metadata but without spawn
 * options, so the daemon's runtime target has no serialized child selections. Refresh of that target
 * must still reach the nominated home (or refuse), never the profile's default home.
 */
describe('a daemon-registered nominated session refreshes its nominated home', () => {
  it.each(['metadata-only', 'full-env-control'] as const)('direct-session webhook registration (%s) -> refresh keeps the nomination', async (mode) => {
    const f = await retainedProfileFixture(`registered-${mode}`, `nom-registered-${mode}`);
    const fresh = await f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv });
    if (fresh.outcome.kind !== 'applied' || !fresh.outcome.result) throw new Error('nominated spawn did not materialize');
    const auth = fresh.outcome.result;
    const registry = new ConnectedServiceRuntimeRegistry();
    const webhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map<number, TrackedSession>(),
      pidToAwaiter: new Map(),
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported: (tracked) => {
        if (mode === 'full-env-control') {
          tracked.spawnOptions = {
            directory: f.dir,
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            connectedServices: auth.connectedServicesBindings,
            environmentVariables: auth.env,
            connectedServiceMaterializationIdentityV1: fresh.identity,
          };
        }
        registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry: registry });
      },
    });
    await webhook(`registered-${mode}`, {
      path: f.dir, hostPid: process.pid, startedBy: 'terminal', flavor: 'codex',
      connectedServices: auth.connectedServicesBindings,
      connectedServiceMaterializationIdentityV1: fresh.identity,
    } as Parameters<typeof webhook>[1]);
    const targets = registry.listRefreshTargets();
    expect(targets).toHaveLength(1);
    const target = targets[0]!;
    const before = await f.sentinels();
    const rotated = oauthRecord(f.profile, `rotated-${mode}`);
    const resolved = new Map([['openai-codex', {
      record: rotated, revisionSemantics: 'legacy_unfenced', credentialRevision: null,
    }]]) as Parameters<typeof buildResolvedSelectionsForTarget>[1];
    // The refresh coordinator's own call shape (ConnectedServiceRefreshCoordinator rematerialization).
    const refreshed = await settle(() => materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: target.materializationKey,
      connectedServiceMaterializationIdentityV1: fresh.identity,
      activeServerDir: configuration.activeServerDir,
      baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      recordsByServiceId: new Map([['openai-codex', rotated]]),
      ...(target.selectionsByServiceId.size > 0
        ? { selectionsByServiceId: buildResolvedSelectionsForTarget(target, resolved) }
        : {}),
      accountSettings: sharedSettings,
      processEnv: f.ambientEnv,
      nativeSourceAuthority: 'recorded',
    }));

    expect(await f.sentinels()).toEqual(before);
    expect(refreshed.kind === 'applied' ? refreshed.result?.env : refreshed.message).toMatchObject({
      CODEX_HOME: auth.env.CODEX_HOME, CODEX_SQLITE_HOME: f.nominated.CODEX_SQLITE_HOME,
    });
    expect(JSON.parse(await readFile(join(auth.env.CODEX_HOME, 'auth.json'), 'utf8')).tokens.access_token).toBe(`rotated-${mode}`);
  });
});

/**
 * Q-CODEX-NOMINATION-01 at the public refresh entry point: the daemon's real refresh coordinator, handling
 * an external credential update for the profile, rotates the direct session's nominated home and leaves the
 * profile's default home (produced from R) unchanged, whether or not the daemon holds spawn options.
 */
describe('the daemon refresh coordinator rotates a registered direct session\'s nominated home', () => {
  it.each(['metadata-only', 'full-env-control'] as const)('%s registration', async (mode) => {
    const f = await retainedProfileFixture(`coordinator-${mode}`, `nom-coordinator-${mode}`);
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings(f.profile, f.nominated);
    const stub = join(f.dir, 'codex-cli-stub');
    await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { resolveDirectConnectedServiceEnvironment } = await import('@/cli/connectedServices/resolveDirectConnectedServiceEnvironment');
    vi.stubEnv('HAPPIER_CODEX_PATH', stub);
    for (const [key, value] of Object.entries(f.ambientEnv)) vi.stubEnv(key, value);
    const direct = await settle(() => resolveDirectConnectedServiceEnvironment({
      agentId: 'codex', credentials, accountSettings: sharedSettings, directory: f.dir,
      sessionId: `coordinator-${mode}`, connectedServices: bindings,
      sessionMetadata: { connectedServiceMaterializationIdentityV1: identity },
    }));
    vi.unstubAllEnvs();
    if (direct.kind !== 'applied' || !direct.result) throw new Error(`direct launch did not materialize: ${direct.kind === 'failed' ? direct.message : 'none'}`);
    const directEnv = direct.result.env;
    expect(directEnv.CODEX_SQLITE_HOME).toBe(f.nominated.CODEX_SQLITE_HOME);

    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedByPid = new Map<number, TrackedSession>();
    const notifications: unknown[] = [];
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api: f.api as unknown as ApiClient, credentials, runtimeRegistry: registry,
      machineIdProvider: () => 'synthetic-machine', ownerIdProvider: () => 'synthetic-owner',
      activeServerDir: configuration.activeServerDir,
      baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => NOW,
      accountSettingsProvider: () => sharedSettings, processEnv: f.ambientEnv,
      onAuthUpdated: async (event) => { notifications.push(event); },
    });
    const webhook = createOnHappySessionWebhook({
      pidToTrackedSession: trackedByPid, pidToAwaiter: new Map(),
      findHappyProcessByPidFn: async () => null, writeSessionMarkerFn: async () => {},
      onTrackedSessionReported: (tracked) => {
        if (mode === 'full-env-control') {
          tracked.spawnOptions = {
            directory: f.dir, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            connectedServices: bindings, environmentVariables: directEnv,
            connectedServiceMaterializationIdentityV1: identity,
          };
        }
        registerConnectedServiceTrackedSessionTargetsForDaemon({ tracked, runtimeRegistry: registry });
      },
    });
    await webhook(`coordinator-${mode}`, {
      path: f.dir, hostPid: process.pid, startedBy: 'terminal', flavor: 'codex',
      connectedServices: bindings, connectedServiceMaterializationIdentityV1: identity,
    } as Parameters<typeof webhook>[1]);
    await trackedByPid.get(process.pid)?.reportMarkerCustody?.pending;

    const before = await f.sentinels();
    f.records.set(`openai-codex/${f.profile}`, oauthRecord(f.profile, `coordinator-rotated-${mode}`));
    await coordinator.handleExternalCredentialUpdate({
      serviceId: 'openai-codex', profileId: f.profile,
      credentialBoundary: { status: 'present', revisionSemantics: 'revisioned', credentialRevision: `csr_${'b'.repeat(22)}` },
      executionAuthority: 'passive_projection',
    });

    expect(registry.listRefreshTargets()[0]?.selectionsByServiceId.get('openai-codex')).toMatchObject({
      kind: 'profile', profileId: f.profile, nativeSource: f.nominated,
    });
    expect(await f.sentinels()).toEqual(before);
    expect(JSON.parse(await readFile(join(directEnv.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token)
      .toBe(`coordinator-rotated-${mode}`);
    expect(notifications).toHaveLength(1);
  });
});

/**
 * Q-CODEX-NATIVE-PATH-02 (independent review t_9ae6211c/run20885): the binding accepts every platform's
 * absolute syntax, but a materializer admits only a path absolute on its own filesystem. On POSIX a
 * Windows drive or UNC nomination is refused, before anything is created, rather than resolved against
 * the working directory; a native absolute pair reaches the same home from any working directory.
 */
describe.runIf(process.platform !== 'win32')('a nomination is admitted only with paths absolute on this platform', () => {
  const inDirectory = async <T>(dir: string, work: () => Promise<T>): Promise<T> => {
    const cwd = process.cwd();
    process.chdir(dir);
    try { return await work(); } finally { process.chdir(cwd); }
  };

  it.each([
    ['drive', { CODEX_HOME: 'C:\\new-codex', CODEX_SQLITE_HOME: 'D:\\new-sqlite' }],
    ['UNC', { CODEX_HOME: '\\\\server\\share\\new-codex', CODEX_SQLITE_HOME: '\\\\server\\share\\new-sqlite' }],
    ['mixed', { CODEX_HOME: '/abs/new-codex', CODEX_SQLITE_HOME: 'D:\\new-sqlite' }],
  ] as const)('a %s-form nomination is refused with no source, home or lock created', async (_form, pair) => {
    const f = await retainedProfileFixture(`foreign-${_form}`, `nom-foreign-${_form}`);
    expect(ConnectedServiceBindingsV1Schema.safeParse(profileBindings(f.profile, pair)).success).toBe(true);
    const homesRoot = resolveConnectedServiceHomesDir({ activeServerDir: configuration.activeServerDir });
    const fixtureBefore = await snapshotTree(f.dir);
    const homesBefore = await snapshotTree(homesRoot);

    const refused = await inDirectory(f.dir, () => f.freshDaemonSpawn({ bindings: profileBindings(f.profile, pair), daemonEnv: f.ambientEnv }));

    expect(refused.outcome).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_invalid' } });
    expect(refused.outcome.kind === 'failed' ? refused.outcome.message : '').toContain('not an absolute path on this platform');
    expect(await snapshotTree(f.dir)).toEqual(fixtureBefore);
    expect(await snapshotTree(homesRoot)).toEqual(homesBefore);
  });

  it('a native absolute nomination reaches the same home and records the same pair from any working directory', async () => {
    const f = await retainedProfileFixture('native-cwd', 'nom-native-cwd');
    const elsewhere = join(f.dir, 'elsewhere');
    await mkdir(elsewhere);
    const first = await inDirectory(f.dir, () => f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv }));
    const second = await inDirectory(elsewhere, () => f.freshDaemonSpawn({ bindings: profileBindings(f.profile, f.nominated), daemonEnv: f.ambientEnv }));
    if (first.outcome.kind !== 'applied' || second.outcome.kind !== 'applied') throw new Error('native nomination did not materialize');
    const home = first.outcome.result?.env.CODEX_HOME;
    expect(second.outcome.result?.env.CODEX_HOME).toBe(home);
    expect((await readConnectedServiceStateSharingManifest(home!)).nativeSourceEnv).toEqual(f.nominated);
  });
});
