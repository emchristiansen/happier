import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import {
  ConnectedServiceGroupMemberHeldForSpawnError,
  type ConnectedServiceMemberHoldView,
} from './accountGroups/holds/connectedServiceMemberHolds';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;
const credentials = {
  token: 'synthetic',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
} satisfies Credentials;

class CredentialReadReached extends Error {
  constructor(readonly profileId: string) {
    super(`credential read reached for ${profileId}`);
  }
}

function heldView(entries: Array<[string, 'until_released' | number]>): ConnectedServiceMemberHoldView {
  return {
    status: 'readable',
    holdsByProfileId: new Map(entries.map(([profileId, lifetime]) => [profileId, {
      serviceId: SERVICE_ID, profileId, reason: 'seven_day 429', source: 'operator', heldAtMs: NOW - 1,
      lifetime: lifetime === 'until_released' ? { kind: 'until_released' as const } : { kind: 'until' as const, untilMs: lifetime },
    }])),
  };
}

/**
 * Real spawn resolver (and, when requested, the real daemon switch coordinator) against a
 * synthetic server. The credential read is the first materialization step; reaching it with a
 * profile id proves which member the spawn would run as, and nothing is ever materialized.
 */
async function spawnWith(input: Readonly<{
  selection: 'group' | 'profile';
  memberHolds: ConnectedServiceMemberHoldView;
  withCoordinator: boolean;
}>) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-spawn-member-holds-'));
  let active: 'A' | 'B' = 'A';
  let generation = 1;
  const activeProfileWrites: string[] = [];
  const credentialReads: string[] = [];
  const group = () => ({
    v: 1, serviceId: SERVICE_ID, groupId: 'g', displayName: null, activeProfileId: active, generation,
    runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority' }),
    state: { v: 1 },
    members: (['A', 'B'] as const).map((profileId, index) => ({
      v: 1, serviceId: SERVICE_ID, groupId: 'g', profileId, priority: index + 1, enabled: true,
      state: { v: 1 }, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1, updatedAt: 1,
  });
  const api: Record<string, unknown> = {
    getConnectedServiceAuthGroup: async () => group(),
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async (request: { profileId: string }) => {
      credentialReads.push(request.profileId);
      throw new CredentialReadReached(request.profileId);
    },
    updateConnectedServiceAuthGroupRuntimeState: async () => group(),
    updateConnectedServiceAuthGroupActiveProfile: async (request: { activeProfileId: 'A' | 'B' }) => {
      activeProfileWrites.push(request.activeProfileId);
      active = request.activeProfileId;
      generation += 1;
      return group();
    },
  };
  const readMemberHolds = async () => input.memberHolds;
  const authGroupSwitchCoordinator = input.withCoordinator
    ? createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as unknown as ApiClient,
      readMemberHolds,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => NOW,
      resolveCurrentCredentialRevision: async () => null,
      restartSession: async () => {},
    } as unknown as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0])
    : null;
  const outcome = await resolveConnectedServiceAuthForSpawn({
    agentId: 'claude',
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        [SERVICE_ID]: input.selection === 'group'
          ? { source: 'connected', selection: 'group', groupId: 'g', profileId: 'A' }
          : { source: 'connected', selection: 'profile', profileId: 'A' },
      },
    },
    materializationKey: 'holds',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    credentials,
    api: api as unknown as ApiClient,
    nowMs: () => NOW,
    processEnv: { HOME: join(dir, 'home') },
    readMemberHolds,
    authGroupSwitchCoordinator,
  } as unknown as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]).then(
    () => ({ kind: 'resolved' as const, error: null }),
    (error: unknown) => ({ kind: 'refused' as const, error }),
  );
  return { outcome, credentialReads, activeProfileWrites };
}

describe('resolveConnectedServiceAuthForSpawn member holds', () => {
  const providerFetch = vi.fn(async () => {
    throw new Error('no provider request is permitted');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    providerFetch.mockClear();
  });

  it('refuses a group spawn onto a held active member before any credential is read', async () => {
    vi.stubGlobal('fetch', providerFetch);
    const { outcome, credentialReads } = await spawnWith({
      selection: 'group', memberHolds: heldView([['A', 'until_released']]), withCoordinator: false,
    });
    expect(outcome.error).toBeInstanceOf(ConnectedServiceGroupMemberHeldForSpawnError);
    expect((outcome.error as ConnectedServiceGroupMemberHeldForSpawnError).exclusion).toMatchObject({ reason: 'held', retryAtMs: null });
    expect(credentialReads).toEqual([]);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('refuses when hold state is unreadable rather than spawning as if there were no holds', async () => {
    const { outcome, credentialReads } = await spawnWith({
      selection: 'group', memberHolds: { status: 'unreadable', error: 'invalid member hold file' }, withCoordinator: false,
    });
    expect(outcome.error).toBeInstanceOf(ConnectedServiceGroupMemberHeldForSpawnError);
    expect((outcome.error as Error).message).toContain('invalid member hold file');
    expect(credentialReads).toEqual([]);
  });

  it('spawns as the unheld active member, and after an until-hold expires', async () => {
    const unheld = await spawnWith({ selection: 'group', memberHolds: heldView([['B', 'until_released']]), withCoordinator: false });
    expect(unheld.outcome.error).toBeInstanceOf(CredentialReadReached);
    expect(unheld.credentialReads).toEqual(['A']);
    const expired = await spawnWith({ selection: 'group', memberHolds: heldView([['A', NOW]]), withCoordinator: false });
    expect(expired.credentialReads).toEqual(['A']);
  });

  it('moves a group spawn off a held active member through the switch coordinator', async () => {
    const { outcome, credentialReads, activeProfileWrites } = await spawnWith({
      selection: 'group', memberHolds: heldView([['A', NOW + 60_000]]), withCoordinator: true,
    });
    expect(activeProfileWrites).toEqual(['B']);
    expect(outcome.error).toBeInstanceOf(CredentialReadReached);
    expect(credentialReads).toEqual(['B']);
  });

  it('does not apply group holds to an explicit profile selection', async () => {
    const { outcome, credentialReads } = await spawnWith({
      selection: 'profile', memberHolds: heldView([['A', 'until_released']]), withCoordinator: false,
    });
    expect(outcome.error).toBeInstanceOf(CredentialReadReached);
    expect(credentialReads).toEqual(['A']);
  });
});
