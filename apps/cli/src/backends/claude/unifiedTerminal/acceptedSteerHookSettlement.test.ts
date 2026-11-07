import { describe, expect, it, vi } from 'vitest';

import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedInFlightSteerEvaluator } from './createClaudeUnifiedInFlightSteerEvaluator';
import { createClaudeUnifiedPromptInjector } from './createClaudeUnifiedPromptInjector';
import { runTerminalPromptSubmission, resolveTerminalPromptSubmissionFailureReason } from '@/integrations/terminalHost/promptSubmitVerification';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';

describe('accepted steer hook settlement', () => {

  it.each([
    ['staging', true], ['submitted', true],
    ['staging', false], ['submitted', false],
  ] as const)('retains an unresolved steer as a hook identity competitor (%s, identical text: %s)', async (hookPhase, identicalText) => {
    let hook: ((data: SessionHookData) => void) | undefined;
    const acceptedLocalIds: string[] = [];
    const enteredTexts: string[] = [];
    let injectionCount = 0;
    const firstText = 'an unresolved native steer';
    const secondText = identicalText ? firstText : 'a distinct new turn';
    const wiring = createClaudeUnifiedInFlightSteerEvaluator({
      hostAdapter: {
        captureInputState: async () => ({
          stable: true, currentInput: '● Reading files\n✶ Forging… (42s · esc to interrupt)', observedAt: 10_000,
        }),
      },
      handle: {
        kind: 'tmux', sessionName: 'delayed-steer-hook', paneId: '%1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
      telemetry: { emit: () => {} },
    });
    const delayedHook = () => {
      if (!hook) throw new Error('Claude session hook subscription was not registered');
      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'same-claude-session', prompt: firstText });
    };
    const injector = createClaudeUnifiedPromptInjector({
      // Terminal capture, Enter and hook delivery are the external boundary; correlation and
      // submission remain real, including resolveDeliveryState before Enter.
      inputInjection: {
        hostKind: 'tmux',
        injectUserPrompt: async input => {
          const isSecond = ++injectionCount === 2;
          const result = await runTerminalPromptSubmission({
            promptText: input.text,
            resolveDeliveryState: input.resolveDeliveryState,
            verifyStagedBeforeSubmit: async () => {
              if (isSecond && hookPhase === 'staging') delayedHook();
              return true;
            },
            submitEnter: async () => { enteredTexts.push(input.text); return 'success'; },
          });
          return result.success
            ? { status: 'injected', at: 10_000, bytesWritten: input.text.length }
            : { status: 'failed', reason: resolveTerminalPromptSubmissionFailureReason(result.reason), phase: result.phase, duplicateRisk: result.duplicateRisk, recoverable: true };
        },
      },
    });
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: wiring.evaluateInFlightSteer,
      injectPrompt: injector.injectPrompt,
      resolvePromptDeliveryState: () => 'pending',
      onPromptInjected: wiring.observeInjectedPrompt,
      onPromptAccepted: batch => { acceptedLocalIds.push(...(batch.userMessageLocalIds ?? [])); },
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: callback => { hook = callback; return () => { hook = undefined; }; },
      arbiter, completionQuiescenceMs: 0,
    });
    try {
      bridge.start({ abortSignal: new AbortController().signal });
      arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
      arbiter.observeLifecycle({ type: 'output' });
      await arbiter.enqueueUiMessage({
        message: firstText, origin: { kind: 'ui_pending' }, pendingProviderAction: 'steer', userMessageLocalIds: ['steer-A'],
      });
      await arbiter.drainWhenSafe();
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, terminalCustodyCount: 0, providerAcceptancePendingCount: 0 });
      arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
      await arbiter.enqueueUiMessage({ message: secondText, origin: { kind: 'ui_pending' }, userMessageLocalIds: ['turn-B'] });
      await arbiter.drainWhenSafe();
      if (hookPhase === 'submitted') delayedHook();
      // The old steer hook proves neither row's consumption, and must never skip B's Enter.
      expect(enteredTexts).toEqual([firstText, secondText]);
      expect(acceptedLocalIds).toEqual([]);
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 2, providerAcceptancePendingCount: 1 });
      // Exact transcript identity can still settle either live row independently.
      await expect(arbiter.confirmPromptAcceptedByProviderIf(batch => batch.userMessageLocalIds?.[0] === 'steer-A')).resolves.toBe(true);
      expect(acceptedLocalIds).toEqual(['steer-A']);
      await expect(arbiter.confirmPromptAcceptedByProviderIf(batch => batch.userMessageLocalIds?.[0] === 'turn-B')).resolves.toBe(true);
      expect(acceptedLocalIds).toEqual(['steer-A', 'turn-B']);
    } finally {
      bridge.dispose();
      wiring.dispose();
      await arbiter.dispose();
    }
  });

  it.each(['idle', 'running'] as const)('uses an early submit hook as acceptance only for a new turn (injection state: %s)', async (turnState) => {
    let hook: ((data: SessionHookData) => void) | undefined;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: async () => ({ steer: true }),
      injectPrompt: async (batch) => {
        hook?.({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: batch.message });
        return { status: 'injected', at: Date.now(), bytesWritten: batch.message.length };
      },
      onPromptAccepted: (batch) => { accepted.push(batch.message); },
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => { hook = callback; return () => { hook = undefined; }; },
      arbiter,
      completionQuiescenceMs: 0,
    });
    try {
      bridge.start({ abortSignal: new AbortController().signal });
      arbiter.observeLifecycle({ type: 'turn_state', state: turnState });
      arbiter.observeLifecycle({ type: 'output' });
      await arbiter.enqueueUiMessage({
        message: 'early hook prompt', origin: { kind: 'ui_pending' }, userMessageLocalIds: ['early-hook-local'],
      });
      await arbiter.drainWhenSafe();
      expect(accepted).toEqual(turnState === 'idle' ? ['early hook prompt'] : []);
      // A submitted steer is tracked for transcript correlation but no longer blocks the pending
      // queue pump; Claude can accept more native queued steers before consuming this one.
      expect(arbiter.snapshot().providerAcceptancePendingCount).toBe(0);
    } finally {
      bridge.dispose();
      await arbiter.dispose();
    }
  });

  it.each([false, true])('retains a queued steer through UserPromptSubmit until absorption (terminal custody observed: %s)', async (terminalCustodyObserved) => {
    const acceptedLocalIds: string[][] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    let injectedBatch: Parameters<ReturnType<typeof createClaudeUnifiedInputArbiter>['observePromptCustodyByTerminal']>[0] | null = null;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      busyTurnFallbackWakeMs: 60_000,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      injectPrompt: vi.fn(async (batch) => {
        injectedBatch = batch;
        return {
          status: 'injected' as const,
          at: 10_000,
          bytesWritten: batch.message.length,
          inFlightSteer: true,
        };
      }),
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push([...(batch.userMessageLocalIds ?? [])]);
      },
      onProviderAcceptancePending: (batch) => {
        discovery.recordAcceptedPrompt({
          message: batch.message,
          deliveryIdentity: { localIds: batch.userMessageLocalIds },
        });
      },
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter,
      completionQuiescenceMs: 0,
    });

    try {
      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
      await arbiter.enqueueUiMessage({
        message: 'exact accepted steer',
        origin: { kind: 'ui_pending' },
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['d0c32266-56b9-4421-8b3a-56fcd6d1605b'],
      });
      await arbiter.drainWhenSafe();
      expect(injectedBatch).not.toBeNull();
      if (terminalCustodyObserved) await arbiter.observePromptCustodyByTerminal(injectedBatch!);
      await arbiter.enqueueUiMessage({
        message: 'neighbor pending prompt',
        origin: { kind: 'ui_pending' },
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['neighbor-local-id'],
      });

      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (!hook) throw new Error('Claude session hook subscription was not registered');

      // TUI custody and generic active-turn output are not provider acceptance.
      arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_001 });
      expect(acceptedLocalIds).toEqual([]);
      const retained = { terminalCustodyCount: terminalCustodyObserved ? 1 : 0, queuedCount: terminalCustodyObserved ? 1 : 2 };
      expect(arbiter.snapshot()).toMatchObject(retained);

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'unrelated terminal prompt',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([]);

      // Claude Code invokes this hook while the prompt is still in its native queue.
      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'exact accepted steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([]);
      expect(arbiter.snapshot()).toMatchObject(retained);
      expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBe(terminalCustodyObserved ? 'd0c32266-56b9-4421-8b3a-56fcd6d1605b' : null);

      const queueRow = {
        type: 'queue-operation', sessionId: 'claude-session-id',
        content: 'exact accepted steer', timestamp: new Date(10_000).toISOString(),
      };
      expect(discovery.findMatchingTranscript([{ ...queueRow, operation: 'enqueue' }])).toBeNull();
      expect(discovery.findMatchingTranscript([{ ...queueRow, operation: 'remove', reason: 'absorbed_mid_turn' }])).toBeNull();
      const match = discovery.findMatchingTranscript([{
        type: 'attachment', uuid: 'absorbed-steer', parentUuid: 'preceding-tool-result',
        isSidechain: false, sessionId: queueRow.sessionId, timestamp: queueRow.timestamp,
        attachment: {
          type: 'queued_command', prompt: queueRow.content, commandMode: 'prompt',
          origin: { kind: 'human' }, timestamp: queueRow.timestamp,
        },
      }]);
      expect(match?.deliveryIdentity?.localIds).toEqual(['d0c32266-56b9-4421-8b3a-56fcd6d1605b']);
      await arbiter.confirmPromptAcceptedByProviderIf((batch) => (
        batch.userMessageLocalIds?.[0] === match?.deliveryIdentity?.localIds?.[0]
      ));
      expect(acceptedLocalIds).toEqual([['d0c32266-56b9-4421-8b3a-56fcd6d1605b']]);
      expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 0, queuedCount: 1 });
      expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'exact accepted steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([['d0c32266-56b9-4421-8b3a-56fcd6d1605b']]);
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1 });
    } finally {
      bridge.dispose();
      await arbiter.dispose();
    }
  });
});
