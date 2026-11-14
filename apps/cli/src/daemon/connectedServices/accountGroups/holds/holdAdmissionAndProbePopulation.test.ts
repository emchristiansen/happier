import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';

import {
  createConnectedServiceMemberHoldStore,
  type ConnectedServiceMemberHold,
  type ConnectedServiceMemberHoldStore,
} from './connectedServiceMemberHolds';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
} from '../switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceAuthGroupSwitchState } from '../switching/pipeline/switchPipeline';
import { NEW_CALLER_SPAWN_NATIVE_SOURCE } from '../../connectedServiceSpawnNativeSource';
import { resolveConnectedServiceAuthForSpawn } from '../../resolveConnectedServiceAuthForSpawn';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;

function hold(profileId: string, untilMs?: number): ConnectedServiceMemberHold {
  return {
    serviceId: SERVICE_ID, profileId, reason: 'known weekly limit', source: 'operator', heldAtMs: NOW,
    lifetime: untilMs === undefined ? { kind: 'until_released' } : { kind: 'until', untilMs },
  };
}

async function tempStore(): Promise<Readonly<{ dir: string; filePath: string; store: ConnectedServiceMemberHoldStore }>> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-hold-admission-'));
  const filePath = join(dir, 'holds.json');
  return { dir, filePath, store: createConnectedServiceMemberHoldStore({ filePath }) };
}

/**
 * The real daemon coordinator factory, switch FSM, selector and hold store against a synthetic
 * server. `onPrepare` / `onPreflight` run inside the awaited corridor between selection and the
 * active-profile write, which is exactly where a concurrent operator hold lands.
 */
async function daemonFixture(input: Readonly<{
  onPrepare?: (profileId: string, store: ConnectedServiceMemberHoldStore, filePath: string) => Promise<void>;
  onPreflight?: (profileId: string, store: ConnectedServiceMemberHoldStore) => Promise<void>;
}>) {
  const { dir, filePath, store } = await tempStore();
  let activeProfileId = 'A';
  let generation = 1;
  const commits: string[] = [];
  const applied: string[] = [];
  const prepared: string[] = [];
  const preflighted: string[] = [];
  const credentialReads: string[] = [];
  const group = () => ({
    v: 1, serviceId: SERVICE_ID, groupId: 'g', displayName: null, activeProfileId, generation, runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority', preTurnProbeMode: 'never' }),
    state: { v: 1 },
    members: ['A', 'B', 'C'].map((profileId, index) => ({
      v: 1, serviceId: SERVICE_ID, groupId: 'g', profileId, priority: index + 1, enabled: true,
      state: { v: 1 }, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1, updatedAt: 1,
  });
  const api = {
    getConnectedServiceAuthGroup: async () => group(),
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async ({ profileId }: { profileId: string }) => {
      credentialReads.push(profileId);
      throw new Error(`CREDENTIAL_READ:${profileId}`);
    },
    updateConnectedServiceAuthGroupRuntimeState: async () => group(),
    updateConnectedServiceAuthGroupActiveProfile: async ({ activeProfileId: target }: { activeProfileId: string }) => {
      commits.push(target);
      activeProfileId = target;
      generation += 1;
      return group();
    },
  };
  const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    api: api as unknown as ApiClient,
    readMemberHolds: () => store.readForService(SERVICE_ID),
    runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    quotaFreshnessMs: 60_000,
    nowMs: () => NOW,
    resolveCurrentCredentialRevision: async () => null,
    prepareCandidateForSwitch: async ({ profileId }: { profileId: string }) => {
      prepared.push(profileId);
      await input.onPrepare?.(profileId, store, filePath);
      return { status: 'ready' };
    },
    ...(input.onPreflight ? {
      preflightConnectedServiceAuthGeneration: async ({ activeProfileId: target }: { activeProfileId: string | null }) => {
        if (target) {
          preflighted.push(target);
          await input.onPreflight?.(target, store);
        }
        return { ok: true, action: 'hot_applied' };
      },
    } : {}),
    restartSession: async ({ activeProfileId: target }: { activeProfileId: string | null }) => {
      if (target) applied.push(target);
    },
    applyConnectedServiceAuthGeneration: async ({ activeProfileId: target }: { activeProfileId: string | null }) => {
      if (target) applied.push(target);
      return { ok: true, action: 'hot_applied' };
    },
  } as unknown as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]);
  return { dir, store, api, coordinator, commits, applied, prepared, preflighted, credentialReads };
}

describe('member holds at switch admission (HOLD-01)', () => {
  it('reselects when the prepared candidate becomes held during preparation: no commit or apply of it', async () => {
    const f = await daemonFixture({
      onPrepare: async (profileId, store) => {
        if (profileId === 'B') await store.set(hold('B'));
      },
    });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'C' });
    expect(f.prepared).toEqual(['B', 'C']);
    expect(f.commits).toEqual(['C']);
    expect(f.applied).not.toContain('B');
  });

  it('refuses at commit admission when the target becomes held during apply preflight, then reselects', async () => {
    const f = await daemonFixture({
      onPreflight: async (profileId, store) => {
        if (profileId === 'B') await store.set(hold('B'));
      },
    });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'same_provider_account_exhausted',
    });
    expect(f.preflighted[0]).toBe('B');
    expect(f.commits).toEqual(['C']);
    expect(f.applied).not.toContain('B');
    expect(result).toMatchObject({ activeProfileId: 'C' });
  });

  it('terminates truthfully without committing when hold state becomes unreadable during preparation', async () => {
    const f = await daemonFixture({
      onPrepare: async (_profileId, _store, filePath) => {
        await writeFile(filePath, '{not json');
      },
    });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(result).toMatchObject({ status: 'no_eligible_member' });
    expect(f.commits).toEqual([]);
    expect(f.applied).toEqual([]);
  });

  it('terminates with the earliest hold expiry when every remaining candidate becomes held', async () => {
    const f = await daemonFixture({
      onPrepare: async (profileId, store) => {
        if (profileId === 'B') {
          await store.set(hold('B', NOW + 9_000));
          await store.set(hold('C', NOW + 7_000));
        }
      },
    });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(result).toMatchObject({ status: 'no_eligible_member', retryAtMs: NOW + 7_000 });
    expect(f.commits).toEqual([]);
  });

  it('group spawn never reads the credential of a member held while the spawn switch was preparing it', async () => {
    const f = await daemonFixture({
      onPrepare: async (profileId, store) => {
        if (profileId === 'B') await store.set(hold('B'));
      },
    });
    await f.store.set(hold('A'));
    const outcome = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { [SERVICE_ID]: { source: 'connected', selection: 'group', groupId: 'g', profileId: 'A' } },
      },
      materializationKey: 'holds',
      nativeSource: NEW_CALLER_SPAWN_NATIVE_SOURCE,
      activeServerDir: join(f.dir, 'server'),
      baseDir: join(f.dir, 'base'),
      credentials: { token: 'synthetic', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) } },
      api: f.api as unknown as ApiClient,
      nowMs: () => NOW,
      processEnv: { HOME: join(f.dir, 'home') },
      readMemberHolds: () => f.store.readForService(SERVICE_ID),
      authGroupSwitchCoordinator: f.coordinator,
    } as unknown as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(f.credentialReads).not.toContain('B');
    expect(f.credentialReads).toEqual(['C']);
    expect(String(outcome)).toContain('CREDENTIAL_READ:C');
  });
});

describe('member holds in the quota-probe prerequisite population (HOLD-02)', () => {
  function plainState(input: Readonly<{
    policy: ConnectedServiceAuthGroupSwitchState['policy'];
    members: ReadonlyArray<string>;
    memberStatesByProfileId?: ConnectedServiceAuthGroupSwitchState['memberStatesByProfileId'];
    memberHolds: ConnectedServiceAuthGroupSwitchState['memberHolds'];
  }>): ConnectedServiceAuthGroupSwitchState {
    return {
      serviceId: SERVICE_ID, groupId: 'g', activeProfileId: 'A', generation: 1, runtimeStateRevision: 0,
      policy: input.policy,
      members: input.members.map((profileId, index) => ({ profileId, priority: index + 1, createdAtMs: 1, enabled: true })),
      memberStatesByProfileId: input.memberStatesByProfileId ?? new Map(),
      memberHolds: input.memberHolds,
    } as unknown as ConnectedServiceAuthGroupSwitchState;
  }

  function coordinatorFor(state: { current: ConnectedServiceAuthGroupSwitchState }, probes: string[][], commits: string[]) {
    return new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => NOW,
      quotaFreshnessMs: 60_000,
      loadState: async () => state.current,
      commitSwitch: async ({ toProfileId }: { toProfileId: string }) => {
        commits.push(toProfileId);
        state.current = { ...state.current, activeProfileId: toProfileId, generation: state.current.generation + 1 };
        return state.current;
      },
      applyGeneration: async () => ({ mode: 'hot_apply' as const }),
      probeQuotaSnapshotsForGroup: async ({ profileIds }: { profileIds: ReadonlyArray<string> }) => {
        probes.push([...profileIds]);
        // Production-compatible provider backoff: every requested profile accounted for as deferred.
        return {
          status: 'complete',
          completedProfileCount: 0,
          deferredProfiles: profileIds.map((profileId: string) => ({ profileId, retryAtMs: NOW + 60_000 })),
        } as never;
      },
    } as unknown as ConstructorParameters<typeof ConnectedServiceAuthGroupSwitchCoordinator>[0]);
  }

  it('a held member with stale quota is not probed and does not strand a fresh unheld member (default when_stale)', async () => {
    const { store } = await tempStore();
    await store.set(hold('B'));
    const state = {
      current: plainState({
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true, preTurnProbeMode: 'when_stale' },
        members: ['A', 'B', 'C'],
        memberStatesByProfileId: new Map([['C', { quotaSnapshot: { capturedAtMs: NOW, effectiveRemainingPercent: 80 } }]]) as never,
        memberHolds: await store.readForService(SERVICE_ID),
      }),
    };
    const probes: string[][] = [];
    const commits: string[] = [];
    const result = await coordinatorFor(state, probes, commits).switchAfterClassifiedFailure({
      serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(probes.flat()).not.toContain('B');
    expect(result).toMatchObject({ status: 'switched', activeProfileId: 'C' });
    expect(commits).toEqual(['C']);
  });

  it('an all-held group terminates on its earliest hold expiry without requesting quota proof', async () => {
    const { store } = await tempStore();
    await store.set(hold('A', NOW + 7_000));
    await store.set(hold('B', NOW + 9_000));
    const state = {
      current: plainState({
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true, preTurnProbeMode: 'always_for_group' },
        members: ['A', 'B'],
        memberHolds: await store.readForService(SERVICE_ID),
      }),
    };
    const probes: string[][] = [];
    const commits: string[] = [];
    const result = await coordinatorFor(state, probes, commits).switchAfterClassifiedFailure({
      serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(probes).toEqual([]);
    expect(result).toMatchObject({ status: 'no_eligible_member', retryAtMs: NOW + 7_000 });
    expect(commits).toEqual([]);
  });

  it('unreadable hold state requests no probe and reports hold_state_unreadable, not quota_proof_unavailable', async () => {
    const state = {
      current: plainState({
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true, preTurnProbeMode: 'always_for_group' },
        members: ['A', 'B'],
        memberHolds: { status: 'unreadable', error: 'invalid member hold file' },
      }),
    };
    const probes: string[][] = [];
    const commits: string[] = [];
    const result = await coordinatorFor(state, probes, commits).switchAfterClassifiedFailure({
      serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(probes).toEqual([]);
    expect(result).toMatchObject({ status: 'no_eligible_member' });
    expect(JSON.stringify(result)).toContain('hold_state_unreadable');
    expect(commits).toEqual([]);
  });

  it('still probes an unheld stale candidate (positive control), and its deferral is honoured', async () => {
    const { store } = await tempStore();
    await store.set(hold('B'));
    const state = {
      current: plainState({
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true, preTurnProbeMode: 'when_stale' },
        members: ['A', 'B', 'C'],
        memberHolds: await store.readForService(SERVICE_ID),
      }),
    };
    const probes: string[][] = [];
    const commits: string[] = [];
    const result = await coordinatorFor(state, probes, commits).switchAfterClassifiedFailure({
      serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'usage_limit',
    });
    expect(probes.flat()).toContain('C');
    expect(probes.flat()).not.toContain('B');
    expect(result).toMatchObject({ status: 'quota_proof_unavailable' });
    expect(commits).toEqual([]);
  });
});
