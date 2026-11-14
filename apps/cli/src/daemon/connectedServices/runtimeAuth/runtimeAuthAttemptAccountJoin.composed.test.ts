import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routeClaudeAttachment } from '@/backends/claude/attachments/claudeAttachmentRouter';
import { runConnectAttemptAccountsCommand } from '@/cli/commands/connect/connectAttemptAccounts';
import { applyTrackedSessionTurnLifecycle } from '@/daemon/sessions/applyTrackedSessionTurnLifecycle';
import type { TrackedSession } from '@/daemon/types';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { listProviderActivityRecoveryIdentitiesFromRuntimeBindings } from '../continuation/continuationRecoveryIdentity';
import {
  createConnectedServiceProviderActivityProofRecorder,
  recordTurnLifecycleProviderActivity,
} from '../recovery/providerActivityProofRecorder';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { reconcileProviderObservedSessionAccount } from '../sessionAuthSwitch/reconcileProviderObservedSessionAccount';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './createRuntimeAuthRecoverySchedulerForDaemon';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent, RuntimeAuthRecoverySchedulerDeps } from './RuntimeAuthRecoveryScheduler';
import {
  buildRuntimeAuthAttemptTransitionEvent,
  createRuntimeAuthAttemptAccountJoinJournal,
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
        turnOwnership: report.turnOwnership, statusBefore: report.before?.status ?? null, statusAfter: report.after?.status ?? null,
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
      evidence: { turnOwnership: 'exact_turn' },
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

describe('JL-05: turn-lifecycle provider activity through the real producer → scheduler → journal → CLI', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  /** One real journal + CLI read of what the daemon's proof hook and attempt decorator emitted. */
  async function cliView(events: ReadonlyArray<RuntimeAuthAttemptAccountJoinEvent>) {
    const dir = await mkdtemp(join(tmpdir(), 'happier-attempt-join-cli-'));
    const journal = createRuntimeAuthAttemptAccountJoinJournal({ filePath: join(dir, 'journal.jsonl') });
    for (const event of events) await journal.append(event);
    const lines: string[] = [];
    await runConnectAttemptAccountsCommand({ args: ['--session', 's'], journal, write: (line) => lines.push(line) });
    return JSON.parse(lines.join('\n')) as { attempts: Array<{ usefulContinuation: unknown; latestStatus: string; proofs: unknown[] }> };
  }

  async function turnFixture(bindingGeneration = 2) {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    await f.applied(200, 'B', 2);
    const registry = new ConnectedServiceRuntimeRegistry({ nowMs: () => f.clock.now });
    registry.registerTarget({
      pid: 42, sessionId: 's', agentId: 'claude',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { [SERVICE]: { source: 'connected', selection: 'group', groupId: 'g', profileId: 'B' } } },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group', serviceId: SERVICE, groupId: 'g', activeProfileId: 'B', fallbackProfileId: 'A', generation: bindingGeneration,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]),
      },
    } as unknown as Parameters<typeof registry.registerTarget>[0]);
    const record = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => f.clock.now,
      runtimeAuthRecovery: {
        readForSession: (sessionId) => f.scheduler.readForSession(sessionId),
        markProviderOutcomeProofByKey: (input) => f.scheduler.markProviderOutcomeProofByKey(input),
      },
    });
    const tracked = { pid: 42, happySessionId: 's', activeTurnId: 'current-turn' } as unknown as TrackedSession;
    /** The daemon's block: exact-turn owner first, then the owned activity step it calls. */
    const turnEnd = async (input: Readonly<{ turnId?: string; terminalStatus?: 'completed' | 'failed' }>) => {
      f.clock.now = 500;
      const turnLifecycle = await applyTrackedSessionTurnLifecycle({
        trackedSessions: [tracked], sessionId: 's', event: 'assistant_message_end',
        ...(input.turnId ? { turnId: input.turnId } : {}),
        updateSessionMarkerActiveTurn: async () => true,
      });
      const admission = await recordTurnLifecycleProviderActivity({
        sessionId: 's', event: 'assistant_message_end',
        ...(input.terminalStatus ? { terminalStatus: input.terminalStatus } : {}),
        turnLifecycle,
        resolveRecoveryIdentities: () => listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
          registry.getBySessionId('s')?.activeBindings ?? [], f.scheduler.readForSession('s')),
        record,
      });
      return { turnLifecycle, admission };
    };
    return { ...f, turnEnd };
  }

  it('a completion the exact-turn owner rejects as an older turn offers no proof and certifies nothing', async () => {
    const f = await turnFixture();
    const { turnLifecycle, admission } = await f.turnEnd({ turnId: 'old-turn', terminalStatus: 'completed' });
    expect(turnLifecycle.status).toBe('ignored_turn_mismatch');
    expect(admission).toEqual({ admitted: false, reason: 'turn_mismatch' });
    expect(f.scheduler.readByKey(RECOVERY_KEY)?.status).toBe('resumed_awaiting_proof');
    const view = await cliView(f.events);
    expect(view.attempts[0]).toMatchObject({ latestStatus: 'resumed_awaiting_proof', proofs: [], usefulContinuation: { kind: 'not_witnessed' } });
  });

  it('the genuinely recorded matching completed turn is useful continuation', async () => {
    const f = await turnFixture();
    const { turnLifecycle } = await f.turnEnd({ turnId: 'current-turn', terminalStatus: 'completed' });
    expect(turnLifecycle.status).toBe('recorded');
    const view = await cliView(f.events);
    expect(view.attempts[0]).toMatchObject({
      latestStatus: 'recovered',
      usefulContinuation: { kind: 'provider_activity', observedAtMs: 500, applicationIndex: 0 },
    });
  });

  it('a failed current turn is not provider activity', async () => {
    const f = await turnFixture();
    const { admission } = await f.turnEnd({ turnId: 'current-turn', terminalStatus: 'failed' });
    expect(admission).toEqual({ admitted: false, reason: 'not_provider_activity' });
    expect((await cliView(f.events)).attempts[0]).toMatchObject({ latestStatus: 'resumed_awaiting_proof', usefulContinuation: { kind: 'not_witnessed' } });
  });

  it('an unrelated binding generation produces no proof for this attempt', async () => {
    const f = await turnFixture(3);
    await f.turnEnd({ turnId: 'current-turn', terminalStatus: 'completed' });
    expect((await cliView(f.events)).attempts[0]).toMatchObject({ latestStatus: 'resumed_awaiting_proof', usefulContinuation: { kind: 'not_witnessed' } });
  });

  it('activity with no exact turn keeps its existing recovery role but is reported as unverified, not useful', async () => {
    const f = await turnFixture();
    const { turnLifecycle, admission } = await f.turnEnd({ terminalStatus: 'completed' });
    expect(turnLifecycle.status).toBe('ignored_missing_exact_turn');
    expect(admission).toEqual({ admitted: true, turnOwnership: 'unverified_turn' });
    expect((await cliView(f.events)).attempts[0]).toMatchObject({
      latestStatus: 'recovered',
      usefulContinuation: { kind: 'provider_activity_unverified_turn', observedAtMs: 500 },
    });
  });
});

describe('JL-06: retained provider_outcome_proof rows that predate turnOwnership, through the real journal reader → CLI', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  /** Real scheduler rows: B applied, a quota proof, then provider activity (exact turn as emitted today). */
  async function emittedRows() {
    const f = await realScheduler();
    disposers.push(() => f.scheduler.dispose());
    await f.applied(200, 'B', 2);
    f.clock.now = 240;
    await f.scheduler.markProviderOutcomeProofByKey({
      recoveryKey: RECOVERY_KEY, expectedAttemptId: f.attemptId, proofKind: 'quota_probe_fresh', observedAtMs: 240,
    });
    f.clock.now = 260;
    await f.scheduler.markProviderOutcomeProofByKey({
      recoveryKey: RECOVERY_KEY, expectedAttemptId: f.attemptId, proofKind: 'provider_activity', observedAtMs: 250,
      evidence: { turnOwnership: 'exact_turn' },
    });
    const rows = f.events.map((event) => JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
    expect(rows.filter((row) => row.kind === 'provider_outcome_proof').map((row) => row.proofKind))
      .toEqual(['quota_probe_fresh', 'provider_activity']);
    return { rows, attemptId: f.attemptId };
  }

  /** Writes raw JSONL exactly as a retained file would hold it and reads it back through the real CLI. */
  async function cliRead(rows: ReadonlyArray<Record<string, unknown>>, args: ReadonlyArray<string> = ['--session', 's'], tail = '') {
    const dir = await mkdtemp(join(tmpdir(), 'happier-attempt-join-legacy-'));
    const filePath = join(dir, 'journal.jsonl');
    await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    if (tail) await appendFile(filePath, tail);
    const lines: string[] = [];
    await runConnectAttemptAccountsCommand({ args, journal: createRuntimeAuthAttemptAccountJoinJournal({ filePath }), write: (line) => lines.push(line) });
    return JSON.parse(lines.join('\n')) as {
      attempts: Array<{ attemptId: string; proofs: unknown[]; schedulerRecovered: { proofKinds: string[] } | null; usefulContinuation: { kind: string } }>;
      invalidLines: Array<{ lineNumber: number }>;
    };
  }

  const withOwnership = (rows: ReadonlyArray<Record<string, unknown>>, value: unknown | 'omit') => rows.map((row) => {
    if (row.kind !== 'provider_outcome_proof') return row;
    const { turnOwnership: _ignored, ...rest } = row;
    return value === 'omit' ? rest : { ...rest, turnOwnership: value };
  });

  it('legacy quota and activity rows without turnOwnership are retained and reported as unverified, never as exact useful continuation', async () => {
    const { rows } = await emittedRows();
    const legacy = withOwnership(rows, 'omit');
    expect(legacy.some((row) => row.kind === 'provider_outcome_proof' && 'turnOwnership' in row)).toBe(false);
    const view = await cliRead(legacy);
    expect(view.invalidLines).toEqual([]);
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0]!.proofs).toHaveLength(2);
    expect(view.attempts[0]!.schedulerRecovered?.proofKinds).toEqual(['quota_probe_fresh']);
    expect(view.attempts[0]!.usefulContinuation.kind).toBe('provider_activity_unverified_turn');
  });

  it('explicit null reads like an omitted field; exact_turn and unverified_turn keep their meanings', async () => {
    const { rows } = await emittedRows();
    expect((await cliRead(withOwnership(rows, null))).attempts[0]!.usefulContinuation.kind).toBe('provider_activity_unverified_turn');
    expect((await cliRead(withOwnership(rows, 'unverified_turn'))).attempts[0]!.usefulContinuation.kind).toBe('provider_activity_unverified_turn');
    const exact = await cliRead(withOwnership(rows, 'exact_turn'));
    expect(exact.invalidLines).toEqual([]);
    expect(exact.attempts[0]!.usefulContinuation.kind).toBe('provider_activity');
  });

  it('a malformed ownership value is still rejected as an invalid line and offers no proof', async () => {
    const { rows } = await emittedRows();
    const view = await cliRead(withOwnership(rows, 'invented_exact'));
    expect(view.invalidLines).toHaveLength(2);
    expect(view.attempts[0]!.proofs).toEqual([]);
    expect(view.attempts[0]!.usefulContinuation.kind).toBe('not_witnessed');
  });

  it('a torn trailing line is reported without disturbing retained legacy rows', async () => {
    const { rows } = await emittedRows();
    const legacy = withOwnership(rows, 'omit');
    const view = await cliRead(legacy, ['--session', 's'], '{"v":1,"kind":"provider_outcome_proof","sessi');
    expect(view.invalidLines.map((line) => line.lineNumber)).toEqual([legacy.length + 1]);
    expect(view.attempts[0]!.proofs).toHaveLength(2);
    expect(view.attempts[0]!.usefulContinuation.kind).toBe('provider_activity_unverified_turn');
  });

  it('a legacy proof naming another attempt does not join this attempt', async () => {
    const { rows, attemptId } = await emittedRows();
    const foreign = withOwnership(rows, 'omit').map((row) => (
      row.kind === 'provider_outcome_proof' ? { ...row, attemptId: 'other-attempt', expectedAttemptId: 'other-attempt', attemptIdAfter: 'other-attempt' } : row
    ));
    const view = await cliRead(foreign, ['--attempt', attemptId]);
    expect(view.invalidLines).toEqual([]);
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0]!.proofs).toEqual([]);
    expect(view.attempts[0]!.usefulContinuation.kind).toBe('not_witnessed');
  });
});
