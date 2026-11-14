import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';

import { createConnectedServiceMemberHoldStore, type ConnectedServiceMemberHold } from './connectedServiceMemberHolds';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;

function hold(profileId: string, untilMs?: number): ConnectedServiceMemberHold {
  return {
    serviceId: SERVICE_ID, profileId, reason: 'known weekly limit', source: 'operator', heldAtMs: NOW,
    lifetime: untilMs === undefined ? { kind: 'until_released' } : { kind: 'until', untilMs },
  };
}

/**
 * Real daemon coordinator factory, FSM, selector and hold store over a synthetic server whose group
 * is already active on `active`. The application/preflight adapters are the process boundaries.
 */
async function fixture(input: Readonly<{ active: string; onPreflight?: (profileId: string) => Promise<void> }>) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-hold-application-'));
  const filePath = join(dir, 'holds.json');
  const store = createConnectedServiceMemberHoldStore({ filePath });
  let active = input.active;
  let generation = 1;
  const commits: string[] = [];
  const applied: string[] = [];
  const preflighted: string[] = [];
  const group = () => ({
    v: 1, serviceId: SERVICE_ID, groupId: 'g', displayName: null, activeProfileId: active, generation, runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority', preTurnProbeMode: 'never' }),
    state: { v: 1 },
    members: ['A', 'B', 'C'].map((profileId, index) => ({
      v: 1, serviceId: SERVICE_ID, groupId: 'g', profileId, priority: index + 1, enabled: true, state: { v: 1 }, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1, updatedAt: 1,
  });
  const api = {
    getConnectedServiceAuthGroup: async () => group(),
    getAccountEncryptionMode: async () => 'plain',
    updateConnectedServiceAuthGroupRuntimeState: async () => group(),
    updateConnectedServiceAuthGroupActiveProfile: async ({ activeProfileId }: { activeProfileId: string }) => {
      commits.push(activeProfileId);
      active = activeProfileId;
      generation += 1;
      return group();
    },
  };
  const boundary = async ({ activeProfileId }: { activeProfileId: string | null }) => {
    if (activeProfileId) applied.push(activeProfileId);
    return { ok: true, action: 'hot_applied' };
  };
  const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    api: api as unknown as ApiClient,
    readMemberHolds: () => store.readForService(SERVICE_ID),
    runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    quotaFreshnessMs: 60_000,
    nowMs: () => NOW,
    resolveCurrentCredentialRevision: async () => null,
    preflightConnectedServiceAuthGeneration: async ({ activeProfileId }: { activeProfileId: string | null }) => {
      if (activeProfileId) {
        preflighted.push(activeProfileId);
        await input.onPreflight?.(activeProfileId);
      }
      return { ok: true, action: 'hot_applied' };
    },
    applyConnectedServiceAuthGeneration: boundary,
    restartSession: boundary,
  } as unknown as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]);
  return { filePath, store, coordinator, commits, applied, preflighted };
}

const recipient = (reason: string) => ({
  sessionId: 'recipient', serviceId: SERVICE_ID, groupId: 'g', activeProfileId: 'B', generation: 1, reason, fromProfileId: 'A',
});

describe('member holds at automatic generation application (HOLD-03)', () => {
  it('observed-generation failover does not apply a member held during its awaited preflight', async () => {
    let f: Awaited<ReturnType<typeof fixture>> | null = null;
    f = await fixture({ active: 'B', onPreflight: async (profileId) => { await f!.store.set(hold(profileId)); } });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'same_provider_account_exhausted',
    });
    expect(f.preflighted).toContain('B');
    expect(f.applied).not.toContain('B');
    expect(f.commits).not.toContain('B');
    expect(result).not.toMatchObject({ status: 'observed_generation', activeProfileId: 'B' });
  });

  it('an unheld observed generation is still adopted (positive control)', async () => {
    const f = await fixture({ active: 'B' });
    const result = await f.coordinator.switchAfterClassifiedFailure({
      sessionId: 's', serviceId: SERVICE_ID, groupId: 'g', observedProfileId: 'A', reason: 'same_provider_account_exhausted',
    });
    expect(result).toMatchObject({ status: 'observed_generation', activeProfileId: 'B' });
    expect(f.applied).toEqual(['B']);
    expect(f.commits).toEqual([]);
  });

  it('an automatic recipient refuses a committed target that is already held, without applying or committing', async () => {
    const f = await fixture({ active: 'B' });
    await f.store.set(hold('B'));
    const result = await f.coordinator.applyCommittedGeneration(recipient('same_provider_account_exhausted'));
    expect(result).toMatchObject({ status: 'generation_apply_failed', activeProfileId: 'B', errorCode: 'connected_service_member_held' });
    expect(f.applied).toEqual([]);
    expect(f.commits).toEqual([]);
  });

  it('an automatic recipient refuses when the target becomes held during its preflight', async () => {
    let f: Awaited<ReturnType<typeof fixture>> | null = null;
    f = await fixture({ active: 'B', onPreflight: async (profileId) => { await f!.store.set(hold(profileId)); } });
    const result = await f.coordinator.applyCommittedGeneration(recipient('soft_threshold'));
    expect(f.preflighted).toEqual(['B']);
    expect(result).toMatchObject({ status: 'generation_apply_failed', errorCode: 'connected_service_member_held' });
    expect(f.applied).toEqual([]);
  });

  it('an automatic recipient fails closed on unreadable hold state', async () => {
    const f = await fixture({ active: 'B' });
    await writeFile(f.filePath, 'invalid-json');
    const result = await f.coordinator.applyCommittedGeneration(recipient('same_provider_account_exhausted'));
    expect(result).toMatchObject({ status: 'generation_apply_failed', errorCode: 'connected_service_member_hold_state_unreadable' });
    expect(f.applied).toEqual([]);
  });

  it('an automatic recipient applies after expiry and after explicit release (positive controls)', async () => {
    const f = await fixture({ active: 'B' });
    await f.store.set(hold('B', NOW));
    expect(await f.coordinator.applyCommittedGeneration(recipient('same_provider_account_exhausted')))
      .toMatchObject({ status: 'observed_generation', activeProfileId: 'B' });
    await f.store.set(hold('B'));
    await f.store.release({ serviceId: SERVICE_ID, profileId: 'B' });
    await f.coordinator.applyCommittedGeneration(recipient('same_provider_account_exhausted'));
    expect(f.applied).toEqual(['B', 'B']);
  });

  it('a manual application (the operator\'s explicit choice of active member) is not subject to holds', async () => {
    const f = await fixture({ active: 'B' });
    await f.store.set(hold('B'));
    expect(await f.coordinator.applyCommittedGeneration(recipient('manual')))
      .toMatchObject({ status: 'observed_generation', activeProfileId: 'B' });
    expect(f.applied).toEqual(['B']);
  });
});
