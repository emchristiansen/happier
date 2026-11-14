import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routeClaudeAttachment } from '@/backends/claude/attachments/claudeAttachmentRouter';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { reconcileProviderObservedSessionAccount } from '../sessionAuthSwitch/reconcileProviderObservedSessionAccount';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './createRuntimeAuthRecoverySchedulerForDaemon';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent, RuntimeAuthRecoverySchedulerDeps } from './RuntimeAuthRecoveryScheduler';
import {
  buildRuntimeAuthAttemptTransitionEvent,
  foldRuntimeAuthAttemptAccountJoins,
  type RuntimeAuthAttemptAccountJoinEvent,
} from './runtimeAuthAttemptAccountJoin';

const SERVICE = 'claude-subscription' as const;
const RECOVERY_KEY = buildRuntimeAuthRecoveryKey({ sessionId: 's', serviceId: SERVICE, profileId: 'A', groupId: 'g' });

/**
 * The real daemon scheduler composition (file store + attempt decorator + proof hook) feeding the
 * journal exactly as startDaemon does; only the clock, the recover effect and provider inputs are
 * synthetic. `recover` throws so no switch/apply effect can run.
 */
async function realScheduler() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-attempt-join-composed-'));
  const clock = { now: 100 };
  const events: RuntimeAuthAttemptAccountJoinEvent[] = [];
  let recoverCalls = 0;
  const { scheduler } = createRuntimeAuthRecoverySchedulerForDaemon({
    activeServerDir: join(dir, 'server'),
    nowMs: () => clock.now,
    onAttemptIntentCommitted: ({ after }: { after: RuntimeAuthRecoveryIntent }) => {
      if (!after.attemptId) return;
      events.push(buildRuntimeAuthAttemptTransitionEvent({
        attemptId: after.attemptId, transition: after.lastSettledTransition ?? 'unsettled', persistedAtMs: clock.now, intent: after,
      }));
    },
    onProviderOutcomeProof: (report: Parameters<NonNullable<RuntimeAuthRecoverySchedulerDeps['onProviderOutcomeProof']>>[0]) => {
      const sessionId = report.before?.sessionId ?? report.after?.sessionId;
      if (!sessionId) return;
      events.push({
        v: 1, kind: 'provider_outcome_proof', sessionId, attemptId: report.before?.attemptId ?? null,
        expectedAttemptId: report.expectedAttemptId, proofKind: report.proofKind, observedAtMs: report.observedAtMs,
        statusBefore: report.before?.status ?? null, statusAfter: report.after?.status ?? null,
        attemptIdAfter: report.after?.attemptId ?? null, persistedAtMs: clock.now,
      });
    },
    recover: async () => {
      recoverCalls += 1;
      throw new Error('no recovery effect is permitted in this test');
    },
  } as unknown as Parameters<typeof createRuntimeAuthRecoverySchedulerForDaemon>[0]);
  const admitted = await scheduler.beginClassifiedFailure({
    reportId: 'runtime-auth-report:composed',
    sessionId: 's',
    switchesThisTurn: 0,
    classification: {
      kind: 'usage_limit', serviceId: SERVICE, profileId: 'A', groupId: 'g', resetsAtMs: null, planType: null,
      rateLimits: null, source: 'structured_provider_error', sourceKey: 'failure-1', providerReportedOrganizationId: 'org-A',
    },
  } as unknown as Parameters<typeof scheduler.beginClassifiedFailure>[0]);
  const attemptId = admitted.attemptId!;
  const applied = async (atMs: number, profileId: string, generation: number) => {
    clock.now = atMs;
    await scheduler.markAwaitingProviderOutcomeProofForResultByKey({
      recoveryKey: RECOVERY_KEY, expectedAttemptId: attemptId,
      result: { status: 'switch_attempted', result: { status: 'switched', activeProfileId: profileId, generation } },
    });
  };
  return { scheduler, clock, events, attemptId, applied, recoverCalls: () => recoverCalls };
}

const observedEvent = (observedAtMs: number, profileId: string, nativeSessionId = 'n1'): RuntimeAuthAttemptAccountJoinEvent => ({
  v: 1, kind: 'provider_account_observed', sessionId: 's', serviceId: SERVICE, groupId: 'g', nativeSessionId,
  providerOrganizationId: `org-${profileId}`, resolution: { kind: 'unique_member', profileId }, adoption: 'adopted', observedAtMs,
});

describe('attempt account join through the real scheduler and reconciler', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  it('JL-01: real reselection B→C under one attempt confirms C and keeps B as history', async () => {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    await f.applied(200, 'B', 2);
    await f.applied(300, 'C', 3);
    expect(f.scheduler.readByKey(RECOVERY_KEY)).toMatchObject({ pendingTargetProfileId: 'C', pendingTargetGeneration: 3 });
    const [joined] = foldRuntimeAuthAttemptAccountJoins([...f.events, observedEvent(310, 'C')]);
    expect(joined!.applications.map((application) => [application.profileId, application.generation])).toEqual([['B', 2], ['C', 3]]);
    expect(joined!.verdict).toBe('confirmed');
    // Without an intermediate persisted transition, B's later timestamps fall in C's window: uncertain, not mismatch.
    const [delayedB] = foldRuntimeAuthAttemptAccountJoins([...f.events, observedEvent(250, 'B')]);
    expect(delayedB!.observations.map((entry) => entry.disposition)).toEqual(['boundary_uncertain']);
    expect(delayedB!.verdict).toBe('boundary_uncertain');
  });

  it('JL-03: a real quota_probe_fresh recovery is scheduler recovery, not useful continuation', async () => {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    await f.applied(200, 'B', 2);
    f.clock.now = 400;
    await f.scheduler.markProviderOutcomeProofByKey({
      recoveryKey: RECOVERY_KEY, expectedAttemptId: f.attemptId, proofKind: 'quota_probe_fresh', observedAtMs: 400,
    });
    const [joined] = foldRuntimeAuthAttemptAccountJoins(f.events);
    expect(f.recoverCalls()).toBe(0);
    expect(joined).toMatchObject({
      latestStatus: 'recovered',
      schedulerRecovered: { proofKinds: ['quota_probe_fresh'] },
      usefulContinuation: { kind: 'not_witnessed' },
    });
  });

  it('JL-03: real provider_activity after application is useful continuation for that application', async () => {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    await f.applied(200, 'B', 2);
    f.clock.now = 260;
    await f.scheduler.markProviderOutcomeProofByKey({
      recoveryKey: RECOVERY_KEY, expectedAttemptId: f.attemptId, proofKind: 'provider_activity', observedAtMs: 250,
    });
    const [joined] = foldRuntimeAuthAttemptAccountJoins(f.events);
    expect(joined).toMatchObject({
      schedulerRecovered: { proofKinds: ['provider_activity'] },
      usefulContinuation: { kind: 'provider_activity', observedAtMs: 250, applicationIndex: 0 },
    });
  });

  it('JL-02 / JL-04: real provider identity emitted before status persistence is uncertain, and a native replaced during lookup is not adopted', async () => {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    const registry = new ConnectedServiceRuntimeRegistry({ nowMs: () => f.clock.now });
    registry.registerTarget({
      pid: 42, sessionId: 's', agentId: 'claude',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { [SERVICE]: { source: 'connected', selection: 'group', groupId: 'g', profileId: 'B' } } },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group', serviceId: SERVICE, groupId: 'g', activeProfileId: 'B', fallbackProfileId: 'A', generation: 2,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]),
      },
    } as unknown as Parameters<typeof registry.registerTarget>[0]);
    let parsed: { organizationId: string | null; timestampMs: number; sourceSessionId: string } | null = null;
    // The real attachment parser keeps the provider's own timestamp (150), not daemon receipt time.
    routeClaudeAttachment(
      { type: 'attachment', sessionId: 'n1', timestamp: new Date(150).toISOString(), attachment: { type: 'credential_org', organizationUuid: 'org-B' } },
      { onCredentialOrganization: (event: typeof parsed) => { parsed = event; } } as never,
    );
    expect(parsed).toMatchObject({ timestampMs: 150 });
    let native = 'n1';
    const reconcileInput = (observedAtMs: number, getGroup: () => Promise<{ generation: number; members: Array<{ profileId: string }> }>) => ({
      runtimeRegistry: registry, sessionId: 's', serviceId: SERVICE, groupId: 'g',
      providerOrganizationId: parsed!.organizationId, observedAtMs, sourceSessionId: parsed!.sourceSessionId,
      getCurrentProviderSessionId: () => native,
      getGroup,
      resolveProviderAccountIdentity: async (profileId: string) => ({ providerAccountId: profileId, providerOrganizationId: `org-${profileId}` }),
      onResolution: (resolution: Parameters<NonNullable<Parameters<typeof reconcileProviderObservedSessionAccount>[0]['onResolution']>>[0],
        adoption: Parameters<NonNullable<Parameters<typeof reconcileProviderObservedSessionAccount>[0]['onResolution']>>[1]) => {
        f.events.push({
          v: 1, kind: 'provider_account_observed', sessionId: 's', serviceId: SERVICE, groupId: 'g',
          nativeSessionId: parsed!.sourceSessionId, providerOrganizationId: parsed!.organizationId,
          resolution: resolution.kind === 'ambiguous' ? { kind: 'ambiguous', matchingProfileIds: [...resolution.matchingProfileIds] } : resolution,
          adoption, observedAtMs,
        });
      },
    });
    f.clock.now = 160;
    expect(await reconcileProviderObservedSessionAccount(reconcileInput(parsed!.timestampMs, async () => ({ generation: 2, members: [{ profileId: 'A' }, { profileId: 'B' }] })))).not.toBeNull();
    await f.applied(200, 'B', 2);
    const [boundary] = foldRuntimeAuthAttemptAccountJoins(f.events);
    expect(boundary!.observations.map((entry) => entry.disposition)).toEqual(['boundary_uncertain']);
    expect(boundary!.verdict).toBe('boundary_uncertain');

    // Native replaced while the group is being read: the reconciler rejects it after its recheck.
    const rejected = await reconcileProviderObservedSessionAccount(reconcileInput(250, async () => {
      native = 'n2';
      return { generation: 2, members: [{ profileId: 'A' }, { profileId: 'B' }] };
    }));
    expect(rejected).toBeNull();
    const [afterReject] = foldRuntimeAuthAttemptAccountJoins(f.events);
    const last = afterReject!.observations[afterReject!.observations.length - 1]!;
    expect(last.event.adoption).toBe('rejected_not_current');
    expect(last.disposition).toBe('not_adopted');
    expect(afterReject!.verdict).toBe('boundary_uncertain');
  });
});
