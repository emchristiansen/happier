import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupPolicyV1Schema,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { resolveClaudeCodeCredentialsFilePath } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import { NEW_CALLER_SPAWN_NATIVE_SOURCE } from '@/daemon/connectedServices/connectedServiceSpawnNativeSource';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { PerSessionAssignmentLedger, resolvePerSessionAssignmentLedgerPath } from './accountGroups/perSession/PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime } from './accountGroups/perSession/PerSessionAssignmentRuntime';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from './descriptors/connectedAccountDescriptors';
import { resolveConnectedServiceSelectionHomeDir } from './homes/resolveConnectedServiceHomeDir';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { ConnectedServicePerSessionSpawnError } from './accountGroups/perSession/resolvePerSessionGroupMemberForSpawn';
import {
  ConnectedServiceGroupMemberHeldForSpawnError,
  NO_CONNECTED_SERVICE_MEMBER_HOLDS,
  type ConnectedServiceMemberHoldView,
} from './accountGroups/holds/connectedServiceMemberHolds';

const NOW = 1_000_000;

const credentials = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
} satisfies Credentials;

function sealedFor(profileId: string) {
  if (credentials.encryption.type !== 'legacy') throw new Error('legacy fixture');
  const record = buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'oauth',
    expiresAt: NOW + 3_600_000,
    oauth: {
      accessToken: `${profileId}-access`,
      refreshToken: `${profileId}-refresh`,
      idToken: null,
      scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: `${profileId}-acct`,
      providerEmail: null,
    },
  });
  return {
    sealed: {
      format: 'account_scoped_v1',
      ciphertext: sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: record,
        randomBytes: (length) => randomBytes(length),
      }),
    },
    metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: record.expiresAt },
  };
}

function perSessionGroup(strategy: 'per_session_softmax' | 'priority' = 'per_session_softmax'): ConnectedServiceAuthGroupV1 {
  const member = (profileId: string, priority: number) => ({
    v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'pool', profileId,
    enabled: true, priority, state: { v: 1 as const }, createdAt: priority, updatedAt: priority,
  });
  return {
    v: 1,
    serviceId: 'claude-subscription',
    groupId: 'pool',
    displayName: null,
    activeProfileId: 'a',
    generation: 3,
    runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy }),
    state: { v: 1 },
    members: [member('a', 1), member('b', 2)],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function fixture(strategy: 'per_session_softmax' | 'priority' = 'per_session_softmax') {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-per-session-spawn-base-'));
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-per-session-spawn-server-'));
  const home = await mkdtemp(join(tmpdir(), 'happier-per-session-spawn-home-'));
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  const processEnv = { HOME: home, USER: 'happier-test-user', CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => {
    throw new Error('per-session spawn must never move the shared pointer');
  });
  const api = {
    readConnectedServiceCredentialHealth: vi.fn(async () => ({ kind: 'found' as const, status: 'connected' as const, health: null })),
    getConnectedServiceAuthGroup: vi.fn(async () => perSessionGroup(strategy)),
    updateConnectedServiceAuthGroupActiveProfile,
    getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) =>
      params.serviceId === 'claude-subscription' ? sealedFor(params.profileId) : null),
  } as unknown as ApiClient;
  const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const ledger = new PerSessionAssignmentLedger(resolvePerSessionAssignmentLedgerPath(activeServerDir));
  const runtime = new PerSessionAssignmentRuntime({
    ledger, ownerMachineId: 'machine-1', reservationApi: null, nowMs: () => NOW,
    listLiveDecisions: () => [], listLiveSubjectIds: () => new Set(), probeRunnerPresence: async () => 'present',
  });
  const deps = (uniformSample?: () => number) => ({ ...runtime.spawnDeps, ...(uniformSample ? { uniformSample } : {}) });
  return { baseDir, activeServerDir, processEnv, api, runtimeQuotaSnapshots, ledger, deps, updateConnectedServiceAuthGroupActiveProfile };
}

function recordScores(store: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore, scores: Record<string, number>) {
  for (const [profileId, remaining] of Object.entries(scores)) {
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'pool',
      profileId,
      snapshot: {
        v: 1, serviceId: 'claude-subscription', profileId, fetchedAt: NOW - 1, staleAfterMs: 300_000,
        planLabel: 'Max', accountLabel: `${profileId}@example.test`,
        meters: [{
          meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown',
          utilizationPct: 100 - remaining, remainingPct: remaining, resetsAt: NOW + 600_000, status: 'ok', details: {},
        }],
      },
    });
  }
}

describe('resolveConnectedServiceAuthForSpawn per_session_softmax', () => {
  it('materializes the drawn member through its own member home without moving the shared pointer (T1, T2)', async () => {
    const f = await fixture();
    recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
    const result = await resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
      },
      materializationKey: 'session-1',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      sessionId: 'session-1',
      perSessionAssignment: f.deps(() => 0.0001),
    });

    const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, unknown>;
    const drawn = (binding.materializedAssignment as { profileId: string }).profileId;
    expect(['a', 'b']).toContain(drawn);
    expect(binding).toMatchObject({
      source: 'connected', selection: 'group', groupId: 'pool',
      // No reservation resource: local degraded selection at 2τ.
      materializedAssignment: { profileId: drawn, reason: 'initial_sampled', temperature: 3, offsetPercent: 10 },
    });
    expect(binding.member).toBeUndefined();
    expect(f.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();

    const memberHome = resolveConnectedServiceSelectionHomeDir({
      activeServerDir: f.activeServerDir, serviceId: 'claude-subscription', agentId: 'claude', fallbackProfileId: drawn,
      selection: { kind: 'profile', profileId: drawn },
    });
    expect(result!.env.CLAUDE_CONFIG_DIR!.startsWith(memberHome)).toBe(true);
    const credential = JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(result!.env.CLAUDE_CONFIG_DIR!), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe(`${drawn}-access`);

    const entries = f.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: 'session-1', origin: 'spawn', state: 'pending', proposal: { profileId: drawn } });
  });

  it('starts an explicitly named member (T8) and replays the same decision on a retried spawn', async () => {
    const f = await fixture();
    recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
    const spawn = () => resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', initialProfileId: 'a' },
        },
      },
      materializationKey: 'session-2',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      sessionId: 'session-2',
      perSessionAssignment: f.deps(() => 0.99),
    });
    const first = await spawn();
    const firstBinding = first!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
    expect(firstBinding.materializedAssignment).toMatchObject({ profileId: 'a', reason: 'initial_requested' });
    expect(firstBinding.initialProfileId).toBe('a');
    const second = await spawn();
    const secondBinding = second!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
    expect(f.ledger.list()).toHaveLength(1);
    expect(secondBinding.materializedAssignment.decisionId).toBe(firstBinding.materializedAssignment.decisionId);
  });

  describe('member holds (composition with t_1b770ae5 HOLD-01/02)', () => {
    const heldView = (...profileIds: string[]): ConnectedServiceMemberHoldView => ({
      status: 'readable',
      holdsByProfileId: new Map(profileIds.map((profileId) => [profileId, {
        serviceId: 'claude-subscription', profileId, reason: 'operator hold', source: 'test', heldAtMs: NOW - 1,
        lifetime: { kind: 'until_released' as const },
      }])),
    });
    const spawnWith = (f: Awaited<ReturnType<typeof fixture>>, readMemberHolds: () => Promise<ConnectedServiceMemberHoldView>, binding: Record<string, unknown> = {}) =>
      resolveConnectedServiceAuthForSpawn({
        nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
        agentId: 'claude',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', ...binding } },
        },
        materializationKey: 'session-held',
        activeServerDir: f.activeServerDir,
        baseDir: f.baseDir,
        credentials,
        api: f.api,
        processEnv: f.processEnv,
        runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
        quotaFreshnessMs: 300_000,
        nowMs: () => NOW,
        sessionId: 'session-held',
        perSessionAssignment: f.deps(() => 0.0001),
        readMemberHolds,
      });

    it('never draws a held member', async () => {
      for (const sample of [0.0001, 0.5, 0.9999]) {
        const f = await fixture();
        recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
        const result = await resolveConnectedServiceAuthForSpawn({
          nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE, agentId: 'claude',
          connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } } },
          materializationKey: 'session-held', activeServerDir: f.activeServerDir, baseDir: f.baseDir, credentials, api: f.api,
          processEnv: f.processEnv, runtimeQuotaSnapshots: f.runtimeQuotaSnapshots, quotaFreshnessMs: 300_000, nowMs: () => NOW,
          sessionId: 'session-held', perSessionAssignment: f.deps(() => sample), readMemberHolds: async () => heldView('b'),
        });
        const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
        expect(binding.materializedAssignment.profileId).toBe('a');
      }
    });

    it('fails a named start on a held member over to an eligible one', async () => {
      const f = await fixture();
      recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
      const result = await spawnWith(f, async () => heldView('b'), { initialProfileId: 'b' });
      const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
      expect(binding.materializedAssignment).toMatchObject({ profileId: 'a', reason: 'initial_unavailable_failover' });
    });

    it('refuses at final admission when the drawn member became held meanwhile, releasing the never-launched decision', async () => {
      const f = await fixture();
      recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
      let reads = 0;
      // The draw sees no holds; the admission read just before launch sees every member held.
      const readMemberHolds = async () => (reads++ === 0 ? NO_CONNECTED_SERVICE_MEMBER_HOLDS : heldView('a', 'b'));
      await expect(spawnWith(f, readMemberHolds)).rejects.toBeInstanceOf(ConnectedServiceGroupMemberHeldForSpawnError);
      expect(f.ledger.list()).toHaveLength(0);
    });

    it('refuses when holds cannot be read rather than treating them as empty', async () => {
      const f = await fixture();
      recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
      await expect(spawnWith(f, async () => ({ status: 'unreadable', error: 'corrupt hold file' })))
        .rejects.toBeTruthy();
      expect(f.ledger.list().filter((entry) => entry.state === 'applied')).toHaveLength(0);
    });

    it('does not keep an owned member that became held after a rollback; it converts through the group home', async () => {
      const f = await fixture('priority');
      recordScores(f.runtimeQuotaSnapshots, { a: 90, b: 60 });
      const result = await spawnWith(f, async () => heldView('b'), {
        member: { assignment: 'per_session', profileId: 'b', decisionId: 'spawn-owned', reason: 'initial_sampled', appliedAtMs: 1 },
      });
      const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
      expect(binding.materializedAssignment).toMatchObject({ reason: 'policy_conversion', home: 'group', profileId: 'a' });
    });
  });

  it('refuses a spawn when no member has a known score instead of imputing quota', async () => {
    const f = await fixture();
    await expect(resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
      },
      materializationKey: 'session-3',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      sessionId: 'session-3',
      perSessionAssignment: f.deps(),
    })).rejects.toBeInstanceOf(ConnectedServicePerSessionSpawnError);
    expect(f.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('releases the decision a spawn created when the attempt fails before launching anything (T17 definite pre-launch failure)', async () => {
    const f = await fixture();
    recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
    // Credential read fails after the decision was made: nothing can have launched.
    vi.mocked((f.api as unknown as { getConnectedServiceCredentialSealed: () => unknown }).getConnectedServiceCredentialSealed)
      .mockRejectedValue(new Error('credential store unavailable'));
    await expect(resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
      },
      materializationKey: 'session-5',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      sessionId: 'session-5',
      perSessionAssignment: f.deps(() => 0.5),
    })).rejects.toThrow();
    expect(f.ledger.list()).toHaveLength(0);
  });

  describe('after the group strategy is rolled back (T12)', () => {
    const ownedBinding = (member: string) => ({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected', selection: 'group', groupId: 'pool',
          member: { assignment: 'per_session', profileId: member, decisionId: 'spawn-owned', reason: 'initial_sampled', appliedAtMs: 1 },
        },
      },
    });
    const spawnOwned = async (f: Awaited<ReturnType<typeof fixture>>, member: string) => await resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: ownedBinding(member),
      materializationKey: 'session-owned',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      quotaFreshnessMs: 300_000,
      nowMs: () => NOW,
      sessionId: 'session-owned',
      perSessionAssignment: f.deps(),
    });

    it('resumes a session on its own member and member home while the shared pointer stays elsewhere', async () => {
      const f = await fixture('priority');
      recordScores(f.runtimeQuotaSnapshots, { a: 90, b: 60 });
      const result = await spawnOwned(f, 'b');
      const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
      expect(binding.member).toMatchObject({ profileId: 'b', decisionId: 'spawn-owned' });
      const memberHome = resolveConnectedServiceSelectionHomeDir({
        activeServerDir: f.activeServerDir, serviceId: 'claude-subscription', agentId: 'claude', fallbackProfileId: 'b',
        selection: { kind: 'profile', profileId: 'b' },
      });
      expect(result!.env.CLAUDE_CONFIG_DIR!.startsWith(memberHome)).toBe(true);
      expect(result!.perSessionSpawnDecisionIds ?? []).toEqual([]);
      expect(f.ledger.list()).toHaveLength(0);
      expect(f.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    });

    it('converts to the shared group path when the owned member can no longer serve', async () => {
      const f = await fixture('priority');
      recordScores(f.runtimeQuotaSnapshots, { a: 90, b: 0 });
      const result = await spawnOwned(f, 'b');
      const binding = result!.connectedServicesBindings.bindingsByServiceId['claude-subscription'] as Record<string, any>;
      // Ownership ends only when the provider proves the group account (spec A.4 Migration): the launch
      // keeps the applied member and records a pending conversion to the group's shared home.
      expect(binding.member).toMatchObject({ profileId: 'b' });
      expect(binding.materializedAssignment).toMatchObject({ reason: 'policy_conversion', home: 'group', fromProfileId: 'b', profileId: 'a' });
      const memberHome = resolveConnectedServiceSelectionHomeDir({
        activeServerDir: f.activeServerDir, serviceId: 'claude-subscription', agentId: 'claude', fallbackProfileId: 'b',
        selection: { kind: 'profile', profileId: 'b' },
      });
      expect(result!.env.CLAUDE_CONFIG_DIR!.startsWith(memberHome)).toBe(false);
    });
  });

  it('fails closed when the daemon supplies no per-session facilities', async () => {
    const f = await fixture();
    recordScores(f.runtimeQuotaSnapshots, { a: 30, b: 90 });
    await expect(resolveConnectedServiceAuthForSpawn({
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' } },
      },
      materializationKey: 'session-4',
      activeServerDir: f.activeServerDir,
      baseDir: f.baseDir,
      credentials,
      api: f.api,
      processEnv: f.processEnv,
      runtimeQuotaSnapshots: f.runtimeQuotaSnapshots,
      nowMs: () => NOW,
      sessionId: 'session-4',
    })).rejects.toMatchObject({ code: 'per_session_assignment_host_unsupported' });
  });
});
