import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { requestPendingQueueV2Action } from '@/api/session/pendingQueueV2Transport';
import type { PendingInputSteerNowAdmission, ProviderInputTerminalOutcome } from '@/api/session/sessionClientPort';

import type { EnhancedMode } from '../loop';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import {
  createClaudeAgentSdkInterruptObservations,
  createClaudeAgentSdkPendingInputInterruptAndRunControl,
} from './createClaudeAgentSdkPendingInputInterruptAndRunControl';

type CreateQuery = NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;

/**
 * The control, the real pending-action transport, the real input consumer and the real SDK runner
 * pump, joined by a fake server and SDK. The fake server keeps the real materialization rule: a
 * `send_now` row becomes `interrupt_and_send` only while the foreground turn is busy, and otherwise
 * a plain send (`materializeNextPendingMessage`). Like Agent SDK 0.2.123's `streamInput`, the fake SDK
 * takes every user message from its streaming input as soon as the runner yields it (`sdkInput`), and
 * runs one turn per message (`sdkReceived`) until that turn ends. An interrupted turn's result carries
 * the abort terminal reason the 2.1.123 CLI reports (`aborted_streaming`).
 */
type InterruptAck =
  /** The provider interrupts the active turn and acknowledges. */
  | 'interrupts'
  /** The control response never arrives. Agent SDK 0.2.123 settles `interrupt()` only from its
   * control response or `close()`; a turn result does not settle it. */
  | 'never'
  /** The turn completes normally while the interrupt is in flight; the ACK follows. */
  | 'after_natural_completion'
  /** The control response arrives first; the interrupted turn's result follows later
   * (after the replacement has been streamed), via `endTurnInterrupted`. */
  | 'acknowledges_before_result'
  /** `interrupt()` throws before writing any request. */
  | 'throws_synchronously'
  /** The provider answers the interrupt with an error and the turn runs on. */
  | 'refuses'
  /** The provider refuses this interrupt when the test calls `refuseHeldInterrupt()`. */
  | 'refuses_when_told';

/** How the fake provider ends a turn. */
type TurnEnd =
  | 'interrupted'
  | 'completed'
  /** An ordinary execution failure: `error_during_execution` with terminal reason `model_error`. */
  | 'model_error'
  /** `error_during_execution` with no terminal reason, which proves nothing about why it ended. */
  | 'unclassified_execution_error'
  /** `error_during_execution` with a terminal reason this runner does not know. */
  | 'unknown_terminal_reason'
  /** An interrupt that stopped the turn while it ran tools. */
  | 'interrupted_in_tools';

function resultFor(end: TurnEnd, userMessageUuid: string) {
  const common = { type: 'result', session_id: 'sdk-session', user_message_uuid: userMessageUuid, queued_turn_count: 0 };
  switch (end) {
    case 'interrupted':
      return { ...common, subtype: 'error_during_execution', errors: ['Interrupted by user'], terminal_reason: 'aborted_streaming' };
    case 'completed':
      return { ...common, subtype: 'success', result: 'done' };
    case 'model_error':
      return { ...common, subtype: 'error_during_execution', errors: ['Model backend returned internal server error'],
        terminal_reason: 'model_error' };
    case 'unclassified_execution_error':
      return { ...common, subtype: 'error_during_execution', errors: ['Interrupted by user'] };
    case 'unknown_terminal_reason':
      return { ...common, subtype: 'error_during_execution', errors: ['Provider stopped: future reason'],
        terminal_reason: 'some_future_reason' };
    case 'interrupted_in_tools':
      return { ...common, subtype: 'error_during_execution', errors: ['Interrupted by user'], terminal_reason: 'aborted_tools' };
  }
}

function harness(config: Readonly<{
  /** `busy_until_ready`: the server still records the turn busy until the runner's readiness completes. */
  serverBusyView?: 'live' | 'stale_busy_after_turn_end' | 'busy_until_ready';
  interruptAck?: InterruptAck;
  /** Per call, in order; later calls fall back to `interruptAck`. */
  interruptAcks?: readonly InterruptAck[];
  rows?: readonly string[];
  texts?: Readonly<Record<string, string>>;
  /** Ordinary prompts queued after 'first'. */
  laterPrompts?: readonly string[];
  /** The first turn starts this foreground provider task, so the ordinary interrupt uses `stopTask`. */
  foregroundTask?: string;
  /** The first turn starts this background `local_bash` task, which outlives the turn. */
  detachedTask?: string;
  /** Prompts after 'first' wait for `feedLaterPrompt()`. */
  holdLaterPrompts?: boolean;
  /** Give the runner a streamed transcript writer and record each flush's reason. */
  observeFlushes?: boolean;
}> = {}) {
  const flushes: string[] = [];
  const streamedTranscriptWriter = config.observeFlushes ? {
    appendAssistantDelta: vi.fn(), appendThinkingDelta: vi.fn(),
    overrideAssistantText: vi.fn(), overrideThinkingText: vi.fn(),
    flushAll: vi.fn(async ({ reason }: { reason: string }) => { flushes.push(reason); return null; }),
  } : undefined;
  const mode = makeMode();
  const rows = new Map<string, { text: string; requestedAction?: string }>(
    (config.rows ?? ['p1']).map((localId) => [localId, {
      text: config.texts?.[localId] ?? (localId === 'p1' ? 'replacement' : `text-${localId}`),
    }]));
  const sdkInput: string[] = [];
  const sdkReceived: string[] = [];
  const transportFailures: Array<{ kind: string; userMessageLocalIds: readonly string[] }> = [];
  const completionEvents: unknown[] = [];
  let thinking = false;
  let sdkTurnBusy = false;
  let readyCount = 0;
  let readyPending = false;
  let readyGate: Promise<void> = Promise.resolve();
  const turnEnders: Array<() => void> = [];
  const settleOutcome = new Map<string, (outcome: ProviderInputTerminalOutcome) => void>();
  const outcomes = new Map<string, Promise<ProviderInputTerminalOutcome>>();
  const outcomeFor = (localId: string) => {
    let promise = outcomes.get(localId);
    if (!promise) {
      promise = new Promise((resolve) => { settleOutcome.set(localId, resolve); });
      outcomes.set(localId, promise);
    }
    return promise;
  };

  const patch = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
    const localId = decodeURIComponent(new URL(String(url)).pathname.split('/')[5]);
    const row = rows.get(localId);
    if (!row) throw new Error('Selected pending row does not exist');
    row.requestedAction = (body as { requestedAction: { kind: string } }).requestedAction.kind;
    return { data: { ok: true, didUpdate: true, requestedAction: (body as { requestedAction: unknown }).requestedAction } };
  });
  const messageQueue = new MessageQueue2<EnhancedMode>(() => 'hash');
  const consumer = createSessionProviderInputConsumer<EnhancedMode, string>({
    messageQueue: messageQueue as never,
    session: {
      waitForProviderInputAdmission: async (signal) => !signal.aborted,
      materializeNextPendingMessageSafely: async (opts?: { requestedLocalId?: string }) => {
        const localId = opts?.requestedLocalId;
        const row = localId === undefined ? undefined : rows.get(localId);
        // Only the exact send_now request may claim the row; an ordinary wake finds nothing to run.
        if (!row || row.requestedAction !== 'send_now') return { type: 'no_pending' as const };
        rows.delete(localId!);
        let serverSeesBusy = sdkTurnBusy || (config.serverBusyView === 'busy_until_ready' && readyPending);
        if (config.serverBusyView === 'stale_busy_after_turn_end') {
          // The server still records the turn as busy, but it ends and the runner settles it
          // before the materialized row reaches the runner.
          serverSeesBusy = true;
          const readyBefore = readyCount;
          releaseTurn();
          await vi.waitFor(() => { expect(readyCount).toBeGreaterThan(readyBefore); });
        }
        // Transcript delivery of the materialized row, as the session's update path does.
        messageQueue.push(row.text, mode, {
          userMessageLocalId: localId,
          providerAcceptancePending: true,
          ...(serverSeesBusy ? { pendingProviderAction: 'interrupt_and_send' as const } : {}),
        });
        return { type: 'materialized' as const, localId: localId!, seq: 3, content: null };
      },
      waitForPendingEligibilityUpdate: async () => false,
    },
  });

  let finishInput!: () => void;
  const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
  let echoGate: Promise<void> = Promise.resolve();
  // stopTask stays pending until the test settles it.
  const heldStopTasks: Array<{ resolve: () => void; reject: () => void }> = [];
  // Provider events between turns (a background task's notifications), yielded while the SDK idles.
  const sideEvents: unknown[] = [];
  let wakeSideEvents: (() => void) | null = null;
  let promptGate: Promise<void> = Promise.resolve();
  let feedPrompt: () => void = () => {};
  if (config.holdLaterPrompts) promptGate = new Promise<void>((resolve) => { feedPrompt = resolve; });
  const stopTask = vi.fn((_taskId: string) => new Promise<void>((resolve, reject) => {
    heldStopTasks.push({ resolve, reject: () => reject(new Error('stopTask failed')) });
  }));
  const perCallAcks = [...(config.interruptAcks ?? [])];
  const heldRefusals: Array<() => void> = [];
  const interrupt = vi.fn((): Promise<void> => {
    const ack = perCallAcks.shift() ?? config.interruptAck ?? 'interrupts';
    if (ack === 'refuses_when_told') {
      return new Promise<void>((_resolve, reject) => { heldRefusals.push(() => reject(new Error('interrupt refused'))); });
    }
    if (ack === 'throws_synchronously') throw new Error('ProcessTransport is not ready for writing');
    return (async () => {
      switch (ack) {
        case 'interrupts': turnEnders.shift()?.(); return;
        case 'after_natural_completion': releaseTurn(); return;
        case 'acknowledges_before_result': return;
        case 'refuses': throw new Error('interrupt refused');
        case 'never': await inputFinished; throw new Error('Query closed before response received');
      }
    })();
  });
  const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
    async *[Symbol.asyncIterator]() {
      // The SDK's input loop: every yielded user message goes to the provider at once.
      const inbox: SDKUserMessage[] = [];
      const turnLoop: { wake: (() => void) | null } = { wake: null };
      void (async () => {
        for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
          sdkInput.push((message.message.content as Array<{ text: string }>)[0].text);
          inbox.push(message);
          turnLoop.wake?.();
        }
      })().catch(() => {});
      // Waits until a user message or a between-turns event is available, without consuming either.
      const somethingArrived = () => new Promise<void>((resolve) => {
        if (inbox.length > 0 || sideEvents.length > 0) { resolve(); return; }
        turnLoop.wake = resolve;
        wakeSideEvents = resolve;
      });
      yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
      while (true) {
        let next: SDKUserMessage | null = null;
        while (!next) {
          const finished = await Promise.race([somethingArrived().then(() => false), inputFinished.then(() => true)]);
          if (finished) return;
          if (sideEvents.length > 0) yield sideEvents.shift() as never;
          else next = inbox.shift()!;
        }
        sdkTurnBusy = true;
        sdkReceived.push((next.message.content as Array<{ text: string }>)[0].text);
        await echoGate;
        // The SDK acknowledges each user message it accepts by echoing it.
        yield { type: 'user', uuid: next.uuid, session_id: 'sdk-session', parent_tool_use_id: null,
          message: next.message };
        if (config.foregroundTask && sdkReceived.length === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: config.foregroundTask, session_id: 'sdk-session' };
        }
        if (config.detachedTask && sdkReceived.length === 1) {
          yield { type: 'system', subtype: 'task_started', task_id: config.detachedTask, session_id: 'sdk-session',
            task_type: 'local_bash', description: 'background' };
        }
        const end = await Promise.race([new Promise<TurnEnd>((resolve) => {
          turnEnders.push(() => resolve('interrupted'));
          endTurn = (how) => { turnEnders.length = 0; resolve(how); };
        }), inputFinished.then(() => null)]);
        // The provider process went away mid-turn.
        if (end === null) return;
        sdkTurnBusy = false;
        yield resultFor(end, next.uuid!);
      }
    },
    interrupt,
    ...(config.foregroundTask || config.detachedTask ? { stopTask } : {}),
    close() { finishInput(); },
  })) as unknown as CreateQuery;
  let endTurn: (how: TurnEnd) => void = () => {};
  const releaseTurn = () => endTurn('completed');
  let turnInterrupt: (() => Promise<void>) | null = null;

  const interrupts = createClaudeAgentSdkInterruptObservations();
  const prompts: Array<{ message: string; mode: EnhancedMode; userMessageLocalIds: string[] }> = [
    { message: 'first', mode, userMessageLocalIds: ['first'] },
    ...(config.laterPrompts ?? []).map((text) => ({ message: text, mode, userMessageLocalIds: [text] })),
  ];
  const consumerAbort = new AbortController();
  const runner = claudeRemoteAgentSdk({
    sessionId: null, transcriptPath: null, path: '/tmp', claudeArgs: [], claudeExecutablePath: '/tmp/claude',
    canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
    nextMessage: async () => {
      if (prompts.length > 0 && prompts[0].message !== 'first') await promptGate;
      const prompt = prompts.shift();
      if (prompt) return prompt;
      const batch = await consumer.waitForNextInput({ abortSignal: consumerAbort.signal });
      return batch ? {
        message: batch.message,
        mode: batch.mode,
        userMessageLocalIds: batch.userMessageLocalIds ?? null,
        providerAcceptancePending: batch.providerAcceptancePending,
        ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
      } : null;
    },
    onPromptAcceptedByProvider: (acceptance) => {
      const ids = acceptance.userMessageLocalIds ?? [];
      if (ids.length === 1) { void outcomeFor(ids[0]); settleOutcome.get(ids[0])?.({ kind: 'accepted' }); }
    },
    onPendingInterruptAndSendEvidence: interrupts.recordEvidence,
    onPromptTransportFailure: (failure) => {
      transportFailures.push(failure);
      const ids = failure.userMessageLocalIds ?? [];
      if (ids.length === 1) {
        void outcomeFor(ids[0]);
        settleOutcome.get(ids[0])?.({ kind: failure.kind === 'rejected_before_effect' ? 'rejected_before_effect' : 'pending' });
      }
    },
    onReady: async () => {
      readyCount += 1;
      readyPending = true;
      await readyGate;
      readyPending = false;
    },
    setTurnInterrupt: (handler) => { turnInterrupt = handler; },
    onCompletionEvent: (event) => { completionEvents.push(event); },
    onThinkingChange: (value: boolean) => { thinking = value; },
    onSessionFound: () => {}, onMessage: () => {}, createQuery,
    ...(streamedTranscriptWriter ? { streamedTranscriptWriter: streamedTranscriptWriter as never } : {}),
  });
  void runner.catch(() => {});

  return {
    runner,
    sdkInput,
    sdkReceived,
    completionEvents,
    transportFailures,
    get readyCount() { return readyCount; },
    get sdkTurnBusy() { return sdkTurnBusy; },
    get thinking() { return thinking; },
    flushes,
    interrupt,
    releaseTurn: () => releaseTurn(),
    endTurn: (how: TurnEnd) => endTurn(how),
    endTurnInterrupted: () => { turnEnders.shift()?.(); },
    refuseHeldInterrupt: () => { heldRefusals.shift()?.(); },
    stopTask,
    rejectHeldStopTask: () => { heldStopTasks.shift()?.reject(); },
    resolveHeldStopTask: () => { heldStopTasks.shift()?.resolve(); },
    /** A provider event delivered while the SDK waits for input. */
    emitBetweenTurns: (event: unknown) => { sideEvents.push(event); wakeSideEvents?.(); },
    feedLaterPrompt: () => feedPrompt(),
    /** The SDK's next user-message echo waits until the returned function is called. */
    holdNextEcho: () => {
      let release!: () => void;
      echoGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { echoGate = Promise.resolve(); release(); };
    },
    /** The launcher's ordinary turn interrupt (UI Abort). */
    interruptTurn: async () => { await turnInterrupt!(); },
    /** Later readiness waits until the returned function is called. */
    holdReady: () => {
      let release!: () => void;
      readyGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { readyGate = Promise.resolve(); release(); };
    },
    /** The provider stream ends mid-turn, with no result. */
    endProvider: () => finishInput(),
    control: (isTurnActive: () => boolean) => createClaudeAgentSdkPendingInputInterruptAndRunControl({
      session: {
        sessionId: 's1',
        requestPendingInputSendNow: async (localId): Promise<PendingInputSteerNowAdmission> => {
          await requestPendingQueueV2Action({ token: 't', sessionId: 's1', localId, requestedAction: { v: 1, kind: 'send_now' } });
          return { kind: 'admitted' };
        },
        waitForProviderInputTerminalOutcome: async (localId) => await outcomeFor(localId),
      },
      inputConsumer: consumer as never,
      isRunnerLive: () => true,
      isTurnActive,
      interrupts,
    }),
    async close() {
      patch.mockRestore();
      consumerAbort.abort();
      readyGate = Promise.resolve();
      echoGate = Promise.resolve();
      releaseTurn();
      finishInput();
      await runner.catch(() => {});
    },
  };
}

describe('agent-sdk interrupt-and-run through the real runner pump', () => {
  it('reports interrupted only after the runner interrupted the active turn for that row', async () => {
    const h = harness();
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await expect(h.control(() => true)({ sessionId: 's1', localId: 'p1' }))
        .resolves.toEqual({ ok: true, status: 'interrupted', sessionId: 's1', localId: 'p1' });
      expect(h.interrupt).toHaveBeenCalledOnce();
    } finally {
      await h.close();
    }
  });

  it('when the turn ends between the check and the PATCH, the row runs at the boundary and is not called interrupted', async () => {
    const h = harness();
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      // The control's turn check still sees the turn; it ends before the server materializes the row.
      const result = h.control(() => {
        h.releaseTurn();
        return true;
      })({ sessionId: 's1', localId: 'p1' });
      await expect(result)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      expect(h.interrupt).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('an interrupt_and_send row reaching the runner after its turn ended is not called interrupted', async () => {
    const h = harness({ serverBusyView: 'stale_busy_after_turn_end' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await expect(h.control(() => true)({ sessionId: 's1', localId: 'p1' }))
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      // There was no active turn left to stop, so the runner does not interrupt anything.
      expect(h.interrupt).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('A whose interrupt ACK never arrives runs when its turn ends normally, and a later B still runs', async () => {
    const h = harness({ interruptAck: 'never', rows: ['p1', 'p2'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.interrupt).toHaveBeenCalledTimes(1); });
      // A's control response is still outstanding; the target turn completes on its own.
      h.releaseTurn();
      await expect(a)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.interrupt).toHaveBeenCalledTimes(2); });
      h.releaseTurn();
      await expect(b)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p2' });
      expect(h.sdkReceived).toEqual(['first', 'replacement', 'text-p2']);
      expect(h.transportFailures).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('a turn that completes normally while its interrupt is in flight is not called interrupted', async () => {
    const h = harness({ interruptAck: 'after_natural_completion' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await expect(h.control(() => true)({ sessionId: 's1', localId: 'p1' }))
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      expect(h.interrupt).toHaveBeenCalledOnce();
      expect(h.sdkReceived).toEqual(['first', 'replacement']);
    } finally {
      await h.close();
    }
  });

  it('a provider exiting mid-turn after A went to SDK input leaves A uncertain, never rejected before effect', async () => {
    const h = harness({ interruptAck: 'never' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      void h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      expect(h.interrupt).toHaveBeenCalledOnce();
      h.endProvider();
      await h.runner.catch(() => {});
    } finally {
      await h.close();
    }
    expect(h.sdkReceived).toEqual(['first']);
    expect(h.transportFailures).toHaveLength(1);
    expect(h.transportFailures[0]).toMatchObject({ kind: 'effect_may_have_occurred', userMessageLocalIds: ['p1'] });
  });

  it('an interrupted result arriving after the replacement was streamed still proves that exact turn was interrupted', async () => {
    const h = harness({ interruptAck: 'acknowledges_before_result' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const result = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.interrupt).toHaveBeenCalledOnce(); });
      // The replacement is already SDK input; the old turn is still running.
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      expect(h.sdkReceived).toEqual(['first']);
      h.endTurnInterrupted();
      await expect(result).resolves.toEqual({ ok: true, status: 'interrupted', sessionId: 's1', localId: 'p1' });
      expect(h.sdkReceived).toEqual(['first', 'replacement']);
    } finally {
      await h.close();
    }
  });

  it('A whose ACK and target-turn result are both withheld does not hold B back from SDK input; a duplicate A is accepted too', async () => {
    const h = harness({ interruptAck: 'never', rows: ['p1', 'p2', 'p3'], texts: { p3: 'replacement' } });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      // A's control response never arrives and the old turn has no result yet; B still goes in.
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2']); });
      expect(h.interrupt).toHaveBeenCalledTimes(2);
      expect(h.sdkReceived).toEqual(['first']);
      // A retried as a new row: the duplicate is input as well.
      const aAgain = h.control(() => true)({ sessionId: 's1', localId: 'p3' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2', 'replacement']); });
      expect(h.interrupt).toHaveBeenCalledTimes(3);
      // The old turn finally ends on its own; every queued message then runs in order.
      for (let turns = 1; turns <= 4; turns += 1) {
        await vi.waitFor(() => { expect(h.sdkReceived).toHaveLength(turns); });
        h.releaseTurn();
      }
      const boundary = (localId: string) => ({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId });
      await expect(a).resolves.toEqual(boundary('p1'));
      await expect(b).resolves.toEqual(boundary('p2'));
      await expect(aAgain).resolves.toEqual(boundary('p3'));
      expect(h.sdkReceived).toEqual(['first', 'replacement', 'text-p2', 'replacement']);
      expect(h.transportFailures).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('a model error ending the target turn while its interrupt is pending is reported as a failure, not an interruption', async () => {
    const h = harness({ interruptAck: 'acknowledges_before_result' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const result = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      h.endTurn('model_error');
      // The replacement is already input, so it runs next; the old turn's failure is still reported.
      await expect(result)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      expect(h.completionEvents).toContainEqual(expect.stringContaining('Model backend returned internal server error'));
      expect(h.sdkReceived).toEqual(['first', 'replacement']);
    } finally {
      await h.close();
    }
  });

  it('a model error ending a turn the ordinary interrupt was stopping still fails the runner', async () => {
    const h = harness({ interruptAck: 'acknowledges_before_result' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await h.interruptTurn();
      h.endTurn('model_error');
      await expect(h.runner).rejects.toThrow(/Model backend returned internal server error/);
    } finally {
      await h.close();
    }
  });

  it('an interrupt that throws before writing anything rejects its row before effect', async () => {
    const h = harness({ interruptAck: 'throws_synchronously' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await expect(h.control(() => true)({ sessionId: 's1', localId: 'p1' })).resolves.toMatchObject({
        ok: false, status: 'interrupt_failed', sessionId: 's1', localId: 'p1',
      });
      expect(h.sdkInput).toEqual(['first']);
      expect(h.transportFailures).toEqual([expect.objectContaining({ kind: 'rejected_before_effect', userMessageLocalIds: ['p1'] })]);
    } finally {
      await h.close();
    }
  });

  it('after a refused interrupt the old turn\'s execution error is reported as a failure', async () => {
    const h = harness({ interruptAck: 'refuses' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const result = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      // Let the refusal settle while the turn runs on.
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.endTurn('unclassified_execution_error');
      await expect(result)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      expect(h.completionEvents).toContainEqual(expect.stringContaining('Interrupted by user'));
    } finally {
      await h.close();
    }
  });

  it('A\'s late refusal does not erase B\'s accepted interrupt of the same turn', async () => {
    const h = harness({ interruptAcks: ['refuses_when_told', 'acknowledges_before_result'], rows: ['p1', 'p2'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2']); });
      // A's interrupt is refused while the turn still runs; B's was accepted and stops it.
      h.refuseHeldInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.endTurnInterrupted();
      await expect(a)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkReceived).toEqual(['first', 'replacement']); });
      h.releaseTurn();
      await expect(b).resolves.toEqual({ ok: true, status: 'interrupted', sessionId: 's1', localId: 'p2' });
      expect(h.completionEvents).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('a refusal arriving after its turn ended does not withdraw a later row\'s interrupt', async () => {
    const h = harness({ interruptAcks: ['refuses_when_told', 'acknowledges_before_result'], rows: ['p1', 'p2'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      // The first turn completes with A's interrupt still unanswered; A runs next.
      h.releaseTurn();
      await expect(a)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2']); });
      // A's refusal finally arrives; it concerns the finished first turn, not B's request against A's turn.
      h.refuseHeldInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.endTurnInterrupted();
      await expect(b).resolves.toEqual({ ok: true, status: 'interrupted', sessionId: 's1', localId: 'p2' });
      expect(h.completionEvents).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('an ordinary interrupt the provider refuses leaves a later execution error a failure', async () => {
    const h = harness({ interruptAck: 'refuses' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await h.interruptTurn();
      h.endTurn('unclassified_execution_error');
      await expect(h.runner).rejects.toThrow(/Interrupted by user/);
    } finally {
      await h.close();
    }
  });

  it('after a row\'s only interrupt is refused, an abort result is a failure the runner did not request', async () => {
    const h = harness({ interruptAck: 'refuses' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const result = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.endTurn('interrupted');
      await expect(result)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      expect(h.completionEvents).toContainEqual(expect.stringContaining('Interrupted by user'));
    } finally {
      await h.close();
    }
  });

  it('after the ordinary interrupt is refused, an abort result fails the runner as one it did not request', async () => {
    const h = harness({ interruptAck: 'refuses' });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await h.interruptTurn();
      h.endTurn('interrupted');
      await expect(h.runner).rejects.toThrow(/Interrupted by user/);
    } finally {
      await h.close();
    }
  });

  it('A refused after its target turn\'s aborted result but before A is accepted is not reported as interrupting it', async () => {
    const h = harness({ interruptAcks: ['refuses_when_told', 'acknowledges_before_result'], rows: ['p1', 'p2'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2']); });
      // B's interrupt stops the old turn; A's acceptance is held while A's refusal arrives.
      const releaseEcho = h.holdNextEcho();
      h.endTurnInterrupted();
      await vi.waitFor(() => { expect(h.sdkReceived).toEqual(['first', 'replacement']); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.refuseHeldInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseEcho();
      await expect(a)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      h.releaseTurn();
      await expect(b).resolves.toEqual({ ok: true, status: 'interrupted', sessionId: 's1', localId: 'p2' });
    } finally {
      await h.close();
    }
  });

  it('an old stopTask refusal arriving after a new turn began sends no interrupt to the new turn', async () => {
    const h = harness({ foregroundTask: 'task-old', laterPrompts: ['second'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const interrupting = h.interruptTurn();
      await vi.waitFor(() => { expect(h.stopTask).toHaveBeenCalledWith('task-old'); });
      // The old turn completes on its own and the next prompt starts.
      h.releaseTurn();
      await vi.waitFor(() => { expect(h.sdkReceived).toEqual(['first', 'second']); });
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      await vi.waitFor(() => { expect(h.thinking).toBe(true); });
      h.rejectHeldStopTask();
      await interrupting;
      expect(h.interrupt).not.toHaveBeenCalled();
      expect(h.sdkTurnBusy).toBe(true);
      // The old interrupt's cleanup leaves the new turn's state alone.
      expect(h.thinking).toBe(true);
    } finally {
      await h.close();
    }
  });

  // HP5-PUMP-10: cancelling a background task left by an ended turn is not a request to interrupt the
  // next foreground turn, so that turn's own abort result stays a failure.
  for (const stop of ['succeeds', 'refuses', 'not_requested'] as const) {
    it(`a background-task stop (${stop}) does not excuse a later turn's unrequested abort`, async () => {
      const h = harness({ detachedTask: 'detached-old', laterPrompts: ['A'], holdLaterPrompts: true });
      const settled = h.runner.then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        h.releaseTurn();
        await vi.waitFor(() => { expect(h.readyCount).toBe(1); });
        let interrupting: Promise<void> = Promise.resolve();
        if (stop !== 'not_requested') {
          interrupting = h.interruptTurn();
          await vi.waitFor(() => { expect(h.stopTask).toHaveBeenCalledWith('detached-old'); });
        }
        h.feedLaterPrompt();
        await vi.waitFor(() => { expect(h.sdkReceived).toEqual(['first', 'A']); });
        await vi.waitFor(() => { expect(h.thinking).toBe(true); });
        if (stop === 'succeeds') h.resolveHeldStopTask();
        if (stop === 'refuses') h.rejectHeldStopTask();
        await interrupting;
        expect(h.interrupt).not.toHaveBeenCalled();
        h.endTurn('interrupted');
        // A suppressed failure would instead reach readiness and wait for the next prompt.
        const outcome = await Promise.race([
          settled,
          vi.waitFor(() => { expect(h.readyCount).toBe(2); }, { timeout: 5_000 }).then(() => 'ready without failure'),
        ]);
        expect(outcome).toMatch(/^rejected: .*Interrupted by user/);
      } finally {
        await h.close();
      }
    });
  }

  // HP5-PUMP-11: a refused stop of a background task that has meanwhile ended sends no fallback
  // interrupt; one that is still running keeps its fallback.
  for (const after of ['ended', 'ended_and_replaced', 'still_running'] as const) {
    it(`a refused background-task stop whose task ${after} ${after === 'still_running' ? 'falls back' : 'sends no fallback interrupt'}`, async () => {
      const h = harness({ detachedTask: 'detached-old', laterPrompts: ['A'], holdLaterPrompts: true, observeFlushes: true });
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        h.releaseTurn();
        await vi.waitFor(() => { expect(h.readyCount).toBe(1); });
        const flushesBefore = h.flushes.length;
        const interrupting = h.interruptTurn();
        await vi.waitFor(() => { expect(h.stopTask).toHaveBeenCalledWith('detached-old'); });
        const delivered = h.readyCount;
        if (after !== 'still_running') {
          h.emitBetweenTurns({ type: 'system', subtype: 'task_notification', session_id: 'sdk-session',
            task_id: 'detached-old', status: 'completed', output_file: 'unused', summary: 'completed' });
        }
        if (after === 'ended_and_replaced') {
          h.emitBetweenTurns({ type: 'system', subtype: 'task_started', session_id: 'sdk-session',
            task_id: 'detached-new', task_type: 'local_bash', description: 'background' });
        }
        // Both events reach the runner before the refusal (no new foreground turn starts).
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(false); });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(h.readyCount).toBe(delivered);
        h.rejectHeldStopTask();
        await interrupting;
        const abortFlushes = h.flushes.slice(flushesBefore).filter((reason) => reason === 'abort');
        if (after === 'still_running') {
          expect(h.interrupt).toHaveBeenCalledOnce();
          expect(abortFlushes).toEqual(['abort']);
        } else {
          expect(h.interrupt).not.toHaveBeenCalled();
          expect(abortFlushes).toEqual([]);
        }
      } finally {
        await h.close();
      }
    });
  }

  // HP7-PUMP-12: a foreground stop that outlives its turn's own successful end has nothing left to
  // stop. Its late refusal sends no fallback and no abort cleanup, as its late success sends neither.
  for (const after of ['refused', 'refused_with_new_background_task', 'succeeded'] as const) {
    it(`a foreground-task stop ${after.replace(/_/g, ' ')} after its turn ended cleanly leaves no abort cleanup`, async () => {
      const h = harness({ foregroundTask: 'task-old', observeFlushes: true });
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        const flushesBefore = h.flushes.length;
        const interrupting = h.interruptTurn();
        await vi.waitFor(() => { expect(h.stopTask).toHaveBeenCalledWith('task-old'); });
        // The turn finishes on its own; no new foreground turn starts.
        h.releaseTurn();
        await vi.waitFor(() => { expect(h.readyCount).toBe(1); });
        h.emitBetweenTurns({ type: 'system', subtype: 'task_notification', session_id: 'sdk-session',
          task_id: 'task-old', status: 'completed', output_file: 'unused', summary: 'completed' });
        if (after === 'refused_with_new_background_task') {
          h.emitBetweenTurns({ type: 'system', subtype: 'task_started', session_id: 'sdk-session',
            task_id: 'detached-new', task_type: 'local_bash', description: 'background' });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (after === 'succeeded') h.resolveHeldStopTask();
        else h.rejectHeldStopTask();
        await interrupting;
        expect(h.interrupt).not.toHaveBeenCalled();
        expect(h.flushes.slice(flushesBefore).filter((reason) => reason === 'abort')).toEqual([]);
      } finally {
        await h.close();
      }
    });
  }

  it('a stopTask refusal while its turn still runs falls back to interrupting that turn', async () => {
    const h = harness({ foregroundTask: 'task-old', observeFlushes: true });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const interrupting = h.interruptTurn();
      await vi.waitFor(() => { expect(h.stopTask).toHaveBeenCalledWith('task-old'); });
      h.rejectHeldStopTask();
      await interrupting;
      expect(h.interrupt).toHaveBeenCalledOnce();
      expect(h.flushes.filter((reason) => reason === 'abort')).toEqual(['abort']);
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(false); });
    } finally {
      await h.close();
    }
  });

  for (const end of ['unclassified_execution_error', 'unknown_terminal_reason'] as const) {
    it(`an ordinary interrupt followed by an execution error with ${end} still fails the runner`, async () => {
      const h = harness({ interruptAck: 'acknowledges_before_result' });
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        await h.interruptTurn();
        h.endTurn(end);
        await expect(h.runner).rejects.toThrow(/Interrupted by user|future reason/);
      } finally {
        await h.close();
      }
    });
  }

  for (const end of ['interrupted', 'interrupted_in_tools'] as const) {
    it(`an ordinary interrupt ending the turn with abort reason (${end}) is a clean stop`, async () => {
      const h = harness({ interruptAck: 'acknowledges_before_result', rows: ['p1'] });
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        await h.interruptTurn();
        h.endTurn(end);
        await vi.waitFor(() => { expect(h.readyCount).toBe(1); });
        expect(h.completionEvents).toEqual([]);
      } finally {
        await h.close();
      }
    });
  }

  for (const end of ['unclassified_execution_error', 'unknown_terminal_reason'] as const) {
    it(`an execution error with ${end} is reported as a failure and not called an interruption`, async () => {
      const h = harness({ interruptAck: 'acknowledges_before_result' });
      try {
        await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
        const result = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
        await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
        h.endTurn(end);
        await expect(result)
          .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
        expect(h.sdkReceived).toEqual(['first', 'replacement']);
        expect(h.completionEvents).toContainEqual(expect.stringMatching(/Interrupted by user|future reason/));
      } finally {
        await h.close();
      }
    });
  }

  it('a result whose readiness is still pending cannot settle rows that arrived meanwhile', async () => {
    const h = harness({ serverBusyView: 'busy_until_ready', rows: ['p1', 'p2'] });
    try {
      await vi.waitFor(() => { expect(h.sdkTurnBusy).toBe(true); });
      const releaseReady = h.holdReady();
      // The ordinary turn interrupt ends the first turn; its readiness is held.
      await h.interruptTurn();
      await vi.waitFor(() => { expect(h.readyCount).toBe(1); });
      // A has no running turn to interrupt; B targets A's turn, which has not even started.
      const a = h.control(() => true)({ sessionId: 's1', localId: 'p1' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement']); });
      const b = h.control(() => true)({ sessionId: 's1', localId: 'p2' });
      await vi.waitFor(() => { expect(h.sdkInput).toEqual(['first', 'replacement', 'text-p2']); });
      expect(h.interrupt).toHaveBeenCalledTimes(2);
      releaseReady();
      await expect(a)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p1' });
      // A's own turn completes normally, so B interrupted nothing.
      await vi.waitFor(() => { expect(h.sdkReceived).toEqual(['first', 'replacement']); });
      h.releaseTurn();
      await expect(b)
        .resolves.toEqual({ ok: true, status: 'admitted_and_queued_until_boundary', sessionId: 's1', localId: 'p2' });
    } finally {
      await h.close();
    }
  });
});
