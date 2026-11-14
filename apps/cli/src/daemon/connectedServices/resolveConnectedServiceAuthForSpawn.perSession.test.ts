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
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from './descriptors/connectedAccountDescriptors';
import { resolveConnectedServiceSelectionHomeDir } from './homes/resolveConnectedServiceHomeDir';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { ConnectedServicePerSessionSpawnError } from './accountGroups/perSession/resolvePerSessionGroupMemberForSpawn';

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

function perSessionGroup(): ConnectedServiceAuthGroupV1 {
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
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'per_session_softmax' }),
    state: { v: 1 },
    members: [member('a', 1), member('b', 2)],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function fixture() {
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
    getConnectedServiceAuthGroup: vi.fn(async () => perSessionGroup()),
    updateConnectedServiceAuthGroupActiveProfile,
    getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) =>
      params.serviceId === 'claude-subscription' ? sealedFor(params.profileId) : null),
  } as unknown as ApiClient;
  const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const ledger = new PerSessionAssignmentLedger(resolvePerSessionAssignmentLedgerPath(activeServerDir));
  return { baseDir, activeServerDir, processEnv, api, runtimeQuotaSnapshots, ledger, updateConnectedServiceAuthGroupActiveProfile };
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
      perSessionAssignment: { ledger: f.ledger, ownerMachineId: 'machine-1', reservationApi: null, uniformSample: () => 0.0001 },
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
      perSessionAssignment: { ledger: f.ledger, ownerMachineId: 'machine-1', reservationApi: null, uniformSample: () => 0.99 },
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
      perSessionAssignment: { ledger: f.ledger, ownerMachineId: 'machine-1', reservationApi: null },
    })).rejects.toBeInstanceOf(ConnectedServicePerSessionSpawnError);
    expect(f.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
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
