import { describe, expect, it, vi } from 'vitest';
import type { SessionConnectedServiceAuthSwitchRpcParams } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createGuardedQuotaRecovery } from './guardedQuotaRecovery';
import type { QuotaRecoveryGuard } from './quotaRecoveryGuard';
import { switchSessionConnectedServiceAuth } from './switchSessionConnectedServiceAuth';

function fixture() {
  const core = createConnectedServiceSessionAuthSwitchCore();
  const tracked: TrackedSession = { startedBy: 'daemon', happySessionId: 'quota-session', pid: 123,
    spawnOptionsCustody: 'accepted_live_launch',
    processInstanceFingerprint: 'fixture-instance', vendorResumeId: 'same-native', publisherIncarnationId: 'original-publisher',
    spawnOptions: { directory: '/fixture', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      resume: 'same-native', modelId: 'selected-model', permissionMode: 'yolo',
      sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { value: 'high', updatedAt: 1 } } },
      pendingFirstInput: { text: 'same input', localId: 'original-once' },
      initialGoal: { objective: 'same goal' },
      connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': {
        source: 'connected', selection: 'profile', profileId: 'previous',
      } } },
    } };
  const refusal: RuntimeAuthRecoveryIntent = { v: 2, sessionId: 'quota-session',
    serviceId: 'openai-codex', profileId: 'previous', groupId: null, attemptId: 'refusal-1',
    armedAtMs: 100, status: 'waiting', nextRetryAtMs: null, attemptCount: 0, maxAttempts: 5,
    switchesThisTurn: 0, failurePhase: 'handler', failureReason: 'usage_limit',
    lastError: null, lastErrorClassification: null,
    classification: { kind: 'usage_limit', serviceId: 'openai-codex', profileId: 'previous',
      groupId: null, resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } };
  let turnInFlight = false;
  let nowMs = 200;
  const recovery = createGuardedQuotaRecovery({ core, getChildren: () => [tracked],
    readRecoveryIntents: () => [refusal], isTurnInFlight: () => turnInFlight, nowMs: () => nowMs });
  const request = { sessionId: 'quota-session', agentId: 'codex',
    bindings: { v: 1, bindingsByServiceId: { 'openai-codex': {
      source: 'connected', selection: 'profile', profileId: 'next',
    } } },
    quotaRecovery: { requestId: 'attempt-1', nativeId: 'same-native', pid: 123,
      processInstanceFingerprint: 'fixture-instance', serviceId: 'openai-codex', profileId: 'previous',
      failureAttemptId: 'refusal-1', failureArmedAtMs: 100,
      nativePublisherIncarnationId: 'original-publisher', nativeObservationSequence: '1', failureObservedAtMs: 200 },
  } satisfies SessionConnectedServiceAuthSwitchRpcParams;
  recovery.beginFailureSource({ sessionId: 'quota-session', classification: refusal.classification,
    nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '1' } })?.(refusal.attemptId);
  // The genuine provider/OS/persistence boundaries are inert. The lock, guard,
  // normalization, switch, rollback and occurrence handling below stay real.
  const restart = vi.fn(async () => {});
  const persist = vi.fn(async () => {});
  const execute = (quotaRecoveryGuard: QuotaRecoveryGuard) => switchSessionConnectedServiceAuth({
    core, quotaRecoveryGuard, getChildren: () => [tracked],
    api: { listConnectedServiceProfiles: async () => ({ serviceId: 'openai-codex', profiles: [
      { profileId: 'next', status: 'connected' },
    ] }), getConnectedServiceAuthGroup: async () => null },
    resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
    restartSession: restart, persistSessionBindings: persist,
    hotApply: async () => ({ ok: true }), registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
    postSwitchVerificationMode: { kind: 'disabled_for_test_only', reason: 'provider adoption is outside this OS-boundary fixture' },
    executionPolicy: { allowRestartResume: true, allowContinuation: false, source: 'runtime' }, request,
  });
  return { tracked, refusal, recovery, request, execute, restart, persist,
    startTurn: () => { turnInFlight = true; }, advanceClock: () => { nowMs++; } };
}

describe('daemon guarded quota recovery', () => {
  it.each([
    { agentId: 'claude', serviceId: 'claude-subscription', available: true },
    { agentId: 'gemini', serviceId: 'openai-codex', available: false },
  ] as const)('uses provider-owned quota support for $agentId', ({ agentId, serviceId, available }) => {
    const f = fixture();
    f.tracked.spawnOptions = {
      ...f.tracked.spawnOptions!,
      backendTarget: { kind: 'builtInAgent', agentId },
      connectedServices: { v: 1, bindingsByServiceId: {
        [serviceId]: { source: 'connected', selection: 'profile', profileId: 'previous' },
      } },
    };
    const refusal = { ...f.refusal, serviceId, classification: { ...f.refusal.classification, serviceId } };
    const recovery = createGuardedQuotaRecovery({
      core: createConnectedServiceSessionAuthSwitchCore(), getChildren: () => [f.tracked],
      readRecoveryIntents: () => [refusal], isTurnInFlight: () => false, nowMs: () => 200,
    });
    recovery.beginFailureSource({ sessionId: 'quota-session', classification: refusal.classification,
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '1' },
    })?.(refusal.attemptId);
    expect(recovery.inspect('quota-session')).toMatchObject(available
      ? { ok: true, agentId, source: { serviceId } }
      : { ok: false, errorCode: 'quota_recovery_current_refusal_unavailable' });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
  });

  it.each(['unmarked', 'restored', 'foreign'] as const)('refuses %s options without an account effect', async (source) => {
    const f = fixture();
    if (source === 'unmarked') delete f.tracked.spawnOptionsCustody;
    if (source === 'restored') f.tracked.reattachedFromDiskMarker = true;
    if (source === 'foreign') f.tracked.startedBy = 'terminal';
    expect(f.recovery.inspect('quota-session')).toMatchObject({ ok: false });
    await expect(f.recovery.run(f.request, f.execute)).rejects.toThrow('quota_recovery_current_source_changed');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
  });

  it('refuses loss of live-options custody across an awaited binding write', async () => {
    const f = fixture();
    f.persist.mockImplementation(async () => { delete f.tracked.spawnOptionsCustody; });
    expect(await f.recovery.run(f.request, f.execute)).toMatchObject({ occurrence: { stage: 'unknown' } });
    expect(f.restart).not.toHaveBeenCalled();
  });

  it('does not refresh a refusal clock on duplicate delivery or accept an older publisher', () => {
    const f = fixture();
    f.advanceClock();
    const before = f.recovery.inspect('quota-session');
    f.recovery.beginFailureSource({ sessionId: 'quota-session', classification: f.refusal.classification,
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '1' },
    })?.(f.refusal.attemptId);
    expect(f.recovery.inspect('quota-session')).toEqual(before);
    f.recovery.beginFailureSource({ sessionId: 'quota-session', classification: f.refusal.classification,
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'retired-publisher', sequence: '999' },
    })?.(f.refusal.attemptId);
    expect(f.recovery.inspect('quota-session')).toEqual(before);
  });

  it('keeps its own failed-turn bookkeeping but never resurrects intake after a newer turn', () => {
    const f = fixture();
    f.tracked.activeTurnId = 'quota-turn';
    const finalize = f.recovery.beginFailureSource({ sessionId: 'quota-session', classification: f.refusal.classification,
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '2' },
    });
    expect(f.recovery.inspect('quota-session')).toMatchObject({ ok: false });
    f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'assistant_message_end',
      terminalStatus: 'failed', turnId: 'quota-turn',
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '3' } });
    delete f.tracked.activeTurnId;
    finalize?.(f.refusal.attemptId);
    expect(f.recovery.inspect('quota-session')).toMatchObject({ ok: true, source: { nativeObservationSequence: '2' } });
    f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'task_started',
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '4' } });
    finalize?.(f.refusal.attemptId);
    expect(f.recovery.inspect('quota-session')).toMatchObject({ ok: false });
  });

  it('invalidates quota on a later context error and cannot finalize a superseded report', () => {
    const f = fixture();
    const old = f.recovery.beginFailureSource({ sessionId: 'quota-session', classification: f.refusal.classification,
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '2' },
    });
    f.recovery.beginFailureSource({ sessionId: 'quota-session',
      classification: { ...f.refusal.classification, kind: 'unknown' },
      nativeProviderSource: { nativeId: 'same-native', pid: 123, publisherIncarnationId: 'original-publisher', sequence: '3' },
    });
    old?.(f.refusal.attemptId);
    expect(f.recovery.inspect('quota-session')).toMatchObject({ ok: false });
  });

  it('requires a fresh completed turn from the exact native publisher before reporting useful output', async () => {
    const f = fixture();
    await f.recovery.run(f.request, f.execute);
    f.tracked.pid = 456;
    f.tracked.publisherIncarnationId = 'new-publisher';
    f.tracked.activeTurnId = 'turn-1';
    f.recovery.settleRestart(123, f.tracked);
    f.advanceClock();
    const subject: typeof f.recovery & { prepareNativeCompletion?: (input: {
      sessionId: string; event: string; terminalStatus?: string; turnId?: string;
      nativeProviderSource?: { nativeId: string; pid: number; publisherIncarnationId: string; sequence: string };
    }) => (() => void) | null } = f.recovery;
    const completion = { sessionId: 'quota-session', event: 'assistant_message_end',
      terminalStatus: 'completed', turnId: 'turn-1',
      nativeProviderSource: { nativeId: 'same-native', pid: 456, publisherIncarnationId: 'new-publisher', sequence: '1' } };
    for (const bad of [
      { ...completion, terminalStatus: 'failed' },
      { ...completion, event: 'task_started' },
      { ...completion, turnId: 'old-turn' },
      { ...completion, nativeProviderSource: { ...completion.nativeProviderSource, nativeId: 'old-native' } },
      { ...completion, nativeProviderSource: { ...completion.nativeProviderSource, publisherIncarnationId: 'old-publisher' } },
      { ...completion, nativeProviderSource: { ...completion.nativeProviderSource, pid: 123 } },
    ]) {
      subject.prepareNativeCompletion?.({ ...bad, nativeProviderSource: bad.nativeProviderSource
        ? { ...bad.nativeProviderSource, sequence: '0' } : undefined })?.();
      expect(f.recovery.inspect('quota-session', 'attempt-1')).not.toHaveProperty('occurrence.verification');
    }
    const commit = subject.prepareNativeCompletion?.(completion);
    delete f.tracked.activeTurnId; // The actual marker owner clears this before acknowledging recorded.
    commit?.();
    expect(f.recovery.inspect('quota-session', 'attempt-1')).toMatchObject({ occurrence: {
      verification: { useful: true, kind: 'completion', nativeId: 'same-native', pid: 456,
        publisherIncarnationId: 'new-publisher', turnId: 'turn-1', atMs: 201 },
    } });
  });

  it('preserves real tracked input and reconciles one request without another restart', async () => {
    const f = fixture();
    const before = structuredClone(f.tracked.spawnOptions);
    const result = await f.recovery.run(f.request, f.execute);
    expect(result).toMatchObject({ ok: true, occurrence: { stage: 'restart_requested', nativeId: 'same-native' } });
    expect(f.tracked.spawnOptions).toMatchObject({ modelId: before?.modelId, permissionMode: before?.permissionMode,
      pendingFirstInput: before?.pendingFirstInput, initialGoal: before?.initialGoal,
      sessionConfigOptionOverrides: before?.sessionConfigOptionOverrides });
    expect(await f.recovery.run(f.request, f.execute)).toEqual(result);
    expect(f.restart).toHaveBeenCalledTimes(1);
    f.recovery.settleRestart(123, { ...f.tracked, pid: 456, vendorResumeId: 'other-native' });
    expect(f.recovery.inspect('quota-session', 'attempt-1')).toMatchObject({ occurrence: { stage: 'restart_requested' } });
    f.recovery.settleRestart(123, { ...f.tracked, pid: 456 });
    expect(f.recovery.inspect('quota-session', 'attempt-1')).toMatchObject({ occurrence: { stage: 'launched' } });
  });

  it('refuses request-ID drift and a second nonce for the same refusal', async () => {
    const f = fixture();
    await f.recovery.run(f.request, f.execute);
    expect(await f.recovery.run({ ...f.request, agentId: 'claude' }, f.execute))
      .toEqual({ ok: false, errorCode: 'quota_recovery_request_id_conflict' });
    expect(await f.recovery.run({ ...f.request, quotaRecovery: { ...f.request.quotaRecovery, requestId: 'attempt-2' } }, f.execute))
      .toEqual({ ok: false, errorCode: 'quota_recovery_prior_occurrence_unreconciled' });
    expect(f.restart).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed effect unresolved across reads and duplicate delivery', async () => {
    const f = fixture();
    f.restart.mockRejectedValue(new Error('OS acknowledgement lost'));
    expect(await f.recovery.run(f.request, f.execute)).toMatchObject({ occurrence: { stage: 'unknown' } });
    await f.recovery.run(f.request, f.execute);
    expect(f.recovery.inspect('quota-session', 'attempt-1')).toMatchObject({ occurrence: { stage: 'unknown' } });
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.recovery.inspect('quota-session', 'missing')).toEqual({ ok: false, errorCode: 'quota_recovery_occurrence_unknown' });
  });

  it('refuses a new foreground turn after persistence and leaves input intact', async () => {
    const f = fixture();
    const before = structuredClone(f.tracked.spawnOptions);
    f.persist.mockImplementation(async () => { f.startTurn(); });
    expect(await f.recovery.run(f.request, f.execute)).toMatchObject({ occurrence: { stage: 'unknown' } });
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.tracked.spawnOptions).toEqual(before);
  });

  it('does not credit a completion overtaken by a newer turn while its marker write is pending', async () => {
    const f = fixture();
    await f.recovery.run(f.request, f.execute);
    f.tracked.pid = 456;
    f.tracked.publisherIncarnationId = 'new-publisher';
    f.tracked.activeTurnId = 'completed-turn';
    f.recovery.settleRestart(123, f.tracked);
    f.advanceClock();
    const commit = f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'assistant_message_end',
      terminalStatus: 'completed', turnId: 'completed-turn', nativeProviderSource: {
        nativeId: 'same-native', pid: 456, publisherIncarnationId: 'new-publisher', sequence: '1',
      } });
    f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'task_started', nativeProviderSource: {
      nativeId: 'same-native', pid: 456, publisherIncarnationId: 'new-publisher', sequence: '2',
    } });
    commit?.();
    expect(f.recovery.inspect('quota-session', 'attempt-1')).not.toHaveProperty('occurrence.verification');
  });

  it('retains useful native completion before the account-switch acknowledgement without crediting launch alone', async () => {
    const f = fixture();
    const result = await f.recovery.run(f.request, async (guard) => {
      // The real switch owns the binding commit and the effect; hold only its reply.
      const switched = await f.execute(guard);
      f.tracked.pid = 456;
      f.tracked.publisherIncarnationId = 'new-publisher';
      f.tracked.activeTurnId = 'early-completion';
      f.advanceClock();
      const commit = f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'assistant_message_end',
        terminalStatus: 'completed', turnId: 'early-completion', nativeProviderSource: {
          nativeId: 'same-native', pid: 456, publisherIncarnationId: 'new-publisher', sequence: '1',
        } });
      delete f.tracked.activeTurnId;
      commit?.();
      expect(f.recovery.inspect('quota-session', 'attempt-1')).not.toHaveProperty('occurrence.verification');
      f.recovery.settleRestart(123, f.tracked);
      f.advanceClock();
      return switched;
    });
    expect(result).toMatchObject({ occurrence: { stage: 'launched',
      verification: { kind: 'completion', turnId: 'early-completion', atMs: 201 } } });
  });

  it('does not verify useful continuation after a non-account option has changed', async () => {
    const f = fixture();
    await f.recovery.run(f.request, f.execute);
    f.tracked.pid = 456;
    f.tracked.publisherIncarnationId = 'new-publisher';
    f.tracked.activeTurnId = 'turn';
    f.recovery.settleRestart(123, f.tracked);
    f.tracked.spawnOptions!.modelId = 'a-different-model';
    f.advanceClock();
    f.recovery.prepareNativeCompletion({ sessionId: 'quota-session', event: 'assistant_message_end',
      terminalStatus: 'completed', turnId: 'turn', nativeProviderSource: {
        nativeId: 'same-native', pid: 456, publisherIncarnationId: 'new-publisher', sequence: '1',
      } })?.();
    expect(f.recovery.inspect('quota-session', 'attempt-1')).not.toHaveProperty('occurrence.verification');
  });
});
