import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { resolveRuntimeAuthRecoveryResultDisposition } from './resolveRuntimeAuthRecoveryResultDisposition';
import { createConnectedServiceSessionAuthSwitchCore } from './connectedServiceSessionAuthSwitchCore';
import { retryRuntimeAuthLimitAfterReset } from './retryRuntimeAuthLimitAfterReset';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { TransactionalRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit', serviceId: 'anthropic', profileId: 'primary', groupId: null,
  resetsAtMs: 10_000, retryAfterMs: 90_000, planType: null, rateLimits: null,
  source: 'structured_provider_error', sourceKey: 'provider-source-0',
};
const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId: 'session-1', ...classification });

afterEach(() => vi.useRealTimers());

function harness(input: {
  maxAttempts?: number; suppressed?: boolean; mode?: 'standard' | 'off';
  durableStore?: TransactionalRecoveryStore<RuntimeAuthRecoveryIntent>;
  resumeSourceGate?: () => Promise<void>;
  nowMs?: () => number;
} = {}) {
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
  const recover = (issue = classification) => handleConnectedServiceRuntimeAuthFailure({
    sessionId: 'session-1', selection: { kind: 'profile', serviceId: 'anthropic', profileId: 'primary' },
    classification: issue, switchesThisTurn: 0,
    switchCoordinator: { switchAfterClassifiedFailure: async () => { throw new Error('no group switch for a profile'); } },
  });
  const scheduler = new RuntimeAuthRecoveryScheduler({
    nowMs: () => input.nowMs?.() ?? nowMs, baseBackoffMs: 100, maxBackoffMs: 1_000, jitterMs: () => 0,
    maxAttempts: input.maxAttempts ?? 2, providerOutcomePendingWaitMs: 1_000,
    recover: async ({ classification: issue }) => await recover(issue),
    ...(input.durableStore ? { durableStore: input.durableStore } : {}),
    retryAfterLimitReset: async (retry) => await retryRuntimeAuthLimitAfterReset({
      ...retry,
      resolveResumeSource: async () => {
        await input.resumeSourceGate?.();
        return { happySessionId: 'session-1', vendorResumeId: 'vendor-1', spawnOptions: {
        directory: '/project', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } };
      },
      credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      readCredentials: async () => null, spawnSession, sendMessage,
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
      customResumePrompt: null,
      switchCore: createConnectedServiceSessionAuthSwitchCore(),
      authorizeSource: async () => ({ status: 'authorized', tracked: null }),
    }),
  });
  const reportLimit = async (reportId: string, patch: Partial<ConnectedServiceRuntimeFailureClassification> = {}) => {
    const issue = { ...classification, ...patch };
    const intake = await scheduler.beginClassifiedFailure({ reportId, sessionId: 'session-1',
      switchesThisTurn: 0, classification: issue, resumePromptMode: input.mode ?? 'standard' });
    await scheduler.markDurableWaitForResultByKey({ recoveryKey, result: await recover(issue),
      classificationFailureKind: issue.kind, classificationResetsAtMs: issue.resetsAtMs,
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
      await h.reportLimit('fresh-provider-limit-2');
      h.setNow(h.scheduler.readByKey(recoveryKey)?.nextRetryAtMs ?? 300_000);
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(2);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted', limitResetRetryCount: 2 });
    } finally { h.scheduler.dispose(); }
  });

  it('retains the budget across fresh source evidence and durable hydration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'limit-reset-budget-'));
    const path = join(dir, 'recovery.json');
    const first = harness({ durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
    try {
      await first.reportLimit('initial');
      first.setNow(10_000);
      await first.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      await first.reportLimit('fresh-provider-limit', { sourceKey: 'provider-source-1', resetsAtMs: 20_000 });
      expect(first.scheduler.readByKey(recoveryKey)).toMatchObject({ limitResetRetryCount: 1 });
      first.scheduler.dispose();
      const second = harness({ durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
      try {
        second.scheduler.hydratePassive();
        second.setNow(20_000);
        await second.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
        expect(second.sendMessage).toHaveBeenCalledTimes(1);
        expect(second.scheduler.readByKey(recoveryKey)).toMatchObject({ limitResetRetryCount: 2 });
        await second.reportLimit('fresh-provider-limit-again', { sourceKey: 'provider-source-2', resetsAtMs: 30_000 });
        second.setNow(30_000);
        await second.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
        expect(second.sendMessage).toHaveBeenCalledTimes(1);
        expect(second.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted', limitResetRetryCount: 2 });
      } finally { second.scheduler.dispose(); }
    } finally { first.scheduler.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it('does not spend a provider trial or submit input when disposed during resume lookup', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ resumeSourceGate: async () => { enter(); await gate; } });
    try {
      await h.reportLimit('initial');
      h.setNow(10_000);
      const wake = h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      await entered;
      h.scheduler.dispose();
      release();
      await wake;
      expect(h.spawnSession).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting', limitResetRetryCount: 0 });
    } finally { release(); h.scheduler.dispose(); }
  });

  it('counts only a provider trial when a manual wake crosses the reset boundary', async () => {
    let crossing = false;
    let reads = 0;
    let nowMs = 1_000;
    const h = harness({ nowMs: () => crossing ? (++reads <= 4 ? 9_999 : 10_000) : nowMs });
    try {
      await h.reportLimit('initial');
      for (let i = 0; i < 5; i++) await h.scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      crossing = true;
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      crossing = false;
      nowMs = 10_000;
      await h.scheduler.wakeByKey({ recoveryKey, reason: 'timer' });
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { h.scheduler.dispose(); }
  });

  it('preserves grouped action-required disposition instead of waiting for an unavailable non-group trial', async () => {
    const issue = { ...classification, groupId: 'team' };
    const result = await handleConnectedServiceRuntimeAuthFailure({
      sessionId: 'session-1', selection: null, classification: issue, switchesThisTurn: 0,
      switchCoordinator: { switchAfterClassifiedFailure: async () => { throw new Error('selection unavailable'); } },
    });
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result, classificationResetsAtMs: 10_000,
      classificationFailureKind: 'usage_limit', nowMs: 9_999 })).toMatchObject({ kind: 'durable_wait', nextRetryAtMs: 10_000 });
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result, classificationResetsAtMs: 10_000,
      classificationFailureKind: 'usage_limit', nowMs: 10_000 })).toEqual({ kind: 'terminal', reason: 'recovery_action_required' });
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
