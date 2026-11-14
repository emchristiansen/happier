import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema, type ConnectedServiceAuthGroupV1, type ConnectedServiceId } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { resolveConnectedServiceGenerationApplicationScope } from '@/backends/catalog';

import {
  createConnectedServiceMemberHoldStore,
  resolveConnectedServiceMemberHoldAdmission,
  type ConnectedServiceMemberHold,
  type ConnectedServiceMemberHoldStore,
} from './connectedServiceMemberHolds';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../generation/ConnectedServiceAuthGroupGenerationConsumer';
import { createSharedGenerationApplication } from '../generation/createSharedGenerationApplication';
import {
  reconcileConnectedServiceAuthGroupGenerations,
  type ConnectedServiceGenerationRuntimeTarget,
} from '../generation/reconcileConnectedServiceAuthGroupGenerations';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

const NOW = 2_000_000_000_000;
const REVISION = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
type Authority = 'passive_projection' | 'runtime_recovery' | 'fresh_user_action';
type ConsumerDeps = ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0];

function hold(serviceId: string, profileId: string, untilMs?: number): ConnectedServiceMemberHold {
  return {
    serviceId, profileId, reason: 'known weekly limit', source: 'operator', heldAtMs: NOW,
    lifetime: untilMs === undefined ? { kind: 'until_released' } : { kind: 'until', untilMs },
  };
}

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-hold-fanout-'));
  const filePath = join(dir, 'holds.json');
  return { filePath, store: createConnectedServiceMemberHoldStore({ filePath }) };
}

function serverGroup(serviceId: ConnectedServiceId): ConnectedServiceAuthGroupV1 {
  return {
    v: 1, serviceId, groupId: 'team', displayName: 'Team', activeProfileId: 'backup', generation: 2, runtimeStateRevision: 0,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' }, state: { status: 'ready' },
    createdAt: 1, updatedAt: 1, members: [],
  };
}

function liveRecipient(serviceId: ConnectedServiceId, agentId: string): ConnectedServiceGenerationRuntimeTarget {
  return {
    sessionId: 'live', agentId,
    activeBindings: [{ serviceId, profileId: 'old', groupId: 'team', generation: 1, credentialRevision: 'csr_oldoldoldoldoldoldoldold' }],
    connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'team' } } },
  } as unknown as ConnectedServiceGenerationRuntimeTarget;
}

const verifiedTarget = (committed: Parameters<ConsumerDeps['applyCommittedGeneration']>[0]['committedGeneration'], source: string) => ({
  ...committed.decisionCommittedTarget,
  credentialRevision: REVISION,
  proof: { status: 'verified' as const, source, credentialRevision: REVISION },
});

/** Real reconciler → real consumer (with the canonical-style hold reader) → given apply boundaries. */
async function reconcile(input: Readonly<{
  consumer: ConnectedServiceAuthGroupGenerationConsumer;
  serviceId: ConnectedServiceId;
  agentId: string;
  executionAuthority: Authority;
}>) {
  return await reconcileConnectedServiceAuthGroupGenerations({
    consumer: input.consumer,
    listCurrentGroups: async () => [serverGroup(input.serviceId)],
    resolveCredentialRevision: () => REVISION,
    listRuntimeTargets: () => [liveRecipient(input.serviceId, input.agentId)],
    executionAuthority: input.executionAuthority,
  }).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: String(error) }));
}

describe('HOLD-04: Claude shared-group generation fanout honours canonical holds', () => {
  async function sharedFixture(options: Readonly<{
    exactExistingProof?: boolean;
    duringCredentialResolution?: (store: ConnectedServiceMemberHoldStore, filePath: string) => Promise<void>;
  }> = {}) {
    const { filePath, store } = await tempStore();
    const sharedApplications: string[] = [];
    const credentialResolutions: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      readMemberHolds: (serviceId) => store.readForService(serviceId),
      nowMs: () => NOW,
      // Real catalog: Claude declares shared_group_auth_surface for claude-subscription.
      resolveGenerationApplicationScope: async ({ serviceId }) => await resolveConnectedServiceGenerationApplicationScope(serviceId, 'claude'),
      verifySharedGenerationApplication: async ({ committedGeneration }) => (
        options.exactExistingProof ? verifiedTarget(committedGeneration, 'claude_shared_group_auth_surface') : null
      ),
      // The daemon's real shared-application owner; only the provider descriptor (the protected
      // materialization) and the server credential read are synthetic.
      applySharedGenerationApplication: createSharedGenerationApplication({
        activeServerDir: '/nonexistent/private',
        resolveDescriptor: async () => ({
          applySharedGenerationApplication: async (target) => {
            sharedApplications.push(target.profileId);
            return { status: 'verified', source: 'claude_shared_group_auth_surface', credentialRevision: target.credentialRevision } as never;
          },
        }),
        resolveTargetCredential: async ({ profileId }) => {
          credentialResolutions.push(profileId);
          await options.duringCredentialResolution?.(store, filePath);
          return { credentialRevision: REVISION, record: {} as never };
        },
        validateCurrentness: async () => ({ current: true }),
        readMemberHolds: (serviceId) => store.readForService(serviceId),
        nowMs: () => NOW,
      }),
      applyCommittedGeneration: async () => { throw new Error('a shared Claude recipient must not use the per-session route'); },
      notifyCurrentGroupTruth: async () => ({ ok: true }),
    } as ConsumerDeps);
    return { filePath, store, consumer, sharedApplications, credentialResolutions };
  }
  const run = (consumer: ConnectedServiceAuthGroupGenerationConsumer, executionAuthority: Authority = 'runtime_recovery') =>
    reconcile({ consumer, serviceId: 'claude-subscription', agentId: 'claude', executionAuthority });

  it('confirms the real catalog routes claude-subscription to the shared surface', async () => {
    expect(await resolveConnectedServiceGenerationApplicationScope('claude-subscription', 'claude'))
      .toMatchObject({ status: 'supported', scope: 'shared_group_auth_surface' });
  });

  it('refuses an automatic shared application of a held target before the protected effect', async () => {
    const f = await sharedFixture();
    await f.store.set(hold('claude-subscription', 'backup'));
    const outcome = await run(f.consumer);
    expect(f.sharedApplications).toEqual([]);
    expect(outcome.ok).toBe(false); // not acknowledgeable: deferred for a later catch-up
  });

  it('refuses when hold state is unreadable', async () => {
    const f = await sharedFixture();
    await writeFile(f.filePath, '{not json');
    await run(f.consumer, 'passive_projection');
    expect(f.sharedApplications).toEqual([]);
  });

  it('applies an unheld, expired or released target (positive controls)', async () => {
    const unheld = await sharedFixture();
    expect((await run(unheld.consumer)).ok).toBe(true);
    expect(unheld.sharedApplications).toEqual(['backup']);

    const expired = await sharedFixture();
    await expired.store.set(hold('claude-subscription', 'backup', NOW));
    await run(expired.consumer);
    expect(expired.sharedApplications).toEqual(['backup']);

    const released = await sharedFixture();
    await released.store.set(hold('claude-subscription', 'backup'));
    await released.store.release({ serviceId: 'claude-subscription', profileId: 'backup' });
    await run(released.consumer);
    expect(released.sharedApplications).toEqual(['backup']);
  });

  it('refuses when the target becomes held while its credential is being resolved (post-preparation admission)', async () => {
    const f = await sharedFixture({ duringCredentialResolution: async (store) => { await store.set(hold('claude-subscription', 'backup')); } });
    const outcome = await run(f.consumer);
    expect(f.credentialResolutions).toEqual(['backup']);
    expect(f.sharedApplications).toEqual([]);
    expect(outcome.ok).toBe(false);
  });

  it('refuses when hold state becomes unreadable during credential resolution', async () => {
    const f = await sharedFixture({ duringCredentialResolution: async (_store, filePath) => { await writeFile(filePath, 'broken'); } });
    await run(f.consumer, 'passive_projection');
    expect(f.sharedApplications).toEqual([]);
  });

  it('keeps an exact existing shared proof as convergence without a new effect, even while held', async () => {
    const f = await sharedFixture({ exactExistingProof: true });
    await f.store.set(hold('claude-subscription', 'backup'));
    const outcome = await run(f.consumer);
    expect(f.sharedApplications).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('a genuinely explicit operator choice (fresh_user_action) is not subject to holds', async () => {
    const f = await sharedFixture();
    await f.store.set(hold('claude-subscription', 'backup'));
    await run(f.consumer, 'fresh_user_action');
    expect(f.sharedApplications).toEqual(['backup']);
  });
});

describe('HOLD-05: passive catch-up labelled manual is not an operator exemption', () => {
  /**
   * Per-session (codex) recipient: real reconciler → real consumer → real daemon factory coordinator.
   * The consumer-to-coordinator mapping mirrors the daemon's per-session callback.
   */
  async function perSessionFixture(options: Readonly<{ consumerReadsHolds: boolean }>) {
    const { filePath, store } = await tempStore();
    const applied: string[] = [];
    const commits: string[] = [];
    const serverGroupState = () => ({
      ...serverGroup('openai-codex'),
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority', preTurnProbeMode: 'never' }),
      state: { v: 1 },
      members: ['old', 'backup'].map((profileId, index) => ({
        v: 1, serviceId: 'openai-codex', groupId: 'team', profileId, priority: index + 1, enabled: true, state: { v: 1 }, createdAt: 1, updatedAt: 1,
      })),
    });
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: {
        getConnectedServiceAuthGroup: async () => serverGroupState(),
        getAccountEncryptionMode: async () => 'plain',
        updateConnectedServiceAuthGroupRuntimeState: async () => serverGroupState(),
        updateConnectedServiceAuthGroupActiveProfile: async ({ activeProfileId }: { activeProfileId: string }) => {
          commits.push(activeProfileId);
          return serverGroupState();
        },
      } as unknown as ApiClient,
      readMemberHolds: () => store.readForService('openai-codex'),
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => NOW,
      resolveCurrentCredentialRevision: async () => REVISION,
      applyConnectedServiceAuthGeneration: async ({ activeProfileId }: { activeProfileId: string | null }) => {
        if (activeProfileId) applied.push(activeProfileId);
        return { ok: true, action: 'hot_applied' };
      },
      restartSession: async () => { throw new Error('no restart expected'); },
    } as unknown as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]);
    const reasons: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...(options.consumerReadsHolds ? { readMemberHolds: (serviceId: ConnectedServiceId) => store.readForService(serviceId), nowMs: () => NOW } : {}),
      resolveGenerationApplicationScope: async ({ serviceId }) => await resolveConnectedServiceGenerationApplicationScope(serviceId, 'codex'),
      verifySharedGenerationApplication: async () => null,
      applyCommittedGeneration: async (input) => {
        reasons.push(input.generationApplyReason);
        const target = input.committedGeneration.decisionCommittedTarget;
        const result = await coordinator.applyCommittedGeneration({
          sessionId: input.sessionId, serviceId: target.serviceId, groupId: target.groupId, activeProfileId: target.profileId,
          generation: target.generation, credentialRevision: target.credentialRevision, reason: input.generationApplyReason,
          fromProfileId: input.fromProfileId, holdAdmission: resolveConnectedServiceMemberHoldAdmission(input.executionAuthority),
        });
        return result.status === 'observed_generation'
          ? { reconciliationDisposition: 'converged', errorCode: null,
              providerAdoptedTarget: verifiedTarget(input.committedGeneration, 'codex_app_server') }
          : { reconciliationDisposition: 'failed', errorCode: 'errorCode' in result ? result.errorCode ?? null : null };
      },
      notifyCurrentGroupTruth: async () => ({ ok: true }),
    } as ConsumerDeps);
    return { filePath, store, consumer, applied, commits, reasons };
  }
  const run = (consumer: ConnectedServiceAuthGroupGenerationConsumer, executionAuthority: Authority = 'passive_projection') =>
    reconcile({ consumer, serviceId: 'openai-codex', agentId: 'codex', executionAuthority });

  it('confirms the real catalog routes openai-codex per session', async () => {
    expect(await resolveConnectedServiceGenerationApplicationScope('openai-codex', 'codex'))
      .toMatchObject({ status: 'supported', scope: 'per_session_runtime' });
  });

  it.each([true, false])('refuses passive reconciliation of a held target (consumer reads holds: %s), with no apply or commit', async (consumerReadsHolds) => {
    const f = await perSessionFixture({ consumerReadsHolds });
    await f.store.set(hold('openai-codex', 'backup'));
    const outcome = await run(f.consumer);
    expect(f.applied).toEqual([]);
    expect(f.commits).toEqual([]);
    expect(outcome.ok).toBe(false);
    // Without the consumer guard, the coordinator itself refuses despite the reconciler's `manual` label.
    if (!consumerReadsHolds) expect(f.reasons).toEqual(['manual']);
  });

  it('refuses passive reconciliation when hold state is unreadable', async () => {
    const f = await perSessionFixture({ consumerReadsHolds: false });
    await writeFile(f.filePath, 'invalid-json');
    await run(f.consumer);
    expect(f.applied).toEqual([]);
  });

  it('applies unheld, expired and released targets (positive controls)', async () => {
    const unheld = await perSessionFixture({ consumerReadsHolds: true });
    expect((await run(unheld.consumer)).ok).toBe(true);
    expect(unheld.applied).toEqual(['backup']);
    const expired = await perSessionFixture({ consumerReadsHolds: true });
    await expired.store.set(hold('openai-codex', 'backup', NOW));
    await run(expired.consumer);
    expect(expired.applied).toEqual(['backup']);
    const released = await perSessionFixture({ consumerReadsHolds: true });
    await released.store.set(hold('openai-codex', 'backup'));
    await released.store.release({ serviceId: 'openai-codex', profileId: 'backup' });
    await run(released.consumer);
    expect(released.applied).toEqual(['backup']);
    expect([...unheld.commits, ...expired.commits, ...released.commits]).toEqual([]);
  });

  it('a genuinely explicit operator choice (fresh_user_action) applies a held target', async () => {
    const f = await perSessionFixture({ consumerReadsHolds: true });
    await f.store.set(hold('openai-codex', 'backup'));
    await run(f.consumer, 'fresh_user_action');
    expect(f.applied).toEqual(['backup']);
  });
});
