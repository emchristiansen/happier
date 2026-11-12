import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { RpcHandler } from '@/api/rpc/types';
import { requestPendingQueueV2Action } from '@/api/session/pendingQueueV2Transport';
import type { PendingInputSteerNowAdmission } from '@/api/session/sessionClientPort';
import { registerSessionControlHandlers, type SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

import {
  createClaudeAgentSdkInterruptObservations,
  createClaudeAgentSdkPendingInputInterruptAndRunControl,
} from './createClaudeAgentSdkPendingInputInterruptAndRunControl';

type Outcome = import('@/api/session/sessionClientPort').ProviderInputTerminalOutcome;

/** `session.pendingInput.interruptAndRun` from the action executor, through the session RPC handler,
 *  to whatever runtime control the session registered (none: the agent-sdk runner before this fix). */
function executorFor(controls: Partial<SessionRuntimeControls>) {
  const handlers = new Map<string, RpcHandler>();
  registerSessionControlHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } },
    { sessionRuntimeControls: controls });
  const handler = handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN);
  if (!handler) throw new Error('Pending interrupt-and-run RPC was not registered');
  return createActionExecutor({
    sessionPendingInputInterruptAndRun: async (args: Readonly<{ sessionId: string; localId: string }>) => await handler({ sessionId: args.sessionId, localId: args.localId }),
  } as unknown as ActionExecutorDeps);
}

function control(overrides: Partial<Parameters<typeof createClaudeAgentSdkPendingInputInterruptAndRunControl>[0]> = {}) {
  return createClaudeAgentSdkPendingInputInterruptAndRunControl({
    session: {
      sessionId: 's1',
      requestPendingInputSendNow: async () => ({ kind: 'admitted' }),
      waitForProviderInputTerminalOutcome: async () => ({ kind: 'accepted' }),
    },
    inputConsumer: { drainPending: async () => ({ materialized: 1, stoppedReason: 'max_pop_per_wake' }) },
    isRunnerLive: () => true,
    isTurnActive: () => true,
    interrupts: createClaudeAgentSdkInterruptObservations(),
    ...overrides,
  });
}

describe('Claude agent-sdk session.pendingInput.interruptAndRun', () => {
  it('without the runtime control the action fails honestly instead of reporting ok', async () => {
    await expect(executorFor({}).execute('session.pendingInput.interruptAndRun',
      { sessionId: 's1', localId: 'p1' }, { surface: 'cli' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      details: { ok: false, status: 'unsupported' },
    });
  });

  it('marks exactly the selected row send_now, drains that row, and reports the provider outcome', async () => {
    const rows = new Map<string, { requestedAction?: string; claimed: boolean }>([
      ['x', { claimed: false }],
      [' x ', { claimed: false }],
    ]);
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      const localId = decodeURIComponent(new URL(String(url)).pathname.split('/')[5]);
      const row = rows.get(localId);
      if (!row) throw new Error('Selected pending row does not exist');
      row.requestedAction = (body as { requestedAction: { kind: string } }).requestedAction.kind;
      return { data: { ok: true, didUpdate: true, requestedAction: (body as { requestedAction: unknown }).requestedAction } };
    });
    const materializeNextPendingMessageSafely = vi.fn(async (opts?: { requestedLocalId?: string }) => {
      const row = opts?.requestedLocalId === undefined ? undefined : rows.get(opts.requestedLocalId);
      if (!row || row.requestedAction !== 'send_now') throw new Error('Exact send_now row was not selected');
      row.claimed = true;
      interrupts.recordEvidence([opts!.requestedLocalId!], 'target_interrupted');
      return { type: 'materialized' as const, localId: opts!.requestedLocalId!, seq: 3, content: null };
    });
    const interrupts = createClaudeAgentSdkInterruptObservations();
    const consumer = createSessionProviderInputConsumer<{ id: string }, string>({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
      session: {
        waitForProviderInputAdmission: async (signal) => !signal.aborted,
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
    });
    const waitForProviderInputTerminalOutcome = vi.fn(async (): Promise<Outcome> => ({ kind: 'accepted' }));
    const executor = executorFor({
      interruptPendingInputAndRun: control({
        session: {
          sessionId: 's1',
          requestPendingInputSendNow: async (localId): Promise<PendingInputSteerNowAdmission> => {
            await requestPendingQueueV2Action({ token: 't', sessionId: 's1', localId, requestedAction: { v: 1, kind: 'send_now' } });
            return { kind: 'admitted' };
          },
          waitForProviderInputTerminalOutcome,
        },
        inputConsumer: consumer as never,
        interrupts,
      }),
    });
    try {
      await expect(executor.execute('session.pendingInput.interruptAndRun',
        { sessionId: 's1', localId: ' x ' }, { surface: 'cli' })).resolves.toEqual({
        ok: true,
        result: { ok: true, status: 'interrupted', sessionId: 's1', localId: ' x ' },
      });
      expect(rows.get('x')).toEqual({ claimed: false });
      expect(rows.get(' x ')).toEqual({ requestedAction: 'send_now', claimed: true });
      expect(patch).toHaveBeenCalledWith(expect.stringMatching(/\/v2\/sessions\/s1\/pending\/%20x%20\/action$/),
        { requestedAction: { v: 1, kind: 'send_now' } }, expect.any(Object));
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({ requestedLocalId: ' x ' }));
      expect(waitForProviderInputTerminalOutcome).toHaveBeenCalledWith(' x ', 10_000, expect.any(AbortSignal));
    } finally {
      patch.mockRestore();
    }
  });

  it('a row interrupted its turn only when the turn was interrupted and its own interrupt was not refused, in either order', () => {
    const interrupts = createClaudeAgentSdkInterruptObservations();
    const cases: Array<[string, Array<'target_interrupted' | 'interrupt_refused'>, boolean]> = [
      ['a', ['target_interrupted'], true],
      ['b', ['interrupt_refused'], false],
      ['c', ['target_interrupted', 'interrupt_refused'], false],
      ['d', ['interrupt_refused', 'target_interrupted'], false],
      ['e', [], false],
    ];
    for (const [localId, facts, performed] of cases) {
      const watch = interrupts.watch(localId);
      for (const fact of facts) interrupts.recordEvidence([localId], fact);
      // Facts for other rows, or for a batch of rows, never count for this one.
      interrupts.recordEvidence(['other'], 'target_interrupted');
      interrupts.recordEvidence([localId, 'other'], 'target_interrupted');
      expect(watch.interruptPerformed()).toBe(performed);
      watch.stop();
    }
  });

  it('refuses before any request when the runner is gone, the session differs or no turn runs', async () => {
    const requestPendingInputSendNow = vi.fn(async (): Promise<PendingInputSteerNowAdmission> => ({ kind: 'admitted' }));
    const session = { sessionId: 's1', requestPendingInputSendNow, waitForProviderInputTerminalOutcome: async (): Promise<Outcome> => ({ kind: 'accepted' }) };
    await expect(control({ session, isRunnerLive: () => false })({ sessionId: 's1', localId: 'p' }))
      .resolves.toMatchObject({ ok: false, status: 'stale_state' });
    await expect(control({ session })({ sessionId: 'other', localId: 'p' }))
      .resolves.toMatchObject({ ok: false, status: 'stale_state' });
    await expect(control({ session, isTurnActive: () => false })({ sessionId: 's1', localId: 'p' }))
      .resolves.toMatchObject({ ok: false, status: 'not_safe', errorCode: 'no_active_turn' });
    await expect(control({ session })({ sessionId: 's1', localId: 'p', expectedStateAtMs: 42 }))
      .resolves.toMatchObject({ ok: false, status: 'not_safe', errorCode: 'expected_state_unverifiable' });
    expect(requestPendingInputSendNow).not.toHaveBeenCalled();
  });

  it.each([
    ['refused send_now', { kind: 'not_admitted', reason: 'server_rejected' }, { kind: 'pending' },
      { ok: false, status: 'interrupt_failed', errorCode: 'pending_input_send_now_unavailable' }],
    ['uncertain send_now, unobserved', { kind: 'admission_uncertain' }, { kind: 'pending' },
      { ok: false, status: 'interrupt_failed', errorCode: 'pending_input_send_now_admission_uncertain' }],
    ['admitted, unobserved', { kind: 'admitted' }, { kind: 'pending' },
      { ok: true, status: 'admitted_delivery_unobserved' }],
    ['accepted without an observed interrupt', { kind: 'admitted' }, { kind: 'accepted' },
      { ok: true, status: 'admitted_and_queued_until_boundary' }],
    ['admitted, failed interrupt', { kind: 'admitted' }, { kind: 'rejected_before_effect', reason: 'provider_unavailable_before_acceptance' },
      { ok: false, status: 'interrupt_failed', errorCode: 'provider_unavailable_before_acceptance' }],
  ] as const)('%s is reported without upgrading it', async (_name, admission, outcome, expected) => {
    const run = control({ session: {
      sessionId: 's1',
      requestPendingInputSendNow: async () => admission as PendingInputSteerNowAdmission,
      waitForProviderInputTerminalOutcome: async () => outcome as Outcome,
    } });
    await expect(run({ sessionId: 's1', localId: 'p' })).resolves.toMatchObject(expected);
  });

  it('one request per pending row at a time; a later or different row is not blocked', async () => {
    let release!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => { release = resolve; });
    const requestPendingInputSendNow = vi.fn(async (): Promise<PendingInputSteerNowAdmission> => ({ kind: 'admitted' }));
    const run = control({ session: {
      sessionId: 's1',
      requestPendingInputSendNow,
      waitForProviderInputTerminalOutcome: async (localId) => localId === 'a' ? await outcome : { kind: 'accepted' },
    } });
    const first = run({ sessionId: 's1', localId: 'a' });
    await expect(run({ sessionId: 's1', localId: 'a' })).resolves.toMatchObject({ status: 'not_safe', errorCode: 'interrupt_and_run_in_flight' });
    await expect(run({ sessionId: 's1', localId: 'b' })).resolves.toMatchObject({ ok: true, status: 'admitted_and_queued_until_boundary' });
    release({ kind: 'accepted' });
    await expect(first).resolves.toMatchObject({ ok: true, status: 'admitted_and_queued_until_boundary' });
    // Accepted duplicates: a later request for the same row is allowed again.
    await expect(run({ sessionId: 's1', localId: 'a' })).resolves.toMatchObject({ ok: true, status: 'admitted_and_queued_until_boundary' });
    expect(requestPendingInputSendNow).toHaveBeenCalledTimes(3);
  });
});
