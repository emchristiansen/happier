import { describe, expect, it, vi } from 'vitest';

import { createCodexSharedLocalControl } from './createCodexSharedLocalControl';
import type { CodexSharedTuiSupervisor } from './createCodexSharedTuiSupervisor';

function createSessionHarness() {
  let agentState: Record<string, unknown> = {};
  let switchHandler: ((params: unknown) => Promise<boolean>) | null = null;
  const session = {
    sendSessionEvent: vi.fn(),
    updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
      agentState = updater(agentState);
    }),
    keepAlive: vi.fn(),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: unknown) => Promise<boolean>) => {
        if (name === 'switch') switchHandler = handler;
      }),
    },
  };
  return {
    session,
    readAgentState: () => agentState,
    switchTo: async (to: 'local' | 'remote') => await switchHandler!({ to }),
  };
}

describe('createCodexSharedLocalControl', () => {
  it('keeps Happier writable while the native Codex TUI is attached to the same thread', async () => {
    const harness = createSessionHarness();
    let attached = false;
    const supervisor: CodexSharedTuiSupervisor = {
      isAttached: () => attached,
      attach: vi.fn(async () => { attached = true; return true; }),
      detach: vi.fn(async () => { attached = false; }),
      dispose: vi.fn(async () => { attached = false; }),
    };
    const control = createCodexSharedLocalControl({
      startingMode: 'local',
      getSession: () => harness.session as never,
      getSessionId: () => 'thread-381',
      directory: '/workspace',
      endpoint: 'unix:///tmp/happier-codex/app-server.sock',
      supervisor,
    });

    await control.onAfterStart();

    expect(supervisor.attach).toHaveBeenCalledWith({
      endpoint: 'unix:///tmp/happier-codex/app-server.sock',
      directory: '/workspace',
      sessionId: 'thread-381',
    });
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
        canDetach: true,
      },
    });

    await expect(harness.switchTo('remote')).resolves.toBe(true);
    expect(harness.readAgentState()).toMatchObject({
      localControl: { attached: false, topology: 'shared', remoteWritable: true, canAttach: true },
    });
  });
});
