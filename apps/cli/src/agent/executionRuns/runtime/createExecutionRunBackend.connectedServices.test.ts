import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendFactoryOptions } from '@/agent/executionRuns/registry/executionRunBackendTypes';

const getExecutionRunBackendDescriptorMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

function createStubBackend(): AgentBackend {
  return {
    async startSession() {
      return { sessionId: 'run-session-1' as SessionId };
    },
    async sendPrompt() {},
    async cancel() {},
    onMessage() {},
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

describe('createExecutionRunBackend connected-services env merge', () => {
  it('merges the connected-services env into the isolation bundle before per-backend resolveIsolation', async () => {
    const captured: { options?: ExecutionRunBackendFactoryOptions } = {};
    const resolveIsolation = vi.fn((_request, baseBundle) => baseBundle);
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: (opts: ExecutionRunBackendFactoryOptions) => {
        captured.options = opts;
        return createStubBackend();
      },
      resolveIsolation,
    });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_codex_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
    });

    // resolveIsolation must see the CS env already merged into the base bundle (generic, pre-descriptor).
    const baseBundlePassedToResolve = resolveIsolation.mock.calls[0]?.[1] as { env: Record<string, string> };
    expect(baseBundlePassedToResolve.env.CODEX_HOME).toBe('/materialized/run/codex/codex-home');

    // The backend factory receives the merged CS env in its isolation bundle.
    expect(captured.options?.isolation?.env?.CODEX_HOME).toBe('/materialized/run/codex/codex-home');
  });

  it('forces an isolation bundle carrying the connected-services env even without a runId', async () => {
    const captured: { options?: ExecutionRunBackendFactoryOptions } = {};
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: (opts: ExecutionRunBackendFactoryOptions) => {
        captured.options = opts;
        return createStubBackend();
      },
    });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
    });

    expect(captured.options?.isolation?.env?.CODEX_HOME).toBe('/materialized/run/codex/codex-home');
  });

  it('runs the connected-services cleanup on dispose (run end) regardless of retention policy', async () => {
    const dispose = vi.fn(async () => {});
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: () => ({ ...createStubBackend(), dispose }),
    });
    const connectedServicesCleanup = vi.fn(async () => {});

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_codex_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      start: { retentionPolicy: 'resumable' },
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
      connectedServicesCleanup,
    });

    await backend.dispose();
    await backend.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans selected connected-service materialization exactly once when backend construction throws', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: () => {
        throw new Error('backend construction failed');
      },
    });
    const connectedServicesCleanup = vi.fn(async () => {});

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    expect(() => createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_codex_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      start: { retentionPolicy: 'resumable' },
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
      connectedServicesCleanup,
    })).toThrow('backend construction failed');

    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans selected connected-service materialization when the backend descriptor is unavailable', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const connectedServicesCleanup = vi.fn(async () => {});

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    expect(() => createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_missing_1',
      backendId: 'missing-backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      start: { retentionPolicy: 'resumable' },
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
      connectedServicesCleanup,
    })).toThrow('Unsupported execution-run backend: missing-backend');

    await vi.waitFor(() => expect(connectedServicesCleanup).toHaveBeenCalledTimes(1));
  });

  it('preserves a resolveIsolation construction error while cleaning selected connected services exactly once', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: () => createStubBackend(),
      resolveIsolation: vi.fn(() => {
        throw new Error('resolve isolation failed');
      }),
    });
    const connectedServicesCleanup = vi.fn(async () => {});

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    expect(() => createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_isolation_failure_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      start: { retentionPolicy: 'ephemeral' },
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex/codex-home' },
      connectedServicesCleanup,
    })).toThrow('resolve isolation failed');

    await vi.waitFor(() => {
      expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
    });
  });
});
