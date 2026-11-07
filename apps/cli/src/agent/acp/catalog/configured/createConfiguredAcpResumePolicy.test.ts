import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAcpBackend: vi.fn(() => ({ kind: 'backend' })),
  createAcpRuntime: vi.fn((options) => options),
  runStandardAcpProvider: vi.fn(async (..._args: readonly unknown[]) => undefined),
  resolveConfiguredAcpBackendFromAccountSettings: vi.fn(),
  materializeConfiguredAcpEnvironment: vi.fn(() => ({})),
}));

vi.mock('@/agent/acp/createAcpBackend', () => ({ createAcpBackend: mocks.createAcpBackend }));
vi.mock('@/agent/acp/runtime/createAcpRuntime', () => ({ createAcpRuntime: mocks.createAcpRuntime }));
vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({ runStandardAcpProvider: mocks.runStandardAcpProvider }));
vi.mock('./resolveConfiguredAcpBackendFromAccountSettings', () => ({
  resolveConfiguredAcpBackendFromAccountSettings: mocks.resolveConfiguredAcpBackendFromAccountSettings,
}));
vi.mock('./materializeConfiguredAcpEnvironment', () => ({
  materializeConfiguredAcpEnvironment: mocks.materializeConfiguredAcpEnvironment,
}));
vi.mock('../ui/CatalogDefinedAcpTerminalDisplay', () => ({
  CatalogDefinedAcpTerminalDisplay: () => null,
}));

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';
import { createConfiguredAcpRuntime } from './createConfiguredAcpRuntime';
import { runConfiguredAcpBackend } from './runConfiguredAcpBackend';
import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';

function backend(supportsLoadSession: boolean): ResolvedConfiguredAcpBackend {
  return {
    backendId: 'review-bot', name: 'review-bot', title: 'Review Bot', command: 'review-bot', args: [], env: {},
    transportProfile: 'generic',
    capabilities: {
      supportsLoadSession,
      supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown',
    },
  };
}

describe('configured ACP resume policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the catalog load declaration to the ACP protocol owner', () => {
    createConfiguredAcpBackend({ cwd: '/tmp', backend: backend(true), launchEnv: {} });
    expect(mocks.createAcpBackend).toHaveBeenCalledWith(expect.objectContaining({ declaredSessionLoadSupport: true }));
  });

  it('publishes the provider session id only after catalog policy and runtime negotiation both allow load', async () => {
    let metadata: Record<string, unknown> = { existing: true };
    const session = {
      sessionId: 'happy-1',
      updateMetadata: (updater: (value: Record<string, unknown>) => Record<string, unknown>) => {
        metadata = updater(metadata);
      },
    };
    const common = {
      loggerLabel: 'test', directory: '/tmp', session: session as never, messageBuffer: {} as never, mcpServers: {}, permissionHandler: {} as never, launchEnv: {},
      onThinkingChange: () => {}, providerInputConsumer: {} as never,
    };

    const negotiatedBackend = {
      kind: 'backend',
      getNegotiatedSessionLoadSupport: vi.fn(() => false),
    };
    mocks.createAcpBackend.mockReturnValueOnce(negotiatedBackend);

    createConfiguredAcpRuntime({ ...common, backend: backend(true) });
    const runtimeOptions = mocks.createAcpRuntime.mock.calls.at(-1)?.[0];
    const loadIdentity = runtimeOptions.sessionIdentity;
    expect(loadIdentity.kind).toBe('persist-bound');

    // Static catalog policy alone is not runtime proof, including before the backend exists.
    await loadIdentity.persistBound({ vendorSessionId: 'provider-1', generation: 0, operation: 'create' });
    expect(metadata).toEqual({ existing: true });

    await runtimeOptions.ensureBackend();
    await loadIdentity.persistBound({ vendorSessionId: 'provider-1', generation: 0, operation: 'create' });
    expect(metadata).toEqual({ existing: true });

    negotiatedBackend.getNegotiatedSessionLoadSupport.mockReturnValue(true);
    await loadIdentity.persistBound({ vendorSessionId: 'provider-1', generation: 0, operation: 'create' });
    expect(metadata).toEqual({ existing: true, customAcpSessionId: 'provider-1' });

    createConfiguredAcpRuntime({ ...common, backend: backend(false) });
    expect(mocks.createAcpRuntime.mock.calls.at(-1)?.[0].sessionIdentity).toEqual({
      kind: 'runtime-only', reason: 'vendor-resume-unsupported',
    });
  });

  /**
   * A configured backend that promises `session/load` must never have a failed explicit resume
   * silently replaced by a fresh vendor session; one that never promises it keeps the fallback.
   */
  it.each([true, false])(
    'derives the shared runner resume policy from the configured load declaration (%s)',
    async (supportsLoadSession) => {
      mocks.resolveConfiguredAcpBackendFromAccountSettings.mockReturnValue(backend(supportsLoadSession));

      await runConfiguredAcpBackend({
        credentials: { token: 'token' } as never,
        configuredAcpBackendId: 'review-bot',
        accountSettingsContext: { settings: {} } as never,
      });

      expect(mocks.runStandardAcpProvider.mock.calls.at(-1)?.[1]).toMatchObject({
        declaredSessionLoadSupport: supportsLoadSession,
      });
    },
  );
});
