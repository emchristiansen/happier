import { afterEach, describe, expect, it, vi } from 'vitest';

import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { retryRuntimeAuthLimitAfterReset } from './retryRuntimeAuthLimitAfterReset';
import { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit', serviceId: 'anthropic', profileId: 'primary', groupId: null,
  resetsAtMs: 10_000, retryAfterMs: 90_000, planType: null, rateLimits: null,
  source: 'structured_provider_error',
};
const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId: 'session-1', ...classification });

afterEach(() => vi.useRealTimers());

function harness(input: { maxAttempts?: number; suppressed?: boolean; mode?: 'standard' | 'off' } = {}) {
  vi.useFakeTimers();
  let nowMs = 1_000;
  const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
    type: 'success', sessionId: 'session-1', runnerAcceptance: 'preexisting_or_adopted',
  }));
  // Process spawning and Pending transport are the real side-effect boundaries.
  // Policy, scheduler, runner resume and continuation admission stay real below.
  const sendMessage = vi.fn(async (_input: Parameters<typeof sendSessionMessage>[0]) => ({
    ok: true as const, sessionId: 'session-1', localId: 'accepted', waited: false,
    ...(input.suppressed ? { suppressed: true as const } : {}),
  }));
  const recover = () => handleConnectedServiceRuntimeAuthFailure({
    sessionId: 'session-1', selection: { kind: 'profile', serviceId: 'anthropic', profileId: 'primary' },
    classification, switchesThisTurn: 0,
    switchCoordinator: { switchAfterClassifiedFailure: async () => { throw new Error('no group switch for a profile'); } },
  });
  const scheduler = new RuntimeAuthRecoveryScheduler({
    nowMs: () => nowMs, baseBackoffMs: 100, maxBackoffMs: 1_000, jitterMs: () => 0,
    maxAttempts: input.maxAttempts ?? 2, providerOutcomePendingWaitMs: 1_000,
    recover,
    retryAfterLimitReset: async (retry) => await retryRuntimeAuthLimitAfterReset({
      ...retry,
      resolveResumeSource: async () => ({ happySessionId: 'session-1', vendorResumeId: 'vendor-1', spawnOptions: {
        directory: '/project', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } }),
      credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      readCredentials: async () => null, spawnSession, sendMessage,
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
      customResumePrompt: null,
    }),
  });
  const reportLimit = async (reportId: string) => {
    const intake = await scheduler.beginClassifiedFailure({ reportId, sessionId: 'session-1',
      switchesThisTurn: 0, classification, resumePromptMode: input.mode ?? 'standard' });
    await scheduler.markDurableWaitForResultByKey({ recoveryKey, result: await recover(),
      classificationFailureKind: classification.kind, classificationResetsAtMs: classification.resetsAtMs,
      expectedAttemptId: intake.attemptId });
  };
  return { scheduler, spawnSession, sendMessage, reportLimit, setNow: (value: number) => { nowMs = value; } };
}

describe('runtime-auth limit reset continuation', () => {
  it('hands an expired reset to the real runner and Pending path, then recovers only on provider activity', async () => {
    const h = harness();
    try {
      await h.reportLimit('initial');
      h.setNow(9_999);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).not.toHaveBeenCalled();
      h.setNow(10_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'session-1', resume: 'vendor-1' }));
      expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        idOrPrefix: 'session-1', requestedAction: { v: 1, kind: 'send_now' },
        pendingAdmissionMode: 'continuation_if_no_queued_user_input', resumeInactiveSession: false,
      }));
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
      h.setNow(100_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      await h.scheduler.markProviderOutcomeProofByKey({ recoveryKey, proofKind: 'provider_activity', observedAtMs: 100_000 });
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'recovered', nextRetryAtMs: null });
    } finally { h.scheduler.dispose(); }
  });

  it('backs off fresh still-limited outcomes and exhausts the post-reset trial budget without spinning', async () => {
    const h = harness({ maxAttempts: 2 });
    try {
      await h.reportLimit('initial');
      // Pre-reset policy checks do not spend the provider trial budget.
      for (let i = 0; i < 5; i++) await h.scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      h.setNow(10_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      await h.reportLimit('fresh-provider-limit-1');
      const deadline = h.scheduler.readByKey(recoveryKey)?.nextRetryAtMs;
      expect(deadline).toBeGreaterThan(10_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      h.setNow(deadline!);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(2);
      expect(new Set(h.sendMessage.mock.calls.map((call) => call[0]?.localId)).size).toBe(2);
      await h.reportLimit('fresh-provider-limit-2');
      h.setNow(h.scheduler.readByKey(recoveryKey)?.nextRetryAtMs ?? 200_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(2);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted', limitResetRetryCount: 2, nextRetryAtMs: null });
    } finally { h.scheduler.dispose(); }
  });

  it('keeps Off and explicit Stop authoritative at the reset', async () => {
    for (const mode of ['off', 'standard'] as const) {
      const h = harness({ mode });
      try {
        await h.reportLimit('initial');
        if (mode === 'standard') await h.scheduler.cancel({ sessionId: 'session-1' });
        h.setNow(10_000);
        await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
        expect(h.sendMessage).not.toHaveBeenCalled();
        expect(h.spawnSession).not.toHaveBeenCalled();
        expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
      } finally { h.scheduler.dispose(); }
    }
  });

  it('lets newer queued user input supersede the automatic continuation', async () => {
    const h = harness({ suppressed: true });
    try {
      await h.reportLimit('initial');
      h.setNow(10_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toBeNull();
    } finally { h.scheduler.dispose(); }
  });
});
