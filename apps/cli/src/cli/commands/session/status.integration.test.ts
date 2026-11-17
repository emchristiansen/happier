import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session status (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let idleAgentStateCiphertext = '';
  let sessionPendingCount = 0;
  let sessionPendingBlockedCount = 0;
  // Model/effort metadata for the runtimeConfig readback; each test may replace it before running.
  let runtimeMetadata: Record<string, unknown> = {};
  const defaultRuntimeMetadata = (): Record<string, unknown> => ({
    modelOverrideV1: { v: 1, updatedAt: 40, modelId: 'claude-opus-5-5' },
    sessionConfigOptionOverridesV1: {
      v: 1, updatedAt: 50, overrides: { reasoning_effort: { value: 'medium', updatedAt: 50 } },
    },
    sessionModelsV1: claudeModelsState({ updatedAt: 60, effort: 'high' }),
  });
  function claudeModelsState(params: Readonly<{ updatedAt: number; effort: string }>): Record<string, unknown> {
    return {
      v: 1, provider: 'claude', updatedAt: params.updatedAt, currentModelId: 'claude-opus-5-5',
      availableModels: [{
        id: 'claude-opus-5-5', name: 'Opus 5.5',
        modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: params.effort }],
      }],
    };
  }

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-status-');
    sessionPendingCount = 0;
    sessionPendingBlockedCount = 0;
    runtimeMetadata = defaultRuntimeMetadata();

    const sessionId = 'sess_integration_status_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const buildMetadataCiphertext = () => encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-integration',
          flavor: 'claude',
          tag: 'MyTag',
          host: 'host1',
          sessionUsageLimitRecoveryV1: {
            v: 1, status: 'waiting', issueFingerprint: 'status-integration-issue', armedAtMs: 123,
            runtimeAuthRecoveryAttemptId: 'status-integration-attempt', resetAtMs: null,
            nextCheckAtMs: 456, attemptCount: 1, maxAttempts: 3, lastProbeError: null,
            selectedAuth: { kind: 'native' },
          },
          ...runtimeMetadata,
        },
        dek,
      ),
      'base64',
    );
    const agentStateCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          controlledByUser: false,
          requests: { r1: { type: 'tool', createdAt: 1 } },
        },
        dek,
      ),
      'base64',
    );
    idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          controlledByUser: false,
          requests: {},
        },
        dek,
      ),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 0,
              metadata: buildMetadataCiphertext(),
              metadataVersion: 0,
              agentState: agentStateCiphertext,
              agentStateVersion: 0,
              pendingCount: sessionPendingCount,
              pendingBlockedCount: sessionPendingBlockedCount,
              pendingVersion: 0,
              dataEncryptionKey: dataEncryptionKeyBase64,
              share: null,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session control integration test server address');
    }

    const fixtureServerUrl = `http://127.0.0.1:${address.port}`;
    envScope.patch({
      HAPPIER_SERVER_URL: fixtureServerUrl,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
    });

    const configurationModule = await import('@/configuration');
    configurationModule.reloadConfiguration();
    expect(configurationModule.configuration.apiServerUrl).toBe(fixtureServerUrl);

    const socket = createApiSessionSocketStub({
      onConnect(currentSocket) {
        setTimeout(() => {
          currentSocket.trigger('update', {
            id: 'u1',
            seq: 2,
            createdAt: Date.now(),
            body: {
              t: 'update-session',
              id: 'sess_integration_status_123',
              agentState: { value: idleAgentStateCiphertext, version: 1 },
            },
          });
        }, 10);
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('returns a session_status JSON envelope with agentState summary', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.v).toBe(1);
      expect(parsed.error).toBeUndefined();
      expect(parsed).toMatchObject({ ok: true, kind: 'session_status' });
      expect(parsed.kind).toBe('session_status');
      expect(parsed.data?.session?.id).toBe('sess_integration_status_123');
      expect(parsed.data?.agentState?.pendingRequestsCount).toBe(1);
      expect(parsed.data?.agentState?.controlledByUser).toBe(false);
      expect(parsed.data?.usageLimitRecovery).toEqual({
        state: 'present', metadataVersion: 0,
        recovery: { status: 'waiting', issueFingerprint: 'status-integration-issue', armedAtMs: 123,
          runtimeAuthRecoveryAttemptId: 'status-integration-attempt' },
      });
      // Desired selections and the runner-reported current model stay separate facts.
      expect(parsed.data?.runtimeConfig).toEqual({
        state: 'present', metadataVersion: 0,
        desired: {
          model: { modelId: 'claude-opus-5-5', updatedAt: 40 },
          reasoningEffort: { state: 'present', value: 'medium', updatedAt: 50 },
        },
        reported: { state: 'present', provider: 'claude', currentModelId: 'claude-opus-5-5', reasoningEffort: 'high', updatedAt: 60 },
      });
    } finally {
      output.restore();
    }
  });

  it('surfaces blocked pending count in session_status JSON', async () => {
    sessionPendingCount = 1;
    sessionPendingBlockedCount = 1;
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_status');
      expect(parsed.data?.session?.pendingCount).toBe(1);
      expect(parsed.data?.session?.pendingBlockedCount).toBe(1);
    } finally {
      output.restore();
    }
  });

  it('supports --live and prefers the latest agentState from socket updates', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--live', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_status');
      expect(parsed.data?.agentState?.pendingRequestsCount).toBe(0);
    } finally {
      output.restore();
    }
  });
  async function readRuntimeConfig(): Promise<any> {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });
      const parsed = output.json();
      expect(parsed).toMatchObject({ ok: true, kind: 'session_status' });
      // The rest of the status survives whatever the model metadata contains.
      expect(parsed.data?.session?.id).toBe('sess_integration_status_123');
      return parsed.data?.runtimeConfig;
    } finally {
      output.restore();
    }
  }

  it.each([
    ['model options not an array', { modelOptions: {} }],
    ['model option missing its name', { modelOptions: [{ id: 'reasoning_effort', type: 'select', currentValue: 'high' }] }],
  ])('reports invalid model state without failing status (%s)', async (_label, modelPatch) => {
    const state = claudeModelsState({ updatedAt: 60, effort: 'high' }) as any;
    state.availableModels = [{ ...state.availableModels[0], ...modelPatch }];
    runtimeMetadata = { ...defaultRuntimeMetadata(), sessionModelsV1: state };

    const runtimeConfig = await readRuntimeConfig();
    expect(runtimeConfig.reported).toEqual({ state: 'invalid' });
    expect(runtimeConfig.desired.reasoningEffort).toEqual({ state: 'present', value: 'medium', updatedAt: 50 });
  });

  it('does not certify an unsupported model-state version as reported state', async () => {
    runtimeMetadata = { ...defaultRuntimeMetadata(), sessionModelsV1: { ...claudeModelsState({ updatedAt: 60, effort: 'high' }), v: 99 } };
    expect((await readRuntimeConfig()).reported).toEqual({ state: 'invalid' });
  });

  it('reports absent model state when the runner published none', async () => {
    const { sessionModelsV1: _omitted, ...rest } = defaultRuntimeMetadata();
    runtimeMetadata = rest;
    expect((await readRuntimeConfig()).reported).toEqual({ state: 'absent' });
  });

  it.each([
    ['legacy only', { acpSessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'medium' }) }, 'medium', 20],
    ['newer legacy wins', { sessionModelsV1: claudeModelsState({ updatedAt: 10, effort: 'high' }), acpSessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'medium' }) }, 'medium', 20],
    ['newer canonical wins', { sessionModelsV1: claudeModelsState({ updatedAt: 30, effort: 'high' }), acpSessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'medium' }) }, 'high', 30],
    ['canonical wins a tie', { sessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'high' }), acpSessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'medium' }) }, 'high', 20],
    ['malformed canonical falls back to valid legacy', { sessionModelsV1: { ...claudeModelsState({ updatedAt: 90, effort: 'high' }), availableModels: {} }, acpSessionModelsV1: claudeModelsState({ updatedAt: 20, effort: 'medium' }) }, 'medium', 20],
  ])('selects the newest valid reported model state across aliases (%s)', async (_label, models, effort, updatedAt) => {
    const { sessionModelsV1: _omitted, ...rest } = defaultRuntimeMetadata();
    runtimeMetadata = { ...rest, ...models };
    expect((await readRuntimeConfig()).reported).toEqual({
      state: 'present', provider: 'claude', currentModelId: 'claude-opus-5-5', reasoningEffort: effort, updatedAt,
    });
  });

  it('projects only model and reasoning effort, not unrelated config values', async () => {
    runtimeMetadata = {
      ...defaultRuntimeMetadata(),
      sessionConfigOptionOverridesV1: {
        v: 1, updatedAt: 70,
        overrides: {
          reasoning_effort: { value: 'medium', updatedAt: 50 },
          freeform_setting: { value: 'SYNTHETIC-UNRELATED-CONTENT', updatedAt: 70 },
        },
      },
    };
    const runtimeConfig = await readRuntimeConfig();
    expect(runtimeConfig.desired).toEqual({
      model: { modelId: 'claude-opus-5-5', updatedAt: 40 },
      reasoningEffort: { state: 'present', value: 'medium', updatedAt: 50 },
    });
    expect(JSON.stringify(runtimeConfig)).not.toContain('SYNTHETIC-UNRELATED-CONTENT');
  });

  it('marks a desired reasoning effort that is not an effort level as invalid without showing it', async () => {
    runtimeMetadata = {
      ...defaultRuntimeMetadata(),
      sessionConfigOptionOverridesV1: {
        v: 1, updatedAt: 50, overrides: { reasoning_effort: { value: 'synthetic opaque value!', updatedAt: 50 } },
      },
    };
    const runtimeConfig = await readRuntimeConfig();
    expect(runtimeConfig.desired.reasoningEffort).toEqual({ state: 'invalid', updatedAt: 50 });
    expect(JSON.stringify(runtimeConfig)).not.toContain('synthetic opaque value!');
  });
});
