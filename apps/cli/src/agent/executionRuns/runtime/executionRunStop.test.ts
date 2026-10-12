import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type {
  ExecutionRunBackendController,
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
} from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { stopExecutionRun } from '@/agent/executionRuns/runtime/executionRunStop';
import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

function createRunningRun(): ExecutionRunState {
  return {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    sessionId: 'session-1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    backendId: 'claude',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 100,
    resumeHandle: null,
  };
}

function createTerminalSignal() {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return { terminalPromise, resolveTerminal };
}

function createBackendController(backend: AgentBackend): ExecutionRunBackendController {
  const terminal = createTerminalSignal();
  return {
    kind: 'backend',
    backend,
    backendSupportsResume: false,
    childSessionId: 'child-1' as SessionId,
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: 'stream-1',
    streamWriter: null,
    cancelled: false,
    turnCount: 0,
    turnEpoch: 0,
    turnInFlight: false,
    turnCancelReason: null,
    turnCancelEpoch: null,
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalMarkerWritePromise: Promise.resolve(),
    ...terminal,
  };
}

function createVoiceController(): ExecutionRunVoiceAgentController {
  const terminal = createTerminalSignal();
  return {
    kind: 'voice_agent',
    voiceAgentId: 'voice-1',
    cancelled: false,
    lastMarkerWriteAtMs: 0,
    terminalMarkerWritePromise: Promise.resolve(),
    transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    externalStreamIdByInternal: new Map(),
    internalStreamIdByExternal: new Map(),
    persistedDoneByExternalStreamId: new Set(),
    ...terminal,
  };
}

async function stopWithController(args: Readonly<{
  controller: ExecutionRunController;
  voiceAgentManager?: VoiceAgentManager;
}>) {
  const run = createRunningRun();
  const runs = new Map([[run.runId, run]]);
  const controllers = new Map([[run.runId, args.controller]]);
  const finishRun = vi.fn(async (_runId, next) => {
    runs.set(run.runId, { ...run, ...next });
  });

  const result = await stopExecutionRun({
    runId: run.runId,
    runs,
    controllers,
    voiceAgentManager: args.voiceAgentManager ?? ({} as VoiceAgentManager),
    getNowMs: () => 200,
    finishRun,
  });

  return { result, runs, controllers, finishRun };
}

describe('stopExecutionRun', () => {
  it('publishes and settles cancellation without waiting for backend cancellation or disposal', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const dispose = vi.fn(() => new Promise<void>(() => {}));
    const backend: AgentBackend = {
      async startSession() {
        return { sessionId: 'child-1' as SessionId };
      },
      async sendPrompt() {},
      cancel,
      onMessage() {},
      dispose,
    };
    const controller = createBackendController(backend);

    const stopped = await stopWithController({ controller });

    expect(stopped.result).toEqual({ ok: true });
    expect(stopped.runs.get('run-1')?.status).toBe('cancelled');
    expect(controller.cancelled).toBe(true);
    await expect(controller.terminalPromise).resolves.toBeUndefined();
    expect(stopped.controllers.has('run-1')).toBe(false);
    expect(cancel).toHaveBeenCalledWith('child-1');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('publishes and settles cancellation without waiting for voice-agent stop', async () => {
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const controller = createVoiceController();
    const voiceAgentManager = { stop } as unknown as VoiceAgentManager;

    const stopped = await stopWithController({ controller, voiceAgentManager });

    expect(stopped.result).toEqual({ ok: true });
    expect(stopped.runs.get('run-1')?.status).toBe('cancelled');
    expect(controller.cancelled).toBe(true);
    await expect(controller.terminalPromise).resolves.toBeUndefined();
    expect(stopped.controllers.has('run-1')).toBe(false);
    expect(stop).toHaveBeenCalledWith({ voiceAgentId: 'voice-1' });
  });
});
