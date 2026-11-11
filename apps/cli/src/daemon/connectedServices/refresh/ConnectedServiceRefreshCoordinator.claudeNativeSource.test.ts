import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, type AccountSettings } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialScopes';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import {
  reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { materializeConnectedServicesForSpawn } from '../materialize/materializeConnectedServicesForSpawn';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from '../sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveConnectedServiceSelectionHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { registerConnectedServiceTrackedSessionTargetsForDaemon } from '../startup/runtimeTargetRegistration';
import {
  DEFAULT_MANIFEST_NAME,
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '../stateSharing/connectedServiceStateSharingManifest';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

const { syntheticApi } = vi.hoisted(() => ({ syntheticApi: { current: null as unknown } }));

// The direct producer creates its API client from the caller's credentials; the synthetic server
// below stands in for HTTP only. Selection, health, materialization and registration stay real.
vi.mock('@/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api')>();
  return {
    ...actual,
    ApiClient: { ...actual.ApiClient, create: async () => syntheticApi.current },
  };
});

const NOW = 2_000_000_000_000;
/** Configuration (MCP servers, instructions) and history the managed home takes from its native source. */
const SOURCE_ENTRIES = ['settings.json', 'CLAUDE.md', 'projects'] as const;
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

function claudeRecord(profileId: string, accessToken: string, expiresInMs = 3_600_000) {
  return buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'oauth',
    expiresAt: NOW + expiresInMs,
    oauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

/** A native Claude config dir whose MCP servers and instructions name it. */
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

async function snapshotSourceLinks(claudeConfigDir: string): Promise<Record<string, string | null>> {
  const links: Record<string, string | null> = {};
  for (const entry of SOURCE_ENTRIES) {
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

function expectAllLinkedUnder(links: Record<string, string | null>, root: string): void {
  for (const entry of SOURCE_ENTRIES) expect(links[entry], entry).toBe(join(root, entry));
}

/** The MCP servers a Claude process started in this home would read from its settings. */
async function mcpServerNames(claudeConfigDir: string): Promise<string[]> {
  return Object.keys(JSON.parse(await readFile(join(claudeConfigDir, 'settings.json'), 'utf8')).mcpServers ?? {});
}

const settle = <T>(work: Promise<T>) => work.then(
  (result) => ({ kind: 'applied' as const, result }),
  (error: unknown) => ({ kind: 'failed' as const, message: String(error), error }),
);

/**
 * Real direct producer (the caller's CLAUDE_CONFIG_DIR) -> real terminal registration from the
 * session's webhook metadata -> real daemon refresh coordinator whose own environment names a
 * different Claude config dir (a sentinel). Server HTTP is synthetic; filesystem effects are real.
 */
async function createComposedFixture(params: Readonly<{
  profileId: string;
  sentinelMode: 'readable' | 'inaccessible';
}>) {
  const profileId = params.profileId;
  const dir = await mkdtemp(join(tmpdir(), 'happier-claude-native-source-'));
  const callerSource = await nativeClaudeSource(dir, 'caller');
  const daemonSource = await nativeClaudeSource(dir, 'daemon');
  const sentinelEntriesBefore = (await readdir(daemonSource)).sort();
  if (params.sentinelMode === 'inaccessible') await chmod(daemonSource, 0o000);
  const daemonEnv = { HOME: join(dir, 'daemon-home'), CLAUDE_CONFIG_DIR: daemonSource };

  const server = {
    record: claudeRecord(profileId, 'synthetic-access-1'),
    credentialRevision: `csr_${'a'.repeat(22)}`,
  };
  const api: Record<string, unknown> = {
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async () => ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: server.credentialRevision,
      content: { t: 'plain', v: server.record },
    }),
    getConnectedServiceCredentialSealed: async () => null,
    readConnectedServiceCredentialHealth: async () => ({ kind: 'found' as const, status: 'connected' as const, health: null }),
    updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    acquireConnectedServiceRefreshLease: vi.fn(async () => ({
      acquired: true,
      leaseUntil: NOW + 60_000,
      credentialRevision: server.credentialRevision,
    })),
    registerConnectedServiceCredentialPlain: vi.fn(async (input: { content: { v: typeof server.record } }) => {
      server.record = input.content.v;
      server.credentialRevision = `csr_${'r'.repeat(22)}`;
      return { success: true as const, credentialRevision: server.credentialRevision };
    }),
  };
  syntheticApi.current = api;

  const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
  const onAuthUpdated = vi.fn(async (_update: unknown) => {});
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api: api as unknown as ApiClient,
    credentials,
    runtimeRegistry,
    machineIdProvider: () => 'synthetic-machine',
    ownerIdProvider: () => 'synthetic-machine:daemon',
    activeServerDir: configuration.activeServerDir,
    baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => NOW,
    accountSettingsProvider: () => sharedSettings,
    processEnv: daemonEnv,
    onAuthUpdated,
  });
  const stopObserving = coordinator.observeTargetRegistrations();
  const bindings = {
    v: 1 as const,
    bindingsByServiceId: { 'claude-subscription': { source: 'connected' as const, selection: 'profile' as const, profileId } },
  };
  const claudeHome = join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'claude-subscription',
    agentId: 'claude',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'claude-config');

  const { resolveDirectConnectedServiceEnvironment, resolveDirectConnectedServiceMaterializationIdentity } =
    await import('@/cli/connectedServices/resolveDirectConnectedServiceEnvironment');

  /** The direct producer, run with the caller's own CLAUDE_CONFIG_DIR. */
  const directLaunch = async (input: Readonly<{ sessionId: string; source: string }>) => {
    const identity = resolveDirectConnectedServiceMaterializationIdentity(null);
    vi.stubEnv('CLAUDE_CONFIG_DIR', input.source);
    try {
      const launched = await settle(resolveDirectConnectedServiceEnvironment({
        agentId: 'claude',
        credentials,
        accountSettings: sharedSettings,
        directory: dir,
        sessionId: input.sessionId,
        connectedServices: bindings,
        sessionMetadata: { connectedServiceMaterializationIdentityV1: identity },
      }));
      return { identity, launched };
    } finally {
      vi.unstubAllEnvs();
    }
  };

  /** The terminal session's webhook report, registered by the daemon as an externally started target. */
  const registerTerminalSession = (input: Readonly<{ pid: number; sessionId: string; identity: unknown }>) =>
    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked: {
        pid: input.pid,
        startedBy: 'terminal',
        happySessionId: input.sessionId,
        happySessionMetadataFromLocalWebhook: {
          flavor: 'claude',
          path: dir,
          connectedServices: bindings,
          connectedServiceMaterializationIdentityV1: input.identity,
        },
      } as unknown as TrackedSession,
      runtimeRegistry,
    });

  /**
   * An external credential revision applied through one of the two production direct-revision
   * reconcilers (projection delta or target registration) into the real coordinator.
   */
  const applyExternalRevision = async (
    sessionId: string,
    accessToken: string,
    producer: 'registration' | 'delta',
  ) => {
    const previousRevision = server.credentialRevision;
    server.record = claudeRecord(profileId, accessToken);
    server.credentialRevision = `csr_${'b'.repeat(22)}`;
    const target = {
      sessionId,
      agentId: 'claude',
      connectedServicesBindingsRaw: bindings,
      activeBindings: [{
        serviceId: 'claude-subscription',
        groupId: null,
        profileId,
        generation: null,
        credentialRevision: previousRevision,
      }],
    };
    const boundary = {
      status: 'present' as const,
      revisionSemantics: 'revisioned' as const,
      credentialRevision: server.credentialRevision,
    };
    const applyLiveCredentialBoundary = async (input: Parameters<typeof coordinator.handleExternalCredentialUpdate>[0]) => {
      await coordinator.handleExternalCredentialUpdate(input);
    };
    return await settle(producer === 'delta'
      ? reconcileConnectedServiceDirectCredentialRevisions({
          credentialBoundaries: [{ serviceId: 'claude-subscription', profileId, boundary }],
          listRuntimeTargets: () => [target],
          isCurrentRuntimeTarget: () => true,
          applyLiveCredentialBoundary,
          executionAuthority: 'passive_projection',
        } as unknown as Parameters<typeof reconcileConnectedServiceDirectCredentialRevisions>[0])
      : reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
          target,
          resolveCredentialBoundary: () => boundary,
          applyLiveCredentialBoundary,
          executionAuthority: 'passive_projection',
          isCurrent: () => true,
        } as unknown as Parameters<typeof reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget>[0]));
  };

  const readAccessToken = async () =>
    JSON.parse(await readFile(join(claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken as string;

  const sentinelEntries = async () => {
    if (params.sentinelMode === 'inaccessible') await chmod(daemonSource, 0o755);
    try {
      return (await readdir(daemonSource)).sort();
    } finally {
      if (params.sentinelMode === 'inaccessible') await chmod(daemonSource, 0o000);
    }
  };

  /** A spawn materialization of this profile's home, as the daemon or a terminal would request it. */
  const materialize = async (input: Readonly<{
    nativeSourceAuthority: 'caller_env' | 'recorded';
    processEnv: NodeJS.ProcessEnv;
  }>) => await settle(materializeConnectedServicesForSpawn({
    agentId: 'claude',
    activeServerDir: configuration.activeServerDir,
    materializationKey: `materialize-${profileId}`,
    baseDir: join(dir, 'runs'),
    sessionDirectory: dir,
    recordsByServiceId: new Map([['claude-subscription', server.record]]),
    nativeSourceAuthority: input.nativeSourceAuthority,
    processEnv: input.processEnv,
    accountSettings: sharedSettings,
  }));

  return {
    dir,
    profileId,
    callerSource,
    daemonSource,
    daemonEnv,
    claudeHome,
    server,
    api,
    coordinator,
    onAuthUpdated,
    sentinelEntriesBefore,
    directLaunch,
    registerTerminalSession,
    applyExternalRevision,
    readAccessToken,
    sentinelEntries,
    materialize,
    dispose: async () => {
      stopObserving();
      await chmod(daemonSource, 0o755);
    },
  };
}

describe('Claude connected-service homes keep their admitted native source', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['registration', 'delta'] as const)('keeps the caller source and its MCP servers when the daemon rematerializes after an external revision (%s producer)', async (producer) => {
    const fixture = await createComposedFixture({ profileId: `claude-readable-${producer}`, sentinelMode: 'readable' });
    const { identity, launched } = await fixture.directLaunch({ sessionId: 'session-readable', source: fixture.callerSource });
    expect(launched.kind).toBe('applied');
    expectAllLinkedUnder(await snapshotSourceLinks(fixture.claudeHome), fixture.callerSource);

    fixture.registerTerminalSession({ pid: 5242, sessionId: 'session-readable', identity });
    const external = await fixture.applyExternalRevision('session-readable', 'synthetic-access-2', producer);
    expect(external).toMatchObject({ kind: 'applied' });
    expect(await fixture.readAccessToken()).toBe('synthetic-access-2');
    expectAllLinkedUnder(await snapshotSourceLinks(fixture.claudeHome), fixture.callerSource);
    expect(await mcpServerNames(fixture.claudeHome)).toEqual(['caller-mcp']);
    expect(await readFile(join(fixture.claudeHome, 'CLAUDE.md'), 'utf8')).toBe('# caller\n');
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    expect((await readConnectedServiceStateSharingManifest(fixture.claudeHome)).nativeSourceEnv).toEqual({
      CLAUDE_CONFIG_DIR: fixture.callerSource,
      HOME: resolve(process.env.HOME ?? ''),
    });
    await fixture.dispose();
  });

  it('never traverses an excluded daemon source while distributing an external revision', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-excluded', sentinelMode: 'inaccessible' });
    const { identity, launched } = await fixture.directLaunch({ sessionId: 'session-excluded', source: fixture.callerSource });
    expect(launched.kind).toBe('applied');
    fixture.registerTerminalSession({ pid: 5243, sessionId: 'session-excluded', identity });

    const external = await fixture.applyExternalRevision('session-excluded', 'synthetic-access-2', 'registration');
    expect(external).toMatchObject({ kind: 'applied' });
    expect(await fixture.readAccessToken()).toBe('synthetic-access-2');
    expectAllLinkedUnder(await snapshotSourceLinks(fixture.claudeHome), fixture.callerSource);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('refuses a caller with a different source before reading it, leaving links, credentials and record unchanged', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-conflict', sentinelMode: 'inaccessible' });
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    const linksBefore = await snapshotSourceLinks(fixture.claudeHome);
    const credentialsBefore = await readFile(join(fixture.claudeHome, '.credentials.json'), 'utf8');
    const manifestBefore = await readFile(join(fixture.claudeHome, DEFAULT_MANIFEST_NAME), 'utf8');

    const refused = await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: fixture.daemonEnv });
    expect(refused).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(await snapshotSourceLinks(fixture.claudeHome)).toEqual(linksBefore);
    expect(await readFile(join(fixture.claudeHome, '.credentials.json'), 'utf8')).toBe(credentialsBefore);
    expect(await readFile(join(fixture.claudeHome, DEFAULT_MANIFEST_NAME), 'utf8')).toBe(manifestBefore);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('lets a caller naming the same source through another spelling share the home', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-alias', sentinelMode: 'inaccessible' });
    const alias = join(fixture.dir, 'caller-alias');
    await symlink(fixture.callerSource, alias);
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: join(fixture.dir, 'other-home'), CLAUDE_CONFIG_DIR: alias } })).kind).toBe('applied');
    expect(await mcpServerNames(fixture.claudeHome)).toEqual(['caller-mcp']);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('keeps the default-config source (HOME) through a recorded rematerialization', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-default-home', sentinelMode: 'inaccessible' });
    const userHome = join(fixture.dir, 'user-home');
    await mkdir(userHome, { recursive: true });
    await symlink(fixture.callerSource, join(userHome, '.claude'));
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: userHome } })).kind).toBe('applied');
    expect(await mcpServerNames(fixture.claudeHome)).toEqual(['caller-mcp']);

    expect((await fixture.materialize({ nativeSourceAuthority: 'recorded', processEnv: { ...fixture.daemonEnv, CLAUDE_CONFIG_DIR: undefined, HOME: join(fixture.dir, 'daemon-home') } })).kind).toBe('applied');
    expect(await mcpServerNames(fixture.claudeHome)).toEqual(['caller-mcp']);
    expect((await readConnectedServiceStateSharingManifest(fixture.claudeHome)).nativeSourceEnv).toEqual({ HOME: userHome });
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('publishes credentials only into a home produced before sources were recorded, keeping its links', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-legacy', sentinelMode: 'inaccessible' });
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    const { nativeSourceEnv: _recorded, ...unrecorded } = await readConnectedServiceStateSharingManifest(fixture.claudeHome);
    await writeConnectedServiceStateSharingManifest(fixture.claudeHome, unrecorded);
    const linksBefore = await snapshotSourceLinks(fixture.claudeHome);
    fixture.server.record = claudeRecord('claude-legacy', 'synthetic-access-2');

    expect((await fixture.materialize({ nativeSourceAuthority: 'recorded', processEnv: fixture.daemonEnv })).kind).toBe('applied');
    expect(await fixture.readAccessToken()).toBe('synthetic-access-2');
    expect(await snapshotSourceLinks(fixture.claudeHome)).toEqual(linksBefore);
    expect((await readConnectedServiceStateSharingManifest(fixture.claudeHome)).nativeSourceEnv).toBeUndefined();
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it.each([
    ['malformed', { CLAUDE_CONFIG_DIR: 'relative/claude', HOME: '/home/synthetic' }],
    ['incomplete', { CLAUDE_CONFIG_DIR: '/absolute/claude' }],
  ] as const)('refuses a %s source record before reading any source', async (_kind, nativeSourceEnv) => {
    const fixture = await createComposedFixture({ profileId: `claude-invalid-${_kind}`, sentinelMode: 'inaccessible' });
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    const manifestPath = join(fixture.claudeHome, DEFAULT_MANIFEST_NAME);
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, 'utf8')), nativeSourceEnv }));
    const credentialsBefore = await readFile(join(fixture.claudeHome, '.credentials.json'), 'utf8');

    for (const nativeSourceAuthority of ['recorded', 'caller_env'] as const) {
      const refused = await fixture.materialize({ nativeSourceAuthority, processEnv: fixture.daemonEnv });
      expect(refused).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_invalid' } });
    }
    expect(await readFile(join(fixture.claudeHome, '.credentials.json'), 'utf8')).toBe(credentialsBefore);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  /**
   * The daemon's account-switch entry (both daemon call sites use it): a session running in the
   * `primary` home, produced by its caller from A, switches to `backup`. The daemon's own environment
   * (B) is never the new home's source.
   */
  async function switchToBackup(fixture: Awaited<ReturnType<typeof createComposedFixture>>, backupProfileId: string) {
    const backupRecord = claudeRecord(backupProfileId, 'synthetic-backup-access');
    const primaryProfileId = fixture.profileId;
    const primaryHome = fixture.claudeHome;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: backupRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: `csr_${'c'.repeat(22)}`,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const bindings = (profileId: string): ConnectedServiceBindingsV1 => ({
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId } },
    });
    const tracked = {
      startedBy: 'daemon',
      happySessionId: 'session-switch',
      pid: 5250,
      spawnOptions: {
        directory: fixture.dir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings(primaryProfileId),
        environmentVariables: { CLAUDE_CONFIG_DIR: primaryHome },
      },
    } as unknown as TrackedSession;
    return await settle(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      activeServerDir: configuration.activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'session-switch',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: { source: 'connected', selection: 'profile', serviceId: 'claude-subscription', profileId: primaryProfileId },
        next: { source: 'connected', selection: 'profile', serviceId: 'claude-subscription', profileId: backupProfileId },
        previousBindings: bindings(primaryProfileId),
        normalizedBindings: bindings(backupProfileId),
      } as unknown as Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'],
      accountSettings: sharedSettings,
      processEnv: fixture.daemonEnv,
    }));
  }

  const profileHome = (profileId: string) => join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'claude-subscription',
    agentId: 'claude',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'claude-config');

  it('switches a session to a new account home from the source its current home records, not the daemon environment', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-switch-primary', sentinelMode: 'readable' });
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    const backupHome = profileHome('claude-switch-backup');

    const switched = await switchToBackup(fixture, 'claude-switch-backup');
    expect(switched.kind).toBe('applied');
    expectAllLinkedUnder(await snapshotSourceLinks(backupHome), fixture.callerSource);
    expect(await mcpServerNames(backupHome)).toEqual(['caller-mcp']);
    expect(JSON.parse(await readFile(join(backupHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken).toBe('synthetic-backup-access');
    expect((await readConnectedServiceStateSharingManifest(backupHome)).nativeSourceEnv).toEqual({
      CLAUDE_CONFIG_DIR: fixture.callerSource, HOME: fixture.dir,
    });
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('refuses a switch into an account home recorded from a different source', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-switch-conflict-primary', sentinelMode: 'inaccessible' });
    expect((await fixture.materialize({ nativeSourceAuthority: 'caller_env', processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: fixture.callerSource } })).kind).toBe('applied');
    const backupHome = profileHome('claude-switch-conflict-backup');
    const otherSource = await nativeClaudeSource(fixture.dir, 'other');
    await writeConnectedServiceStateSharingManifest(backupHome, {
      v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', lastSyncAtMs: 0,
      configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
      nativeSourceEnv: { CLAUDE_CONFIG_DIR: otherSource, HOME: fixture.dir },
    });

    const switched = await switchToBackup(fixture, 'claude-switch-conflict-backup');
    expect(switched).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(await readdir(backupHome)).toEqual([DEFAULT_MANIFEST_NAME]);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });
  /** A group home and its active member produced by a spawn whose own environment names `source`. */
  async function produceGroup(fixture: Awaited<ReturnType<typeof createComposedFixture>>, groupId: string, memberProfileId: string, source: string) {
    const record = claudeRecord(memberProfileId, `${groupId}-access-1`);
    const produced = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      activeServerDir: configuration.activeServerDir,
      materializationKey: `group-${groupId}`,
      baseDir: join(fixture.dir, 'runs'),
      sessionDirectory: fixture.dir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      selectionsByServiceId: new Map([['claude-subscription', {
        kind: 'group', serviceId: 'claude-subscription', groupId, activeProfileId: memberProfileId,
        fallbackProfileId: memberProfileId, generation: 1, credentialRevision: `csr_${'c'.repeat(22)}`, record, policy: null,
      }]]),
      nativeSourceAuthority: 'caller_env',
      processEnv: { HOME: fixture.dir, CLAUDE_CONFIG_DIR: source },
      accountSettings: sharedSettings,
      validateGroupMutationCurrentness: async () => ({ current: true }),
    } as unknown as Parameters<typeof materializeConnectedServicesForSpawn>[0]);
    return produced!.targetMaterializedRoot!;
  }

  /** The session (launched directly into its profile home) switches to `groupId`'s active member. */
  async function switchToGroup(fixture: Awaited<ReturnType<typeof createComposedFixture>>, groupId: string, memberProfileId: string) {
    const record = claudeRecord(memberProfileId, `${groupId}-access-2`);
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: fixture.profileId } },
    };
    const normalizedBindings = {
      v: 1,
      bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', profileId: memberProfileId, groupId } },
    } as unknown as ConnectedServiceBindingsV1;
    return await settle(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      activeServerDir: configuration.activeServerDir,
      accountSettings: sharedSettings,
      processEnv: fixture.daemonEnv,
      api: {
        getAccountEncryptionMode: async () => 'plain',
        getConnectedServiceCredentialPlain: async () => ({
          content: { t: 'plain', v: record }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'c'.repeat(22)}`,
        }),
        getConnectedServiceCredentialSealed: async () => null,
        getConnectedServiceAuthGroup: async () => ({ serviceId: 'claude-subscription', groupId, activeProfileId: memberProfileId, generation: 1 }),
      } as unknown as ApiClient,
      input: {
        mode: 'apply',
        sessionId: `session-${groupId}`,
        agentId: 'claude',
        serviceId: 'claude-subscription',
        tracked: {
          startedBy: 'daemon',
          happySessionId: `session-${groupId}`,
          pid: 6200,
          spawnOptions: {
            directory: fixture.dir,
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices: previousBindings,
            environmentVariables: { CLAUDE_CONFIG_DIR: fixture.claudeHome },
          },
        },
        previous: { source: 'connected', selection: 'profile', serviceId: 'claude-subscription', profileId: fixture.profileId },
        next: { source: 'connected', selection: 'group', serviceId: 'claude-subscription', profileId: memberProfileId, groupId },
        previousBindings,
        normalizedBindings,
        groupMetadata: { groupId, activeProfileId: memberProfileId, fallbackProfileId: memberProfileId, generation: 1 },
      } as unknown as Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'],
    }));
  }

  it('switches a session into a new group and member from the source its current home records', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-group-new-primary', sentinelMode: 'readable' });
    expect((await fixture.directLaunch({ sessionId: 'session-claude-group-new', source: fixture.callerSource })).launched.kind).toBe('applied');

    const switched = await switchToGroup(fixture, 'claude-group-new', 'claude-group-new-member');
    expect(switched).toMatchObject({ kind: 'applied' });
    const member = profileHome('claude-group-new-member');
    const groupHome = switched.kind === 'applied' ? (switched.result as { targetMaterializedRoot: string }).targetMaterializedRoot : '';
    expectAllLinkedUnder(await snapshotSourceLinks(member), fixture.callerSource);
    expect(await mcpServerNames(groupHome)).toEqual(['caller-mcp']);
    expect(await readFile(join(groupHome, 'CLAUDE.md'), 'utf8')).toBe('# caller\n');
    const primaryRecord = (await readConnectedServiceStateSharingManifest(fixture.claudeHome)).nativeSourceEnv;
    expect(primaryRecord?.CLAUDE_CONFIG_DIR).toBe(fixture.callerSource);
    for (const home of [member, groupHome]) {
      expect((await readConnectedServiceStateSharingManifest(home)).nativeSourceEnv).toEqual(primaryRecord);
    }
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('refuses a switch into an existing group produced from a different source, before publishing credentials', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-group-other-primary', sentinelMode: 'readable' });
    expect((await fixture.directLaunch({ sessionId: 'session-claude-group-other', source: fixture.callerSource })).launched.kind).toBe('applied');
    const groupHome = await produceGroup(fixture, 'claude-group-other', 'claude-group-other-member', fixture.daemonSource);
    const credentialsBefore = await readFile(join(groupHome, '.credentials.json'), 'utf8');
    const memberCredentialsBefore = await readFile(join(profileHome('claude-group-other-member'), '.credentials.json'), 'utf8');

    const switched = await switchToGroup(fixture, 'claude-group-other', 'claude-group-other-member');
    expect(switched).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_conflict' } });
    expect(await readFile(join(groupHome, '.credentials.json'), 'utf8')).toBe(credentialsBefore);
    expect(await readFile(join(profileHome('claude-group-other-member'), '.credentials.json'), 'utf8')).toBe(memberCredentialsBefore);
    expect(await mcpServerNames(groupHome)).toEqual(['daemon-mcp']);
    await fixture.dispose();
  });

  it('refuses a switch into a malformed group home whose legacy member names no source, before publishing credentials', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-group-malformed-primary', sentinelMode: 'readable' });
    expect((await fixture.directLaunch({ sessionId: 'session-claude-group-malformed', source: fixture.callerSource })).launched.kind).toBe('applied');
    const groupHome = await produceGroup(fixture, 'claude-group-malformed', 'claude-group-malformed-member', fixture.callerSource);
    const member = profileHome('claude-group-malformed-member');
    const { nativeSourceEnv: _recorded, ...legacy } = await readConnectedServiceStateSharingManifest(member);
    await writeConnectedServiceStateSharingManifest(member, legacy);
    await writeFile(join(groupHome, DEFAULT_MANIFEST_NAME), 'malformed');
    const before = {
      group: await readFile(join(groupHome, '.credentials.json'), 'utf8'),
      member: await readFile(join(member, '.credentials.json'), 'utf8'),
    };

    const switched = await switchToGroup(fixture, 'claude-group-malformed', 'claude-group-malformed-member');
    expect(switched).toMatchObject({ kind: 'failed', error: { code: 'connected_service_native_source_invalid' } });
    expect({
      group: await readFile(join(groupHome, '.credentials.json'), 'utf8'),
      member: await readFile(join(member, '.credentials.json'), 'utf8'),
    }).toEqual(before);
    await fixture.dispose();
  });

  it('control: a legacy member into a legacy group home switches credential-only, keeping its links', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-group-legacy-primary', sentinelMode: 'readable' });
    expect((await fixture.directLaunch({ sessionId: 'session-claude-group-legacy', source: fixture.callerSource })).launched.kind).toBe('applied');
    const groupHome = await produceGroup(fixture, 'claude-group-legacy', 'claude-group-legacy-member', fixture.callerSource);
    for (const home of [profileHome('claude-group-legacy-member'), groupHome]) {
      const { nativeSourceEnv: _recorded, ...legacy } = await readConnectedServiceStateSharingManifest(home);
      await writeConnectedServiceStateSharingManifest(home, legacy);
    }

    const switched = await switchToGroup(fixture, 'claude-group-legacy', 'claude-group-legacy-member');
    expect(switched).toMatchObject({ kind: 'applied' });
    expect(await mcpServerNames(groupHome)).toEqual(['caller-mcp']);
    expect((await readConnectedServiceStateSharingManifest(groupHome)).nativeSourceEnv).toBeUndefined();
    expect(JSON.parse(await readFile(join(groupHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken)
      .toBe('claude-group-legacy-access-2');
    await fixture.dispose();
  });

  it('switches a session into an existing group produced from its own source', async () => {
    const fixture = await createComposedFixture({ profileId: 'claude-group-same-primary', sentinelMode: 'readable' });
    expect((await fixture.directLaunch({ sessionId: 'session-claude-group-same', source: fixture.callerSource })).launched.kind).toBe('applied');
    const groupHome = await produceGroup(fixture, 'claude-group-same', 'claude-group-same-member', fixture.callerSource);

    const switched = await switchToGroup(fixture, 'claude-group-same', 'claude-group-same-member');
    expect(switched).toMatchObject({ kind: 'applied' });
    expect(await mcpServerNames(groupHome)).toEqual(['caller-mcp']);
    expect(JSON.parse(await readFile(join(groupHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken)
      .toBe('claude-group-same-access-2');
    await fixture.dispose();
  });
});
