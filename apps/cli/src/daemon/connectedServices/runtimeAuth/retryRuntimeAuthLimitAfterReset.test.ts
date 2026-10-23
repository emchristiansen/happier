import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from './handleConnectedServiceRuntimeAuthFailureForSession';
import { createConnectedServiceSessionAuthSwitchCore } from './connectedServiceSessionAuthSwitchCore';
import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import { retryRuntimeAuthLimitAfterReset } from './retryRuntimeAuthLimitAfterReset';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const sessionId = 'c111111111111111111111111';
const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit', serviceId: 'claude-subscription', profileId: 'primary', groupId: null,
  credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', sourceKey: 'provider-report',
  resetsAtMs: 10_000, retryAfterMs: 90_000, planType: null, rateLimits: null,
  source: 'structured_provider_error',
};
const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId, ...classification });
const credentials: Credentials = { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Hold the session lane with an executing owner, as a long credential refresh does. */
function holdSessionLane(switchCore: ReturnType<typeof createConnectedServiceSessionAuthSwitchCore>) {
  const entered = deferred(); const release = deferred();
  const owner = switchCore.run({ sessionId, reason: 'automatic_runtime_failure', execute: async () => {
    entered.resolve(); await release.promise;
  } });
  return { entered: entered.promise, release: release.resolve, owner };
}

/** Resolve once the next acquisition is queued behind the held lane. */
function observeNextAcquisition(switchCore: ReturnType<typeof createConnectedServiceSessionAuthSwitchCore>) {
  const queued = deferred();
  const run = switchCore.run;
  vi.spyOn(switchCore, 'run').mockImplementation((params) => {
    // The core queues synchronously before returning its pending acquisition.
    const result = run(params);
    queued.resolve();
    return result;
  });
  return queued.promise;
}

function harness(input: { lookupGate?: () => Promise<void>; loseAcknowledgement?: boolean; acceptFirst?: boolean;
  alwaysLoseAcknowledgement?: boolean; alwaysLoseAcknowledgementAfterFirst?: boolean; loseAcknowledgementAttempts?: ReadonlyArray<number>; postGate?: () => Promise<void>;
  durableStore?: ConstructorParameters<typeof RuntimeAuthRecoveryScheduler>[0]['durableStore'];
  terminal?: Map<string, unknown>; mode?: 'standard' | 'custom'; } = {}) {
  vi.useFakeTimers();
  let now = 1_000;
  let profileId = 'primary';
  let credentialRevision = classification.credentialRevision!;
  let groupId: string | null = null;
  let customResumePrompt = 'Continue the original work.';
  const tracked = { startedBy: 'daemon' as const, happySessionId: sessionId, pid: 123,
    vendorResumeId: 'vendor-1', spawnOptions: { directory: '/project', backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const } } };
  const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: false });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
      await input.lookupGate?.();
      return { status: 200, data: { session } };
    }
    throw new Error(`Unexpected HTTP GET: ${url}`);
  });
  // Model the server's exact-localId Pending + terminal deduplication boundary.
  // Consumption removes a queued row but retains its terminal localId/content.
  const terminal = input.terminal ?? new Map<string, unknown>();
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: any) => {
    if (!String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) throw new Error(`Unexpected HTTP POST: ${url}`);
    await input.postGate?.();
    if (input.alwaysLoseAcknowledgement || (input.alwaysLoseAcknowledgementAfterFirst && post.mock.calls.length > 1)) {
      terminal.set(body.localId, body);
      throw new Error('timeout after Pending POST');
    }
    const previous = terminal.get(body.localId);
    if (previous) {
      expect(body).toEqual(previous);
      return { status: 200, data: { didWrite: false, terminal: true, message: { id: 'message-1', seq: 1, localId: body.localId, requestedAction: body.requestedAction } } };
    }
    if (post.mock.calls.length !== 1 || input.acceptFirst !== false) terminal.set(body.localId, body);
    if ((input.loseAcknowledgement && post.mock.calls.length === 1)
      || input.loseAcknowledgementAttempts?.includes(post.mock.calls.length)) throw new Error('timeout after Pending POST');
    return { status: 200, data: { didWrite: true } };
  });
  const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId, runnerAcceptance: 'preexisting_or_adopted' as const }));
  const switchCore = createConnectedServiceSessionAuthSwitchCore();
  const authorizeSource = () => authorizeConnectedServiceRuntimeAuthFailureSource({
    getChildren: () => [tracked], sessionId, classification, recoveryInvocationSource: 'scheduler_retry',
    runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
    resolveRegisteredRuntimeAuthFailureSource: () => ({ status: 'bound', binding: { serviceId: 'claude-subscription', profileId,
      groupId, generation: groupId === null ? null : 1, credentialRevision } }),
  });
  const recover = () => handleConnectedServiceRuntimeAuthFailure({ sessionId,
    selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'primary' },
    classification, switchesThisTurn: 0,
    switchCoordinator: { switchAfterClassifiedFailure: async () => { throw new Error('not a group'); } },
  });
  const scheduler = new RuntimeAuthRecoveryScheduler({
    nowMs: () => now, baseBackoffMs: 100, maxBackoffMs: 1_000, jitterMs: () => 0, maxAttempts: 3,
    durableStore: input.durableStore, readLimitResetCustomResumePrompt: () => customResumePrompt,
    providerOutcomePendingWaitMs: 1_000, recover: async () => await recover(),
    retryAfterLimitReset: (retry) => retryRuntimeAuthLimitAfterReset({ ...retry,
      resolveResumeSource: async () => tracked, credentials, readCredentials: async () => null, spawnSession,
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
      authorizeSource, switchCore,
    }),
  });
  const reportLimit = async (reportId: string) => {
    const intake = await scheduler.beginClassifiedFailure({ reportId, sessionId,
      classification, switchesThisTurn: 0, resumePromptMode: input.mode ?? 'standard' });
    await scheduler.markDurableWaitForResultByKey({ recoveryKey, result: await recover(),
      classificationFailureKind: classification.kind, classificationResetsAtMs: classification.resetsAtMs,
      expectedAttemptId: intake.attemptId });
  };
  return { scheduler, post, terminal, spawnSession, switchCore, reportLimit,
    setMetadata: (metadata: unknown) => { session.metadata = JSON.stringify(metadata); },
    setCustomPrompt: (value: string) => { customResumePrompt = value; },
    setBinding: (nextProfile: string, nextGroup: string | null = null, revision = credentialRevision) => {
      profileId = nextProfile; groupId = nextGroup; credentialRevision = revision;
    },
    arm: async () => { await reportLimit('initial'); now = 10_000; },
    wake: async () => { now = Math.max(now, scheduler.readByKey(recoveryKey)?.nextRetryAtMs ?? now); await scheduler.wakeByKey({ recoveryKey, reason: 'timer' }); },
  };
}

describe('expired limit trial admission and source ownership', () => {
  it('reconciles an accepted and consumed Pending write under the same identity after a lost acknowledgement', async () => {
    const h = harness({ loseAcknowledgement: true });
    try {
      await h.arm(); await h.wake();
      expect(h.terminal.size).toBe(1);
      await h.wake();
      expect(h.post).toHaveBeenCalledTimes(2);
      expect(h.terminal.size).toBe(1);
      expect(h.post.mock.calls[1]?.[1]).toEqual(h.post.mock.calls[0]?.[1]);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { h.scheduler.dispose(); }
  });

  it('does not admit after Stop while the real session transport lookup is in flight', async () => {
    const entered = deferred(); const release = deferred();
    const h = harness({ lookupGate: async () => { entered.resolve(); await release.promise; } });
    try {
      await h.arm(); const wake = h.wake(); await entered.promise;
      await h.scheduler.cancel({ sessionId }); release.resolve(); await wake;
      expect(h.post).not.toHaveBeenCalled();
      expect(h.scheduler.readByKey(recoveryKey)?.status).toBe('cancelled');
    } finally { release.resolve(); h.scheduler.dispose(); }
  });

  it.each([['secondary', null], ['primary', 'new-group']] as const)('supersedes the old limit source after switching to %s/%s', async (profile, group) => {
    const h = harness();
    try {
      await h.arm(); h.setBinding(profile, group); await h.wake();
      expect(h.spawnSession).not.toHaveBeenCalled();
      expect(h.post).not.toHaveBeenCalled();
      expect(h.scheduler.readByKey(recoveryKey)).toBeNull();
    } finally { h.scheduler.dispose(); }
  });

  it('admits an unaccepted first request on reconciliation without spending a second provider trial', async () => {
    const h = harness({ loseAcknowledgement: true, acceptFirst: false });
    try {
      await h.arm(); await h.wake(); expect(h.terminal.size).toBe(0);
      await h.wake();
      expect(h.terminal.size).toBe(1);
      expect(h.post.mock.calls[1]?.[1]).toEqual(h.post.mock.calls[0]?.[1]);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { h.scheduler.dispose(); }
  });

  it('retains the exact trial and custom prompt through durable hydration and a settings change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'limit-trial-custody-'));
    const path = join(directory, 'recovery.json');
    const terminal = new Map<string, unknown>();
    const first = harness({ loseAcknowledgement: true, terminal, mode: 'custom',
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
    try {
      first.setMetadata({ permissionMode: 'default', modelOverrideV1: { v: 1, modelId: 'original-model', updatedAt: 1 } });
      await first.arm(); await first.wake();
      const originalBody = first.post.mock.calls[0]?.[1];
      expect(first.scheduler.readByKey(recoveryKey)?.limitResetTrial).toMatchObject({ retryCount: 1, admissionAttemptCount: 1 });
      first.scheduler.dispose(); vi.restoreAllMocks();
      const second = harness({ terminal, mode: 'custom', durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
      try {
        second.setCustomPrompt('An updated preference must not change an unresolved input.');
        second.setMetadata({ permissionMode: 'bypassPermissions', modelOverrideV1: { v: 1, modelId: 'newer-model', updatedAt: 2 } });
        second.scheduler.hydratePassive(); await second.wake();
        expect(second.post.mock.calls[0]?.[1]).toEqual(originalBody);
        expect(terminal.size).toBe(1);
        expect(second.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
      } finally { second.scheduler.dispose(); }
    } finally { first.scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds ambiguous admission reconciliation while preserving its unresolved identity', async () => {
    const h = harness({ alwaysLoseAcknowledgement: true });
    try {
      await h.arm();
      for (let i = 0; i < 6; i++) await h.wake();
      expect(h.post).toHaveBeenCalledTimes(3);
      expect(h.terminal.size).toBe(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted', limitResetRetryCount: 1,
        limitResetTrial: { retryCount: 1, admissionAttemptCount: 3 } });
    } finally { h.scheduler.dispose(); }
  });

  it('keeps an already sent but unacknowledged trial when disposal occurs in the HTTP request', async () => {
    const entered = deferred(); const release = deferred();
    const h = harness({ loseAcknowledgement: true, postGate: async () => { entered.resolve(); await release.promise; } });
    try {
      await h.arm(); const wake = h.wake(); await entered.promise;
      h.scheduler.dispose(); release.resolve(); await wake;
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting', limitResetRetryCount: 1,
        limitResetTrial: { retryCount: 1, admissionAttemptCount: 1 } });
    } finally { release.resolve(); h.scheduler.dispose(); }
  });

  it('retains the canonical same-profile newer-credential allowance', async () => {
    const h = harness();
    try {
      await h.arm(); h.setBinding('primary', null, 'csr_bbbbbbbbbbbbbbbbbbbbbb'); await h.wake();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)?.status).toBe('resumed_awaiting_proof');
    } finally { h.scheduler.dispose(); }
  });

  it('authorizes after an earlier manual switch releases the existing session lane', async () => {
    const entered = deferred(); const release = deferred();
    const h = harness();
    try {
      await h.arm();
      const manual = h.switchCore.run({ sessionId, reason: 'manual', execute: async () => {
        entered.resolve(); await release.promise; h.setBinding('secondary');
      } });
      await entered.promise; const wake = h.wake();
      release.resolve(); await manual; await wake;
      expect(h.spawnSession).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
      expect(h.scheduler.readByKey(recoveryKey)).toBeNull();
    } finally { release.resolve(); h.scheduler.dispose(); }
  });


  it('retains lane ownership across normal runner exit while transport lookup is suspended', async () => {
    const entered = deferred(); const release = deferred();
    const h = harness({ lookupGate: async () => { entered.resolve(); await release.promise; } });
    let manualEntered = false;
    try {
      await h.arm(); const wake = h.wake(); await entered.promise;
      h.switchCore.clearSession(sessionId);
      const manual = h.switchCore.run({ sessionId, reason: 'manual', execute: async () => {
        manualEntered = true; h.setBinding('secondary');
      } });
      // Drain the microtask handoff used by runExclusive, without releasing lookup.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(manualEntered).toBe(false);
      release.resolve(); await wake; await manual;
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(manualEntered).toBe(true);
    } finally { release.resolve(); h.scheduler.dispose(); }
  });

  it('reconciles the original admission meaning after model and permission settings change', async () => {
    const h = harness({ loseAcknowledgement: true });
    try {
      h.setMetadata({ permissionMode: 'default', modelOverrideV1: { v: 1, modelId: 'first-model', updatedAt: 1 } });
      await h.arm(); await h.wake();
      const original = h.post.mock.calls[0]?.[1];
      h.setMetadata({ permissionMode: 'bypassPermissions', modelOverrideV1: { v: 1, modelId: 'second-model', updatedAt: 2 } });
      await h.wake();
      expect(h.post.mock.calls[1]?.[1]).toEqual(original);
      expect(h.scheduler.readByKey(recoveryKey)?.status).toBe('resumed_awaiting_proof');
      await h.reportLimit('confirmed-next-outcome'); await h.wake();
      expect(h.post.mock.calls[2]?.[1]).toMatchObject({ content: { v: { meta: { model: 'second-model', permissionMode: 'yolo' } } } });
      expect(h.terminal.size).toBe(2);
    } finally { h.scheduler.dispose(); }
  });

  it('keeps Off terminal without resolving the old source or runner', async () => {
    const authorizeSource = vi.fn(async () => { throw new Error('source unavailable'); });
    const resolveResumeSource = vi.fn(async () => null);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId }));
    expect(await retryRuntimeAuthLimitAfterReset({ sessionId, classification, attemptId: 'attempt-1', retryCount: 1,
      resumePromptMode: 'off', customResumePrompt: null, isCurrent: () => true,
      authorizeSource, resolveResumeSource, spawnSession, readCredentials: async () => null, credentials,
      switchCore: createConnectedServiceSessionAuthSwitchCore(),
    })).toEqual({ status: 'terminal', lastError: 'limit_reset_continuation_disabled' });
    expect(authorizeSource).not.toHaveBeenCalled(); expect(resolveResumeSource).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });


  it('does not replace unconfirmed custody with an arbitrary different provider report', async () => {
    const h = harness({ loseAcknowledgement: true });
    try {
      await h.arm(); await h.wake();
      const original = h.post.mock.calls[0]?.[1];
      await h.reportLimit('different-or-delayed-report'); await h.wake();
      expect(h.terminal.size).toBe(1);
      expect(h.post.mock.calls[1]?.[1]).toEqual(original);
      expect(h.scheduler.readByKey(recoveryKey)?.limitResetRetryCount).toBe(1);
    } finally { h.scheduler.dispose(); }
  });

  it('retains terminal unresolved custody through durable hydration and report replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'limit-terminal-replay-'));
    const path = join(directory, 'recovery.json');
    const terminal = new Map<string, unknown>();
    const first = harness({ alwaysLoseAcknowledgementAfterFirst: true, terminal,
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
    try {
      await first.arm(); await first.wake();
      await first.reportLimit('report-B');
      for (let i = 0; i < 4; i++) await first.wake();
      const exhausted = first.scheduler.readByKey(recoveryKey);
      expect(exhausted).toMatchObject({ status: 'exhausted', limitResetRetryCount: 2,
        limitResetTrial: { retryCount: 2, admissionAttemptCount: 3 } });
      first.scheduler.dispose(); vi.restoreAllMocks();
      const second = harness({ terminal, durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(path) });
      try {
        second.scheduler.hydratePassive();
        await second.reportLimit('report-B'); await second.wake();
        await second.reportLimit('older-unseen-report'); await second.wake();
        expect(second.post).not.toHaveBeenCalled();
        expect(terminal.size).toBe(2);
        expect(second.scheduler.readByKey(recoveryKey)).toEqual(exhausted);
      } finally { second.scheduler.dispose(); }
    } finally { first.scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('allows a new failure epoch after actual positive-proof settlement of unresolved custody', async () => {
    const h = harness({ alwaysLoseAcknowledgement: true });
    try {
      await h.arm(); for (let i = 0; i < 4; i++) await h.wake();
      expect(h.scheduler.readByKey(recoveryKey)?.status).toBe('exhausted');
      await h.scheduler.markProviderOutcomeProofByKey({ recoveryKey, proofKind: 'provider_activity' });
      expect(h.scheduler.readByKey(recoveryKey)?.status).toBe('recovered');
      await h.reportLimit('new-failure-after-positive-proof'); await h.wake();
      expect(h.terminal.size).toBe(2);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting', limitResetRetryCount: 1 });
    } finally { h.scheduler.dispose(); }
  });

  it('does not mistake a duplicate provider report for another outcome while admission is unconfirmed', async () => {
    const h = harness({ loseAcknowledgementAttempts: [2] });
    try {
      await h.arm(); await h.wake();
      await h.reportLimit('fresh-provider-report'); await h.wake();
      expect(h.terminal.size).toBe(2);
      await h.reportLimit('fresh-provider-report'); await h.wake();
      expect(h.post).toHaveBeenCalledTimes(3);
      expect(h.terminal.size).toBe(2);
      expect(h.post.mock.calls[2]?.[1]).toEqual(h.post.mock.calls[1]?.[1]);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 2 });
    } finally { h.scheduler.dispose(); }
  });

  it('defers and later retries a trial whose queued acquisition timed out behind a long owner', async () => {
    const h = harness();
    const lane = holdSessionLane(h.switchCore);
    try {
      await h.arm(); await lane.entered;
      const queued = observeNextAcquisition(h.switchCore);
      const wake = h.wake(); await queued;
      await vi.advanceTimersByTimeAsync(30_000); await wake;
      expect(h.spawnSession).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
      const deferredIntent = h.scheduler.readByKey(recoveryKey);
      expect(deferredIntent).toMatchObject({ status: 'waiting', lastError: 'limit_reset_retry_deferred', limitResetRetryCount: 0 });
      expect(deferredIntent?.limitResetTrial).toBeUndefined();
      expect(deferredIntent?.nextRetryAtMs).toEqual(expect.any(Number));
      lane.release(); await lane.owner;
      await h.wake();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { lane.release(); h.scheduler.dispose(); }
  });

  it('defers a queued trial when normal final-child exit clears the session lane', async () => {
    const h = harness();
    const lane = holdSessionLane(h.switchCore);
    try {
      await h.arm(); await lane.entered;
      const queued = observeNextAcquisition(h.switchCore);
      const wake = h.wake(); await queued;
      // Final-child cleanup without a surviving runner clears the core only; it does not cancel recovery.
      h.switchCore.clearSession(sessionId); await wake;
      expect(h.spawnSession).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
      const deferredIntent = h.scheduler.readByKey(recoveryKey);
      expect(deferredIntent).toMatchObject({ status: 'waiting', lastError: 'limit_reset_retry_deferred', limitResetRetryCount: 0 });
      expect(deferredIntent?.limitResetTrial).toBeUndefined();
      lane.release(); await lane.owner;
      await h.wake();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { lane.release(); h.scheduler.dispose(); }
  });

  it('keeps explicit Stop authoritative over a queued trial cancelled by its lane clear', async () => {
    const h = harness();
    const lane = holdSessionLane(h.switchCore);
    try {
      await h.arm(); await lane.entered;
      const queued = observeNextAcquisition(h.switchCore);
      const wake = h.wake(); await queued;
      // Mirror daemon Stop: clear queued acquisitions synchronously, then cancel recovery asynchronously.
      h.switchCore.clearSession(sessionId);
      const stop = Promise.resolve().then(async () => await h.scheduler.cancel({ sessionId }));
      await wake; await stop;
      lane.release(); await lane.owner;
      await vi.advanceTimersByTimeAsync(60_000); await h.wake();
      expect(h.spawnSession).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
    } finally { lane.release(); h.scheduler.dispose(); }
  });

  it('preserves an earlier ambiguous admission when its reconciliation cannot acquire the lane', async () => {
    const h = harness({ loseAcknowledgementAttempts: [1] });
    let lane: ReturnType<typeof holdSessionLane> | undefined;
    try {
      await h.arm(); await h.wake();
      const unresolved = h.scheduler.readByKey(recoveryKey);
      expect(unresolved?.limitResetTrial).toMatchObject({ retryCount: 1, admissionAttemptCount: 1, admissionBody: expect.anything() });
      lane = holdSessionLane(h.switchCore); await lane.entered;
      const queued = observeNextAcquisition(h.switchCore);
      const wake = h.wake(); await queued;
      h.switchCore.clearSession(sessionId); await wake;
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting', lastError: 'limit_reset_retry_deferred',
        attemptId: unresolved?.attemptId, limitResetRetryCount: 1, limitResetTrial: unresolved?.limitResetTrial });
      lane.release(); await lane.owner;
      await h.wake();
      expect(h.post).toHaveBeenCalledTimes(2);
      expect(h.post.mock.calls[1]?.[1]).toEqual(h.post.mock.calls[0]?.[1]);
      expect(h.terminal.size).toBe(1);
      expect(h.scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'resumed_awaiting_proof', limitResetRetryCount: 1 });
    } finally { lane?.release(); h.scheduler.dispose(); }
  });

});
