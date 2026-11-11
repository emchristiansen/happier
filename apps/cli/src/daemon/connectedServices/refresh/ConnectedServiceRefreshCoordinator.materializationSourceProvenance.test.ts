import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, type AccountSettings } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { CodexConnectedServiceNativeSourceConflictError } from '@/backends/codex/connectedServices/syncCodexConnectedServiceHome';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from '@/daemon/types';

import {
  reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { resolveConnectedServiceSelectionHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { registerConnectedServiceTrackedSessionTargetsForDaemon } from '../startup/runtimeTargetRegistration';
import {
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '../stateSharing/connectedServiceStateSharingManifest';
import {
  ConnectedServiceExternalCredentialUpdateRefusedError,
  ConnectedServiceRefreshCoordinator,
} from './ConnectedServiceRefreshCoordinator';

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
const STATE_ENTRIES = ['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'memories'] as const;
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

function codexRecord(profileId: string, accessToken: string, expiresInMs = 3_600_000) {
  return buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: 'openai-codex',
    profileId,
    kind: 'oauth',
    expiresAt: NOW + expiresInMs,
    oauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

async function snapshotStateLinks(codexHome: string): Promise<Record<string, string | null>> {
  const links: Record<string, string | null> = {};
  for (const entry of STATE_ENTRIES) {
    try {
      const stat = await lstat(join(codexHome, entry));
      links[entry] = stat.isSymbolicLink() ? resolve(codexHome, await readlink(join(codexHome, entry))) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      links[entry] = null;
    }
  }
  return links;
}

function expectAllLinkedUnder(links: Record<string, string | null>, root: string): void {
  for (const entry of STATE_ENTRIES) {
    expect(links[entry], entry).toBe(join(root, entry));
  }
}

const settle = <T>(work: Promise<T>) => work.then(
  (result) => ({ kind: 'applied' as const, result }),
  (error: unknown) => ({ kind: 'failed' as const, message: String(error), error }),
);

/**
 * Real direct producer (caller environment) -> real terminal registration from the session's
 * webhook metadata -> real daemon refresh coordinator holding a DISTINCT daemon environment whose
 * CODEX_HOME is an excluded sentinel. Server HTTP is synthetic; filesystem effects are real.
 */
async function createComposedFixture(params: Readonly<{
  profileId: string;
  sentinelMode: 'readable' | 'inaccessible';
}>) {
  const profileId = params.profileId;
  const dir = await mkdtemp(join(tmpdir(), 'happier-materialization-source-'));
  const callerSource = join(dir, 'caller-codex-source');
  const callerSqlite = join(dir, 'caller-codex-sqlite');
  const excludedDaemonSource = join(dir, 'daemon-codex-sentinel');
  for (const root of [callerSource, callerSqlite, excludedDaemonSource]) await mkdir(root, { recursive: true });
  await writeFile(join(callerSource, 'AGENTS.md'), '# caller\n');
  await writeFile(join(excludedDaemonSource, 'AGENTS.md'), '# excluded sentinel\n');
  const sentinelEntriesBefore = (await readdir(excludedDaemonSource)).sort();
  if (params.sentinelMode === 'inaccessible') await chmod(excludedDaemonSource, 0o000);
  const daemonEnv = { HOME: join(dir, 'daemon-home'), CODEX_HOME: excludedDaemonSource };

  const server = {
    record: codexRecord(profileId, 'synthetic-access-1'),
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
    bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId } },
  };
  const codexHome = join(resolveConnectedServiceSelectionHomeDir({
    activeServerDir: configuration.activeServerDir,
    serviceId: 'openai-codex',
    agentId: 'codex',
    fallbackProfileId: profileId,
    selection: { kind: 'profile', profileId },
  }), 'codex-home');

  const { resolveDirectConnectedServiceEnvironment, resolveDirectConnectedServiceMaterializationIdentity } =
    await import('@/cli/connectedServices/resolveDirectConnectedServiceEnvironment');

  /** The direct producer, run with the caller's own CODEX_HOME / CODEX_SQLITE_HOME. */
  const directLaunch = async (input: Readonly<{ sessionId: string; source: string; sqlite: string }>) => {
    const identity = resolveDirectConnectedServiceMaterializationIdentity(null);
    vi.stubEnv('CODEX_HOME', input.source);
    vi.stubEnv('CODEX_SQLITE_HOME', input.sqlite);
    try {
      const launched = await settle(resolveDirectConnectedServiceEnvironment({
        agentId: 'codex',
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
  const registerTerminalSession = (input: Readonly<{
    pid: number;
    sessionId: string;
    identity: unknown;
    /** Bind the session to another profile instead (a cutover). */
    profileId?: string;
  }>) =>
    registerConnectedServiceTrackedSessionTargetsForDaemon({
      tracked: {
        pid: input.pid,
        startedBy: 'terminal',
        happySessionId: input.sessionId,
        happySessionMetadataFromLocalWebhook: {
          flavor: 'codex',
          path: dir,
          connectedServices: input.profileId
            ? { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: input.profileId } } }
            : bindings,
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
    producer: 'registration' | 'delta' = 'registration',
  ) => {
    const previousRevision = server.credentialRevision;
    server.record = codexRecord(profileId, accessToken);
    server.credentialRevision = `csr_${'b'.repeat(22)}`;
    const target = {
      sessionId,
      agentId: 'codex',
      connectedServicesBindingsRaw: bindings,
      activeBindings: [{
        serviceId: 'openai-codex',
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
          credentialBoundaries: [{ serviceId: 'openai-codex', profileId, boundary }],
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

  const readAuthAccessToken = async () =>
    JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).tokens.access_token as string;

  const sentinelEntries = async () => {
    if (params.sentinelMode === 'inaccessible') await chmod(excludedDaemonSource, 0o755);
    try {
      return (await readdir(excludedDaemonSource)).sort();
    } finally {
      if (params.sentinelMode === 'inaccessible') await chmod(excludedDaemonSource, 0o000);
    }
  };

  /** The credential revision the daemon registry records as applied to a session's target. */
  const activeRevision = (sessionId: string) => runtimeRegistry.listRefreshTargets()
    .find((target) => target.sessionId === sessionId)
    ?.activeBindings.find((binding) => binding.serviceId === 'openai-codex')?.credentialRevision ?? null;

  return {
    activeRevision,
    dir,
    profileId,
    callerSource,
    callerSqlite,
    excludedDaemonSource,
    codexHome,
    server,
    api,
    coordinator,
    onAuthUpdated,
    sentinelEntriesBefore,
    directLaunch,
    registerTerminalSession,
    applyExternalRevision,
    readAuthAccessToken,
    sentinelEntries,
    dispose: async () => {
      stopObserving();
      await chmod(excludedDaemonSource, 0o755);
    },
  };
}

describe('connected-service materialization source provenance through the daemon rematerializer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['registration', 'delta'] as const)('keeps the direct caller admitted source when the daemon rematerializes after an external revision (%s producer)', async (producer) => {
    const fixture = await createComposedFixture({ profileId: `work-readable-${producer}`, sentinelMode: 'readable' });
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-readable', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    const afterDirect = await snapshotStateLinks(fixture.codexHome);
    expectAllLinkedUnder(afterDirect, fixture.callerSource);
    expect((await readConnectedServiceStateSharingManifest(fixture.codexHome)).nativeSourceEnv).toEqual({
      CODEX_HOME: fixture.callerSource,
      CODEX_SQLITE_HOME: fixture.callerSqlite,
    });

    const registered = fixture.registerTerminalSession({ pid: 4242, sessionId: 'session-readable', identity });
    expect(registered?.agentId).toBe('codex');
    expect(await snapshotStateLinks(fixture.codexHome)).toEqual(afterDirect);

    const external = await fixture.applyExternalRevision('session-readable', 'synthetic-access-2', producer);
    expect(external).toMatchObject({ kind: 'applied' });
    expect(fixture.onAuthUpdated).toHaveBeenCalledTimes(1);
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-access-2');
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it.each(['registration', 'delta'] as const)('never traverses an excluded daemon source while distributing the external revision (%s producer)', async (producer) => {
    const fixture = await createComposedFixture({ profileId: `work-excluded-${producer}`, sentinelMode: 'inaccessible' });
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-excluded', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    fixture.registerTerminalSession({ pid: 4243, sessionId: 'session-excluded', identity });

    const external = await fixture.applyExternalRevision('session-excluded', 'synthetic-access-2', producer);
    expect(external).toMatchObject({ kind: 'applied' });
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-access-2');
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('rotates an expiring credential on the daemon tick using only the recorded source', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-rotation', sentinelMode: 'inaccessible' });
    fixture.server.record = codexRecord('work-rotation', 'synthetic-expiring', 30_000);
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-rotation', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    fixture.registerTerminalSession({ pid: 4244, sessionId: 'session-rotation', identity });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh', id_token: 'synthetic-id', expires_in: 3600 }),
    })) as unknown as typeof fetch);

    const tick = await settle(fixture.coordinator.tickOnce());
    expect(tick).toMatchObject({ kind: 'applied' });
    expect(fixture.api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-rotated');
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it.each([
    ['daemon tick', 'tick'],
    ['forced appServer bridge', 'bridge'],
  ] as const)('keeps a persisted %s rotation successful without publishing into an unrecorded home', async (_label, via) => {
    const profileId = `work-rotation-unrecorded-${via}`;
    const sessionId = `session-rotation-unrecorded-${via}`;
    const fixture = await createComposedFixture({ profileId, sentinelMode: 'inaccessible' });
    fixture.server.record = codexRecord(profileId, 'synthetic-expiring', 30_000);
    const { identity, launched } = await fixture.directLaunch({ sessionId, source: fixture.callerSource, sqlite: fixture.callerSqlite });
    expect(launched.kind).toBe('applied');
    const { nativeSourceEnv: _recorded, ...unadmitted } = await readConnectedServiceStateSharingManifest(fixture.codexHome);
    await writeConnectedServiceStateSharingManifest(fixture.codexHome, unadmitted);
    fixture.registerTerminalSession({ pid: 4248, sessionId, identity });
    const revisionBefore = fixture.activeRevision(sessionId);
    const authFileBefore = await readFile(join(fixture.codexHome, 'auth.json'), 'utf8');
    const linksBefore = await snapshotStateLinks(fixture.codexHome);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh', id_token: 'synthetic-id', expires_in: 3600 }),
    })) as unknown as typeof fetch);

    const outcome = via === 'tick'
      ? await settle(fixture.coordinator.tickOnce())
      : await settle(fixture.coordinator.refreshOpenAiCodexChatGptTokensForBridge({ sessionId, chatgptPlanType: null, forceRefresh: true }));

    // The provider rotation is persisted and stays a successful credential operation; the
    // running process (bridge) receives the rotated token in-process.
    expect(outcome.kind).toBe('applied');
    if (via === 'bridge') expect(outcome).toMatchObject({ result: { accessToken: 'synthetic-rotated' } });
    expect(fixture.api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect((fixture.server.record as { oauth: { accessToken: string } }).oauth.accessToken).toBe('synthetic-rotated');
    const healthWrites = (fixture.api.updateConnectedServiceCredentialHealth as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => (input as { health: { status: string } }).health.status);
    expect(healthWrites).toEqual(['connected']);
    // The unrecorded home is not written, not traversed, gets no hot-apply, and its target's
    // registered revision does not advance.
    expect(await readFile(join(fixture.codexHome, 'auth.json'), 'utf8')).toBe(authFileBefore);
    expect(fixture.onAuthUpdated).not.toHaveBeenCalled();
    expect(fixture.activeRevision(sessionId)).toBe(revisionBefore);
    expect(await snapshotStateLinks(fixture.codexHome)).toEqual(linksBefore);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('publishes a forced appServer bridge rotation into a recorded home and hot-applies it', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-bridge-recorded', sentinelMode: 'inaccessible' });
    fixture.server.record = codexRecord('work-bridge-recorded', 'synthetic-expiring', 30_000);
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-bridge-recorded', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    fixture.registerTerminalSession({ pid: 4249, sessionId: 'session-bridge-recorded', identity });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh', id_token: 'synthetic-id', expires_in: 3600 }),
    })) as unknown as typeof fetch);

    const bridged = await settle(fixture.coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      sessionId: 'session-bridge-recorded', chatgptPlanType: null, forceRefresh: true,
    }));
    expect(bridged).toMatchObject({ kind: 'applied', result: { accessToken: 'synthetic-rotated' } });
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-rotated');
    expect(fixture.onAuthUpdated).toHaveBeenCalled();
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('still refuses a bridge refresh that credential health refuses, even for an unrecorded home', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-bridge-reauth', sentinelMode: 'inaccessible' });
    fixture.server.record = codexRecord('work-bridge-reauth', 'synthetic-expiring', 30_000);
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-bridge-reauth', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    const { nativeSourceEnv: _recorded, ...unadmitted } = await readConnectedServiceStateSharingManifest(fixture.codexHome);
    await writeConnectedServiceStateSharingManifest(fixture.codexHome, unadmitted);
    fixture.registerTerminalSession({ pid: 4250, sessionId: 'session-bridge-reauth', identity });
    fixture.api.readConnectedServiceCredentialHealth = async () => ({ kind: 'not_found' as const });
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch as unknown as typeof fetch);

    const bridged = await settle(fixture.coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      sessionId: 'session-bridge-reauth', chatgptPlanType: null, forceRefresh: true,
    }));
    expect(bridged.kind).toBe('failed');
    expect(providerFetch).not.toHaveBeenCalled();
    expect(fixture.api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-expiring');
    expect(fixture.onAuthUpdated).not.toHaveBeenCalled();
    await fixture.dispose();
  });

  it('serves the initial appServer token bridge without touching the source', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-bridge', sentinelMode: 'inaccessible' });
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-bridge', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    fixture.registerTerminalSession({ pid: 4245, sessionId: 'session-bridge', identity });
    const before = await snapshotStateLinks(fixture.codexHome);

    const bridged = await settle(fixture.coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      sessionId: 'session-bridge',
      chatgptPlanType: null,
    }));
    expect(bridged).toMatchObject({ kind: 'applied', result: { accessToken: 'synthetic-access-1' } });
    expect(await snapshotStateLinks(fixture.codexHome)).toEqual(before);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });

  it('lets a second caller with the same admitted source share the home', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-sharing', sentinelMode: 'inaccessible' });
    const first = await fixture.directLaunch({
      sessionId: 'session-sharing-1', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    const second = await fixture.directLaunch({
      sessionId: 'session-sharing-2', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(first.launched.kind).toBe('applied');
    expect(second.launched.kind).toBe('applied');
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    await fixture.dispose();
  });

  it('refuses a caller whose source conflicts with the home recorded source before relinking it', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-conflict', sentinelMode: 'inaccessible' });
    const first = await fixture.directLaunch({
      sessionId: 'session-conflict-1', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(first.launched.kind).toBe('applied');
    const otherSource = join(fixture.dir, 'other-caller-source');
    await mkdir(otherSource, { recursive: true });
    await writeFile(join(otherSource, 'AGENTS.md'), '# other caller\n');
    const otherEntriesBefore = (await readdir(otherSource)).sort();

    const conflicting = await fixture.directLaunch({
      sessionId: 'session-conflict-2', source: otherSource, sqlite: fixture.callerSqlite,
    });
    expect(conflicting.launched.kind).toBe('failed');
    expect(conflicting.launched.kind === 'failed' && conflicting.launched.error)
      .toBeInstanceOf(CodexConnectedServiceNativeSourceConflictError);
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect((await readdir(otherSource)).sort()).toEqual(otherEntriesBefore);
    await fixture.dispose();
  });

  it('lets the producing caller re-admit a home an older daemon relinked to its own source', async () => {
    const fixture = await createComposedFixture({ profileId: 'work-relinked', sentinelMode: 'readable' });
    // An older daemon's rematerialization: links to the daemon source and its manifest rewrite, which
    // drops the admitted-source field. Built with the old behavior (the daemon env as caller source).
    const { syncCodexConnectedServiceHome } = await import('@/backends/codex/connectedServices/syncCodexConnectedServiceHome');
    await syncCodexConnectedServiceHome({
      destinationCodexHome: fixture.codexHome,
      accountSettings: sharedSettings,
      processEnv: { HOME: join(fixture.dir, 'daemon-home'), CODEX_HOME: fixture.excludedDaemonSource },
      nativeSourceAuthority: 'caller_env',
    });
    const { nativeSourceEnv: _dropped, ...oldDaemonManifest } = await readConnectedServiceStateSharingManifest(fixture.codexHome);
    await writeConnectedServiceStateSharingManifest(fixture.codexHome, oldDaemonManifest);
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.excludedDaemonSource);
    const sentinelEntriesAfterOldDaemon = await fixture.sentinelEntries();
    await chmod(fixture.excludedDaemonSource, 0o000);

    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-relinked', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched).toMatchObject({ kind: 'applied' });
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    expect((await readConnectedServiceStateSharingManifest(fixture.codexHome)).nativeSourceEnv).toEqual({
      CODEX_HOME: fixture.callerSource,
      CODEX_SQLITE_HOME: fixture.callerSqlite,
    });
    fixture.registerTerminalSession({ pid: 4247, sessionId: 'session-relinked', identity });
    const external = await fixture.applyExternalRevision('session-relinked', 'synthetic-access-2');
    expect(external).toMatchObject({ kind: 'applied' });
    expectAllLinkedUnder(await snapshotStateLinks(fixture.codexHome), fixture.callerSource);
    await chmod(fixture.excludedDaemonSource, 0o755);
    expect((await readdir(fixture.excludedDaemonSource)).sort()).toEqual(sentinelEntriesAfterOldDaemon);
    await fixture.dispose();
  });

  it.each([
    ['unrecorded (legacy)', 'registration', undefined],
    ['unrecorded (legacy)', 'delta', undefined],
    ['malformed', 'registration', { CODEX_HOME: 'relative/source', CODEX_SQLITE_HOME: 'relative/sqlite' }],
    ['malformed', 'delta', { CODEX_HOME: 'relative/source', CODEX_SQLITE_HOME: 'relative/sqlite' }],
  ] as const)('refuses daemon rematerialization of a home whose admitted source is %s (%s producer)', async (_label, producer, nativeSourceEnv) => {
    const fixture = await createComposedFixture({ profileId: `work-${_label.split(' ')[0]}-${producer}`, sentinelMode: 'inaccessible' });
    const { identity, launched } = await fixture.directLaunch({
      sessionId: 'session-unadmitted', source: fixture.callerSource, sqlite: fixture.callerSqlite,
    });
    expect(launched.kind).toBe('applied');
    // A home whose links predate (or lost) the admitted-source record: provenance is unknown.
    const { nativeSourceEnv: _recorded, ...unadmitted } = await readConnectedServiceStateSharingManifest(fixture.codexHome);
    await writeConnectedServiceStateSharingManifest(fixture.codexHome, {
      ...unadmitted,
      ...(nativeSourceEnv ? { nativeSourceEnv } : {}),
    });
    fixture.registerTerminalSession({ pid: 4246, sessionId: 'session-unadmitted', identity });
    const linksBefore = await snapshotStateLinks(fixture.codexHome);

    const external = await fixture.applyExternalRevision('session-unadmitted', 'synthetic-access-2', producer);
    // The revision stays unacknowledged (its producer retries), nothing is published into the home,
    // no live-session auth update is driven, and credential health is not touched.
    expect(external.kind).toBe('failed');
    expect(external.kind === 'failed' && external.error).toBeInstanceOf(ConnectedServiceExternalCredentialUpdateRefusedError);
    expect(external.kind === 'failed' && external.message).toContain('connected_service_native_source_unrecorded');
    expect(await fixture.readAuthAccessToken()).toBe('synthetic-access-1');
    expect(fixture.onAuthUpdated).not.toHaveBeenCalled();
    expect(fixture.api.updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
    expect(await snapshotStateLinks(fixture.codexHome)).toEqual(linksBefore);
    expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
    await fixture.dispose();
  });
  describe('SP-14: bridge delivery requires the caller still registered on the profile after awaited work', () => {
    type Event = 'release-during-health-read' | 'release-before-final-plan' | 'release-during-final-read'
      | 'cutover-during-final-read' | 'replacement-during-final-read';

    async function bridgeWith(params: Readonly<{ home: 'recorded' | 'unrecorded'; event: Event }>) {
      const sessionId = `sp14-${params.home}-${params.event}`;
      const fixture = await createComposedFixture({ profileId: `sp14-${params.home}-${params.event}`, sentinelMode: 'inaccessible' });
      fixture.server.record = codexRecord(fixture.profileId, 'synthetic-expiring', 30_000);
      const { identity, launched } = await fixture.directLaunch({
        sessionId, source: fixture.callerSource, sqlite: fixture.callerSqlite,
      });
      expect(launched.kind).toBe('applied');
      if (params.home === 'unrecorded') {
        const { nativeSourceEnv: _recorded, ...unadmitted } = await readConnectedServiceStateSharingManifest(fixture.codexHome);
        await writeConnectedServiceStateSharingManifest(fixture.codexHome, unadmitted);
      }
      fixture.registerTerminalSession({ pid: 9001, sessionId, identity });
      const authBefore = await readFile(join(fixture.codexHome, 'auth.json'), 'utf8');
      const linksBefore = await snapshotStateLinks(fixture.codexHome);
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh', id_token: 'synthetic-id', expires_in: 3600 }),
      })) as unknown as typeof fetch);

      let fired = false;
      const fire = () => {
        if (fired) return;
        fired = true;
        if (params.event === 'cutover-during-final-read') {
          fixture.registerTerminalSession({ pid: 9001, sessionId, identity, profileId: `${fixture.profileId}-other` });
        } else if (params.event === 'replacement-during-final-read') {
          fixture.coordinator.unregisterPid(9001);
          fixture.registerTerminalSession({ pid: 9002, sessionId, identity });
        } else {
          fixture.coordinator.unregisterPid(9001);
        }
      };
      const healthWrites = () => (fixture.api.updateConnectedServiceCredentialHealth as ReturnType<typeof vi.fn>).mock.calls
        .map(([input]) => (input as { health: { status: string } }).health.status);
      if (params.event === 'release-during-health-read') {
        const read = fixture.api.readConnectedServiceCredentialHealth as (...args: unknown[]) => Promise<unknown>;
        fixture.api.readConnectedServiceCredentialHealth = async (...args: unknown[]) => {
          const result = await read(...args);
          fire();
          return result;
        };
      } else if (params.event === 'release-before-final-plan') {
        const update = fixture.api.updateConnectedServiceCredentialHealth as (...args: unknown[]) => Promise<unknown>;
        fixture.api.updateConnectedServiceCredentialHealth = vi.fn(async (...args: unknown[]) => {
          const result = await update(...args);
          fire();
          return result;
        });
      } else {
        // The final credential read happens inside distribution, after the persisted rotation's
        // connected health write and after the target plan was captured.
        const readPlain = fixture.api.getConnectedServiceCredentialPlain as (...args: unknown[]) => Promise<unknown>;
        fixture.api.getConnectedServiceCredentialPlain = async (...args: unknown[]) => {
          const result = await readPlain(...args);
          if (healthWrites().includes('connected')) fire();
          return result;
        };
      }
      const outcome = await settle(fixture.coordinator.refreshOpenAiCodexChatGptTokensForBridge({
        sessionId, chatgptPlanType: null, forceRefresh: true,
      }));
      return { fixture, outcome, fired, authBefore, linksBefore, healthWrites };
    }

    it.each([
      ['unrecorded', 'release-during-health-read'],
      ['unrecorded', 'release-before-final-plan'],
      ['unrecorded', 'release-during-final-read'],
      ['unrecorded', 'cutover-during-final-read'],
      ['recorded', 'release-during-final-read'],
      ['recorded', 'cutover-during-final-read'],
    ] as const)('refuses the token to a %s-home caller after %s, keeping the persisted rotation truthful', async (home, event) => {
      const { fixture, outcome, fired, authBefore, linksBefore, healthWrites } = await bridgeWith({ home, event });
      expect(fired).toBe(true);
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.message).toContain('connected_service_bridge_selection_not_authorized');
      // The provider rotation itself persisted and its health is the truthful provider outcome.
      expect(fixture.api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
      expect((fixture.server.record as { oauth: { accessToken: string } }).oauth.accessToken).toBe('synthetic-rotated');
      expect(healthWrites()).toEqual(['connected']);
      if (home === 'unrecorded') {
        expect(await readFile(join(fixture.codexHome, 'auth.json'), 'utf8')).toBe(authBefore);
        expect(await snapshotStateLinks(fixture.codexHome)).toEqual(linksBefore);
        expect(fixture.onAuthUpdated).not.toHaveBeenCalled();
      }
      expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
      await fixture.dispose();
    });

    it.each(['unrecorded', 'recorded'] as const)('still delivers to a %s-home session whose process was replaced during the final read', async (home) => {
      const { fixture, outcome, fired, authBefore, linksBefore, healthWrites } = await bridgeWith({ home, event: 'replacement-during-final-read' });
      expect(fired).toBe(true);
      expect(outcome).toMatchObject({ kind: 'applied', result: { accessToken: 'synthetic-rotated' } });
      expect(healthWrites()).toEqual(['connected']);
      if (home === 'unrecorded') {
        expect(await readFile(join(fixture.codexHome, 'auth.json'), 'utf8')).toBe(authBefore);
        expect(await snapshotStateLinks(fixture.codexHome)).toEqual(linksBefore);
      }
      expect(await fixture.sentinelEntries()).toEqual(fixture.sentinelEntriesBefore);
      await fixture.dispose();
    });
  });
});
