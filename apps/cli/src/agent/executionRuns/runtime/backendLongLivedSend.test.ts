import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import {
  prepareBackendLongLivedRunResume,
  sendBackendLongLivedRun,
  sendPreparedBackendLongLivedRun,
} from '@/agent/executionRuns/runtime/backendLongLivedSend';

function createResumableBackendHarness(): Readonly<{
  backend: AgentBackend;
  emit: (msg: any) => void;
}> {
  let handler: ((msg: any) => void) | null = null;
  const emit = (msg: any) => handler?.(msg);

  const backend: AgentBackend = {
    async startSession(): Promise<StartSessionResult> {
      return { sessionId: 'child_session_started' as SessionId };
    },
    async loadSession(_sessionId: SessionId): Promise<StartSessionResult> {
      return { sessionId: 'child_session_loaded' as SessionId };
    },
    async loadSessionWithReplayCapture(_sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }> {
      return { sessionId: 'child_session_loaded' as SessionId, replay: [] };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      // Default no-op; tests can emit messages via `emit(...)`.
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(nextHandler): void {
      handler = nextHandler as any;
    },
    async dispose(): Promise<void> {},
  };

  return { backend, emit };
}

function createLongLivedResumableRun(overrides?: Partial<ExecutionRunState>): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    sessionId: 'parent_session_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    backendId: 'claude',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1_700_000_000_000,
    resumeHandle: {
      kind: 'vendor_session.v1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      vendorSessionId: 'vendor_session_1',
    },
    ...(overrides ?? {}),
  };
}

function createActiveLongLivedController(backend: AgentBackend): ExecutionRunBackendController {
  return {
    kind: 'backend',
    backend,
    backendSupportsResume: true,
    childSessionId: 'child_session_active' as SessionId,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: null,
    cancelled: false,
    turnCount: 1,
    turnEpoch: 1,
    turnInFlight: true,
    turnCancelReason: null,
    turnCancelEpoch: null,
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalPromise: new Promise<void>(() => {}),
    resolveTerminal: () => undefined,
  };
}

describe('sendBackendLongLivedRun (resume)', () => {
  it('forwards tool-call events after resuming a long-lived run (no fresh-vs-resume divergence)', async () => {
    const sendAcp = vi.fn();
    const { backend, emit } = createResumableBackendHarness();
    backend.sendPrompt = async (_sessionId, _prompt) => {
      emit({ type: 'tool-call', toolName: 'bash', callId: 'call_123', args: { command: 'ls' } });
    };

    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => backend,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: () => undefined,
      sendAcp: sendAcp as any,
      parentProvider: 'claude' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    });

    expect(res).toEqual({ ok: true });
    expect(sendAcp.mock.calls.some((call) => (call[1] as any)?.type === 'tool-call')).toBe(true);
  });

  it('does not allow bypassing maxTurns by resuming (turnCount must be cumulative)', async () => {
    const { backend } = createResumableBackendHarness();

    const run = createLongLivedResumableRun({ turnCount: 2 });
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => backend,
      maxTurns: 2,
      getNowMs: () => 123,
      finishRun: () => undefined,
      sendAcp: (() => undefined) as any,
      parentProvider: 'claude' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_not_allowed');
    expect(res.error).toBe('Turn limit exceeded');
  });

  it('refuses to dispatch through a prepared controller after a successor replaces it', async () => {
    const first = createResumableBackendHarness();
    const successor = createResumableBackendHarness();
    const firstSend = vi.fn(async () => {});
    const successorSend = vi.fn(async () => {});
    first.backend.sendPrompt = firstSend;
    successor.backend.sendPrompt = successorSend;
    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();
    const args = {
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => first.backend,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: () => undefined,
      sendAcp: (() => undefined) as any,
      parentProvider: 'claude' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    };

    const prepared = await prepareBackendLongLivedRunResume(args);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('expected prepared controller');
    controllers.set(run.runId, { ...prepared.controller, backend: successor.backend });

    await expect(sendPreparedBackendLongLivedRun(args, prepared.controller)).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
    });
    expect(firstSend).not.toHaveBeenCalled();
    expect(successorSend).not.toHaveBeenCalled();
  });

  it.each([
    ['AbortError', Object.assign(new Error('prompt outcome is ambiguous'), { name: 'AbortError' })],
    ['generic provider error', new Error('provider disconnected after prompt admission')],
  ])('sends an interrupt replacement only once and keeps custody after %s until completion', async (_label, sendError) => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const { backend } = createResumableBackendHarness();
    const sendPrompt = vi.fn(async () => {
      throw sendError;
    });
    backend.sendPrompt = sendPrompt;
    backend.sendSteerPrompt = vi.fn(async () => undefined);
    backend.waitForResponseComplete = async () => await completion;
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller = createActiveLongLivedController(backend);
    const controllers = new Map([[run.runId, controller]]);
    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => backend,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: (() => undefined) as any,
      parentProvider: 'claude' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    } as const;

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'replacement', delivery: 'interrupt' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
    });
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(controller.turnInFlight).toBe(true);
    expect(controller.turnCancelReason).toBe('outcome_unknown');

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must not overlap', delivery: 'steer_if_supported' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(backend.sendSteerPrompt).not.toHaveBeenCalled();

    resolveCompletion();
    await vi.waitFor(() => {
      expect(controller.turnInFlight).toBe(false);
      expect(controller.turnCancelReason).toBeNull();
    });
  });

  it('keeps the active turn busy when a steer throw cannot prove whether the input was accepted', async () => {
    const { backend } = createResumableBackendHarness();
    const sendPrompt = vi.fn(async () => undefined);
    const sendSteerPrompt = vi.fn(async () => {
      throw new Error('provider disconnected after steer admission');
    });
    backend.sendPrompt = sendPrompt;
    backend.sendSteerPrompt = sendSteerPrompt;
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller = createActiveLongLivedController(backend);
    const controllers = new Map([[run.runId, controller]]);
    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => backend,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: (() => undefined) as any,
      parentProvider: 'claude' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    } as const;

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'steer once', delivery: 'steer_if_supported' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
    });
    expect(sendSteerPrompt).toHaveBeenCalledOnce();
    expect(controller.turnInFlight).toBe(true);
    expect(controller.turnCancelReason).toBe('outcome_unknown');

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must not overlap', delivery: 'steer_if_supported' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(sendSteerPrompt).toHaveBeenCalledOnce();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
