import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type AccountSettings,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialScopes';
import { configuration } from '@/configuration';
import { removeTempDir } from '@/testkit/fs/tempDir';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from '@/daemon/types';
import type { ExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

import { resolveConnectedServiceSelectionHomeDir } from './homes/resolveConnectedServiceHomeDir';
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

/**
 * A session launched directly from native source A is later switched and restarted, or respawned,
 * by the daemon, whose own environment names B. The daemon re-produces the session's homes through
 * the same public spawn resolver a new spawn uses. A continuation of the existing session must keep
 * A; a genuinely new caller still produces from its own source and still conflicts with a home
 * recording another. Real direct producer, switch materializer, spawn resolver and provider
 * materializers; server HTTP and the authenticated session read are synthetic.
 */
const { syntheticApi } = vi.hoisted(() => ({ syntheticApi: { current: null as unknown } }));
vi.mock('@/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api')>();
  return { ...actual, ApiClient: { ...actual.ApiClient, create: async () => syntheticApi.current } };
});

const NOW = 2_000_000_000_000;
const CLAUDE_SOURCE_ENTRIES = ['settings.json', 'CLAUDE.md', 'projects'] as const;
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

function oauthRecord(serviceId: 'claude-subscription' | 'openai-codex', profileId: string, accessToken: string) {
  return buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId,
    profileId,
    kind: 'oauth',
    expiresAt: NOW + 3_600_000,
    oauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      idToken: null,
      scope: serviceId === 'claude-subscription' ? CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE : null,
      tokenType: 'Bearer',
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

async function nativeClaudeSource(dir: string, name: string): Promise<string> {
  const source = join(dir, name);
  await mkdir(join(source, 'projects', '-work'), { recursive: true });
  await writeFile(join(source, 'settings.json'), JSON.stringify({
    mcpServers: { [`${name}-mcp`]: { command: `/bin/${name}-mcp` } },
    cleanupPeriodDays: 99999,
  }));
  await writeFile(join(source, 'CLAUDE.md'), `# ${name}\n`);
  return source;
}

async function claudeSourceLinks(claudeConfigDir: string): Promise<Record<string, string | null>> {
  const links: Record<string, string | null> = {};
  for (const entry of CLAUDE_SOURCE_ENTRIES) {
    try {
      const stat = await lstat(join(claudeConfigDir, entry));
      links[entry] = stat.isSymbolicLink() ? resolve(claudeConfigDir, await readlink(join(claudeConfigDir, entry))) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      links[entry] = null;
    }
  }
  return links;
}

function linkedUnder(root: string): Record<string, string> {
  return Object.fromEntries(CLAUDE_SOURCE_ENTRIES.map((entry) => [entry, join(root, entry)]));
}

async function mcpServerNames(claudeConfigDir: string): Promise<string[]> {
  return Object.keys(JSON.parse(await readFile(join(claudeConfigDir, 'settings.json'), 'utf8')).mcpServers ?? {});
}

const settle = <T>(work: () => Promise<T>) => Promise.resolve().then(work).then(
  (result) => ({ kind: 'applied' as const, result }),
  (error: unknown) => ({ kind: 'failed' as const, message: String(error), error }),
);

function profileBindings(serviceId: 'claude-subscription' | 'openai-codex', profileId: string): ConnectedServiceBindingsV1 {
  return { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId } } };
}

/** What `resolveExistingSessionAttachContext` returns for a session whose metadata is `metadata`. */
function attachContext(metadata: Record<string, unknown> | null): ExistingSessionAttachContext {
  return {
    ok: true,
    attachPayload: {} as ExistingSessionAttachContext['attachPayload'],
    vendorResumeId: null,
    sessionPath: null,
    metadata,
  };
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

/**
 * A runnable stand-in for the provider CLI. The direct producer refuses a launch whose provider CLI
 * it cannot resolve; naming this file as the exclusive `HAPPIER_<AGENT>_PATH` override keeps that
 * check satisfied without discovering or running any CLI installed on the host.
 */
async function writeProviderCliStub(dir: string): Promise<string> {
  const stub = join(dir, 'provider-cli-stub');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return stub;
}

async function createFixture(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `happier-continuation-source-${prefix}-`));
  roots.push(dir);
  const providerCli = await writeProviderCliStub(dir);
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

  const { resolveDirectConnectedServiceEnvironment } = await import('@/cli/connectedServices/resolveDirectConnectedServiceEnvironment');

  /** The direct producer, run with the caller's own environment. */
  const directLaunch = async (input: Readonly<{
    agentId: 'claude' | 'codex';
    sessionId: string;
    bindings: ConnectedServiceBindingsV1;
    identity: ConnectedServiceMaterializationIdentityV1;
    env: Readonly<Record<string, string>>;
  }>) => {
    vi.stubEnv(input.agentId === 'claude' ? 'HAPPIER_CLAUDE_PATH' : 'HAPPIER_CODEX_PATH', providerCli);
    for (const [key, value] of Object.entries(input.env)) vi.stubEnv(key, value);
    try {
      return await settle(() => resolveDirectConnectedServiceEnvironment({
        agentId: input.agentId,
        credentials,
        accountSettings: sharedSettings,
        directory: dir,
        sessionId: input.sessionId,
        connectedServices: input.bindings,
        sessionMetadata: { connectedServiceMaterializationIdentityV1: input.identity },
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  };

  /**
   * The daemon's spawn of an existing session (a restart after a switch, a durable recovery or a
   * runner respawn), exactly as `spawnSession` resolves it: the daemon's own environment, and the
   * native source derived from its authenticated read of the session.
   */
  const daemonSpawn = async (input: Readonly<{
    agentId: 'claude' | 'codex';
    sessionId: string;
    bindings: ConnectedServiceBindingsV1;
    identity: ConnectedServiceMaterializationIdentityV1;
    daemonEnv: NodeJS.ProcessEnv;
    persistedMetadata: Record<string, unknown> | null;
  }>) => await settle(() => resolveConnectedServiceAuthForSpawn({
    agentId: input.agentId,
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

  /** A fresh daemon spawn (no existing session): the daemon is the producing caller. */
  const freshDaemonSpawn = async (input: Readonly<{
    agentId: 'claude' | 'codex';
    bindings: ConnectedServiceBindingsV1;
    daemonEnv: NodeJS.ProcessEnv;
  }>) => {
    const identity = createConnectedServiceMaterializationIdentity();
    return await settle(() => resolveConnectedServiceAuthForSpawn({
      agentId: input.agentId,
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
    }));
  };

  return { dir, records, api, directLaunch, daemonSpawn, freshDaemonSpawn };
}

function claudeHome(profileId: string): string {
  return join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'claude-subscription',
    agentId: 'claude',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'claude-config');
}

function codexHome(profileId: string): string {
  return join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'openai-codex',
    agentId: 'codex',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'codex-home');
}

async function claudeFixture(prefix: string) {
  const fixture = await createFixture(prefix);
  const callerSource = await nativeClaudeSource(fixture.dir, 'caller');
  const daemonSource = await nativeClaudeSource(fixture.dir, 'daemon');
  const daemonSourceEntries = (await readdir(daemonSource)).sort();
  const daemonEnv = { HOME: join(fixture.dir, 'daemon-home'), CLAUDE_CONFIG_DIR: daemonSource };
  return { ...fixture, callerSource, daemonSource, daemonSourceEntries, daemonEnv };
}

describe('a daemon spawn that continues an existing session keeps its recorded native source', () => {
  it('Claude: direct launch from A, account switch, then the restart spawn under daemon env B keeps A', async () => {
    const f = await claudeFixture('claude-switch');
    const [primary, backup] = ['cont-switch-primary', 'cont-switch-backup'];
    f.records.set(`claude-subscription/${primary}`, oauthRecord('claude-subscription', primary, 'primary-access'));
    f.records.set(`claude-subscription/${backup}`, oauthRecord('claude-subscription', backup, 'backup-access'));
    const identity = createConnectedServiceMaterializationIdentity();
    const sessionId = 'session-cont-switch';

    const launched = await f.directLaunch({
      agentId: 'claude', sessionId, bindings: profileBindings('claude-subscription', primary), identity,
      env: { HOME: f.dir, CLAUDE_CONFIG_DIR: f.callerSource },
    });
    expect(launched.kind).toBe('applied');
    expect(await claudeSourceLinks(claudeHome(primary))).toEqual(linkedUnder(f.callerSource));

    // The switch materializes the backup home from the source the session's current home records.
    const switched = await settle(() => materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: f.api as unknown as ApiClient,
      activeServerDir: configuration.activeServerDir,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: sessionId,
          pid: 5301,
          spawnOptions: {
            directory: f.dir,
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices: profileBindings('claude-subscription', primary),
            environmentVariables: { CLAUDE_CONFIG_DIR: claudeHome(primary) },
          },
        } as unknown as TrackedSession,
        sessionId,
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: { source: 'connected', selection: 'profile', serviceId: 'claude-subscription', profileId: primary },
        next: { source: 'connected', selection: 'profile', serviceId: 'claude-subscription', profileId: backup },
        previousBindings: profileBindings('claude-subscription', primary),
        normalizedBindings: profileBindings('claude-subscription', backup),
      } as unknown as Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'],
      accountSettings: sharedSettings,
      processEnv: f.daemonEnv,
    }));
    expect(switched.kind).toBe('applied');

    // The restart: the daemon re-produces the session's homes for the new binding.
    const restarted = await f.daemonSpawn({
      agentId: 'claude', sessionId, bindings: profileBindings('claude-subscription', backup), identity,
      daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: profileBindings('claude-subscription', backup) },
    });
    expect(restarted).toMatchObject({ kind: 'applied' });
    if (restarted.kind !== 'applied') return;
    expect(restarted.result?.env.CLAUDE_CONFIG_DIR).toBe(claudeHome(backup));
    expect(await claudeSourceLinks(claudeHome(backup))).toEqual(linkedUnder(f.callerSource));
    expect(await mcpServerNames(claudeHome(backup))).toEqual(['caller-mcp']);
    expect(JSON.parse(await readFile(join(claudeHome(backup), '.credentials.json'), 'utf8')).claudeAiOauth.accessToken)
      .toBe('backup-access');
    expect((await readConnectedServiceStateSharingManifest(claudeHome(backup))).nativeSourceEnv)
      .toEqual({ CLAUDE_CONFIG_DIR: f.callerSource, HOME: f.dir });
    expect((await readdir(f.daemonSource)).sort()).toEqual(f.daemonSourceEntries);
  });

  it('Claude: a runner respawn of the same binding under daemon env B keeps A', async () => {
    const f = await claudeFixture('claude-respawn');
    const profile = 'cont-respawn';
    f.records.set(`claude-subscription/${profile}`, oauthRecord('claude-subscription', profile, 'respawn-access'));
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings('claude-subscription', profile);
    expect((await f.directLaunch({
      agentId: 'claude', sessionId: 'session-cont-respawn', bindings, identity,
      env: { HOME: f.dir, CLAUDE_CONFIG_DIR: f.callerSource },
    })).kind).toBe('applied');

    const respawned = await f.daemonSpawn({
      agentId: 'claude', sessionId: 'session-cont-respawn', bindings, identity, daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: bindings },
    });
    expect(respawned).toMatchObject({ kind: 'applied' });
    expect(await claudeSourceLinks(claudeHome(profile))).toEqual(linkedUnder(f.callerSource));
    expect(await mcpServerNames(claudeHome(profile))).toEqual(['caller-mcp']);
    expect((await readConnectedServiceStateSharingManifest(claudeHome(profile))).nativeSourceEnv)
      .toEqual({ CLAUDE_CONFIG_DIR: f.callerSource, HOME: f.dir });
  });

  it('Claude: a fresh daemon spawn owns its own source B, and a new caller B into A\'s home still conflicts', async () => {
    const f = await claudeFixture('claude-new-caller');
    const [owned, aHome] = ['cont-fresh-owned', 'cont-fresh-a'];
    f.records.set(`claude-subscription/${owned}`, oauthRecord('claude-subscription', owned, 'owned-access'));
    f.records.set(`claude-subscription/${aHome}`, oauthRecord('claude-subscription', aHome, 'a-access'));

    expect((await f.freshDaemonSpawn({
      agentId: 'claude', bindings: profileBindings('claude-subscription', owned), daemonEnv: f.daemonEnv,
    })).kind).toBe('applied');
    expect(await claudeSourceLinks(claudeHome(owned))).toEqual(linkedUnder(f.daemonSource));
    expect((await readConnectedServiceStateSharingManifest(claudeHome(owned))).nativeSourceEnv)
      .toEqual({ CLAUDE_CONFIG_DIR: f.daemonSource, HOME: f.daemonEnv.HOME });

    expect((await f.directLaunch({
      agentId: 'claude', sessionId: 'session-cont-fresh-a', bindings: profileBindings('claude-subscription', aHome),
      identity: createConnectedServiceMaterializationIdentity(), env: { HOME: f.dir, CLAUDE_CONFIG_DIR: f.callerSource },
    })).kind).toBe('applied');
    const manifestBefore = await readFile(join(claudeHome(aHome), DEFAULT_MANIFEST_NAME), 'utf8');
    const credentialsBefore = await readFile(join(claudeHome(aHome), '.credentials.json'), 'utf8');
    const refused = await f.freshDaemonSpawn({
      agentId: 'claude', bindings: profileBindings('claude-subscription', aHome), daemonEnv: f.daemonEnv,
    });
    expect(refused).toMatchObject({ kind: 'failed' });
    expect(refused.kind === 'failed' ? refused.message : '').toContain('refusing to materialize it from');
    expect(await claudeSourceLinks(claudeHome(aHome))).toEqual(linkedUnder(f.callerSource));
    expect(await readFile(join(claudeHome(aHome), DEFAULT_MANIFEST_NAME), 'utf8')).toBe(manifestBefore);
    expect(await readFile(join(claudeHome(aHome), '.credentials.json'), 'utf8')).toBe(credentialsBefore);
  });

  it('Claude: a continuation under an identity other than the persisted one is refused before any home write', async () => {
    const f = await claudeFixture('claude-identity');
    const profile = 'cont-identity';
    f.records.set(`claude-subscription/${profile}`, oauthRecord('claude-subscription', profile, 'identity-access'));
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings('claude-subscription', profile);
    expect((await f.directLaunch({
      agentId: 'claude', sessionId: 'session-cont-identity', bindings, identity,
      env: { HOME: f.dir, CLAUDE_CONFIG_DIR: f.callerSource },
    })).kind).toBe('applied');
    const manifestBefore = await readFile(join(claudeHome(profile), DEFAULT_MANIFEST_NAME), 'utf8');

    const forged = await f.daemonSpawn({
      agentId: 'claude', sessionId: 'session-cont-identity', bindings,
      identity: createConnectedServiceMaterializationIdentity(), daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: bindings },
    });
    expect(forged).toMatchObject({ kind: 'failed', error: { code: 'connected_service_spawn_continuation_identity_mismatch' } });
    expect(await claudeSourceLinks(claudeHome(profile))).toEqual(linkedUnder(f.callerSource));
    expect(await readFile(join(claudeHome(profile), DEFAULT_MANIFEST_NAME), 'utf8')).toBe(manifestBefore);
  });

  it('Claude: a session that persisted no identity is re-produced by its caller, so daemon env B conflicts with A', async () => {
    const f = await claudeFixture('claude-legacy-identity');
    const profile = 'cont-no-identity';
    f.records.set(`claude-subscription/${profile}`, oauthRecord('claude-subscription', profile, 'legacy-access'));
    const bindings = profileBindings('claude-subscription', profile);
    expect((await f.directLaunch({
      agentId: 'claude', sessionId: 'session-cont-no-identity', bindings,
      identity: createConnectedServiceMaterializationIdentity(), env: { HOME: f.dir, CLAUDE_CONFIG_DIR: f.callerSource },
    })).kind).toBe('applied');

    const respawned = await f.daemonSpawn({
      agentId: 'claude', sessionId: 'session-cont-no-identity', bindings,
      identity: createConnectedServiceMaterializationIdentity(), daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServices: bindings },
    });
    expect(respawned).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(await claudeSourceLinks(claudeHome(profile))).toEqual(linkedUnder(f.callerSource));
  });

  it.each([
    ['malformed', { CLAUDE_CONFIG_DIR: 'relative/config', HOME: '/home' }, 'connected_service_native_source_invalid'],
    ['incomplete', { CLAUDE_CONFIG_DIR: '/absolute/config' }, 'connected_service_native_source_invalid'],
  ] as const)('Claude: a continuation into a home with a %s record is refused without reading B', async (_kind, nativeSourceEnv, code) => {
    const f = await claudeFixture(`claude-${_kind}`);
    const profile = `cont-${_kind}`;
    f.records.set(`claude-subscription/${profile}`, oauthRecord('claude-subscription', profile, 'bad-access'));
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings('claude-subscription', profile);
    // Written raw: the manifest writer would drop a record it cannot parse.
    await mkdir(claudeHome(profile), { recursive: true });
    await writeFile(join(claudeHome(profile), DEFAULT_MANIFEST_NAME), JSON.stringify({
      v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', lastSyncAtMs: 0,
      configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
      nativeSourceEnv,
    }));

    const refused = await f.daemonSpawn({
      agentId: 'claude', sessionId: `session-cont-${_kind}`, bindings, identity, daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: bindings },
    });
    expect(refused).toMatchObject({ kind: 'failed', error: { code } });
    expect(await readdir(claudeHome(profile))).toEqual([DEFAULT_MANIFEST_NAME]);
    expect((await readdir(f.daemonSource)).sort()).toEqual(f.daemonSourceEntries);
  });

  it('Claude: a continuation into a never-produced home with nothing recorded is refused, never produced from B', async () => {
    const f = await claudeFixture('claude-unrecorded');
    const profile = 'cont-unrecorded';
    f.records.set(`claude-subscription/${profile}`, oauthRecord('claude-subscription', profile, 'unrecorded-access'));
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings('claude-subscription', profile);

    const refused = await f.daemonSpawn({
      agentId: 'claude', sessionId: 'session-cont-unrecorded', bindings, identity, daemonEnv: f.daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: bindings },
    });
    expect(refused).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_unrecorded' } });
    expect(await claudeSourceLinks(claudeHome(profile))).toEqual({ 'settings.json': null, 'CLAUDE.md': null, projects: null });
  });

  it('Codex: direct launch from A, then a respawn under daemon env B keeps A and its SQLite home', async () => {
    const f = await createFixture('codex-respawn');
    const profile = 'cont-codex';
    f.records.set(`openai-codex/${profile}`, oauthRecord('openai-codex', profile, 'codex-access'));
    const source = { CODEX_HOME: join(f.dir, 'codex-native'), CODEX_SQLITE_HOME: join(f.dir, 'codex-native-sqlite') };
    const daemonEnv = { HOME: join(f.dir, 'daemon-home'), CODEX_HOME: join(f.dir, 'daemon-codex'), CODEX_SQLITE_HOME: join(f.dir, 'daemon-sqlite') };
    await mkdir(source.CODEX_HOME, { recursive: true });
    await mkdir(daemonEnv.CODEX_HOME, { recursive: true });
    const identity = createConnectedServiceMaterializationIdentity();
    const bindings = profileBindings('openai-codex', profile);

    const launched = await f.directLaunch({ agentId: 'codex', sessionId: 'session-cont-codex', bindings, identity, env: { HOME: f.dir, ...source } });
    expect(launched).toMatchObject({ kind: 'applied' });

    const respawned = await f.daemonSpawn({
      agentId: 'codex', sessionId: 'session-cont-codex', bindings, identity, daemonEnv,
      persistedMetadata: { connectedServiceMaterializationIdentityV1: identity, connectedServices: bindings },
    });
    expect(respawned).toMatchObject({ kind: 'applied' });
    if (respawned.kind !== 'applied') return;
    expect(respawned.result?.env).toMatchObject({ CODEX_HOME: codexHome(profile), CODEX_SQLITE_HOME: source.CODEX_SQLITE_HOME });
    expect((await readConnectedServiceStateSharingManifest(codexHome(profile))).nativeSourceEnv).toEqual(source);

    const fresh = await f.freshDaemonSpawn({ agentId: 'codex', bindings, daemonEnv });
    expect(fresh).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect((await readConnectedServiceStateSharingManifest(codexHome(profile))).nativeSourceEnv).toEqual(source);
  });
});
