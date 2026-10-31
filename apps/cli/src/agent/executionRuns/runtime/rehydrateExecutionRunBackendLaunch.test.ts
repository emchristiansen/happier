import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { ExecutionRunConnectedServicesUnavailableError, prepareExecutionRunConnectedServices } from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
import { resolveExecutionRunResumeBackendOptions } from '@/agent/executionRuns/runtime/rehydrateExecutionRunBackendLaunch';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { createExecutionRunConnectedServicesBridge } from '@/daemon/connectedServices/runsBridge/materializeConnectedServicesForRun';
import { ExecutionRunConnectedServiceMaterializeRequestSchema } from '@/daemon/connectedServices/runsBridge/contract';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';

const CONNECTED_SELECTION: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

function baseRun(launch: ExecutionRunState['launch']): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sc_1',
    sessionId: 'sess_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1,
    ...(launch ? { launch } : {}),
  };
}

describe('resolveExecutionRunResumeBackendOptions', () => {
  it('imports a legacy run home through real resume preparation before releasing the new durable home', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'happier-resume-run-home-'));
    try {
      const previousRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir: join(sandbox, 'materialized'), agentId: 'codex', materializationKey: 'execution_run:old',
      });
      const rollout = join('sessions', 'rollout-2026-10-11T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
      const history = '{"type":"session_meta","payload":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}\n';
      await mkdir(join(previousRoot, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(join(previousRoot, 'codex-home', rollout), history);
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'team', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'access-team', refreshToken: 'refresh-team', idToken: 'id-team',
          scope: null, tokenType: null, providerAccountId: 'acct-team', providerEmail: null },
      });
      const bridge = createExecutionRunConnectedServicesBridge({
        runtimeRegistry: null,
        resolveAuthForSpawn: async (params) => {
          const materialized = await materializeConnectedServicesForSpawn({
            agentId: 'codex', materializationKey: params.materializationKey,
            activeServerDir: join(sandbox, 'server'), baseDir: join(sandbox, 'materialized'),
            previousMaterializedRoot: params.previousMaterializedRoot,
            recordsByServiceId: new Map([['openai-codex', record]]),
            selectionsByServiceId: new Map([['openai-codex', { kind: 'profile', serviceId: 'openai-codex', profileId: 'team', record }]]),
            processEnv: { HOME: sandbox, CODEX_HOME: join(sandbox, 'native') },
          });
          return materialized ? { ...materialized,
            cleanupOnFailure: materialized.cleanupOnFailure ?? null,
            cleanupOnExit: materialized.cleanupOnExit ?? null,
            connectedServicesBindings: CONNECTED_SELECTION, runtimeAccountIdentitySelections: [] } : null;
        },
      });
      const options = await resolveExecutionRunResumeBackendOptions({
        run: baseRun({ connectedServicesSelection: CONNECTED_SELECTION, connectedServicesRegistration: {
          v: 1, agentId: 'codex', materializationKey: 'execution_run:old', connectedServicesBindings: CONNECTED_SELECTION,
          brokerSelectionIdentity: null, runtimeAccountIdentitySelections: [], sessionDirectory: sandbox,
          materializedRoot: previousRoot,
        } }),
        prepareConnectedServices: (params) => prepareExecutionRunConnectedServices({
          ...params, credentials: null, cwd: sandbox,
          materializeViaDaemon: async (request) => bridge.materialize({
            ...ExecutionRunConnectedServiceMaterializeRequestSchema.parse(request), agentId: 'codex',
          }),
          releaseViaDaemon: async (request) => (await bridge.release(request)).released,
        }),
      });
      const resumedHome = options.connectedServicesEnv?.CODEX_HOME;
      expect(resumedHome).toBeTruthy();
      await expect(readFile(join(resumedHome!, rollout), 'utf8')).resolves.toBe(history);
      await options.connectedServicesCleanup?.();
      await expect(readFile(join(resumedHome!, rollout), 'utf8')).resolves.toBe(history);
      await expect(readFile(join(previousRoot, 'codex-home', rollout), 'utf8')).resolves.toBe(history);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('re-resolves account settings + re-materializes the SAME persisted CS selection and threads model/effort', async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepareConnectedServices = vi.fn(
      async (_params: { backendTarget: unknown; connectedServices: unknown; sessionId: string }) => ({
        env: { CODEX_HOME: '/run/root/codex-home' },
        materializationKey: 'execution_run:x',
        cleanup,
        selection: CONNECTED_SELECTION,
        registration: {
          v: 1 as const,
          agentId: 'codex',
          materializationKey: 'execution_run:x',
          connectedServicesBindings: CONNECTED_SELECTION,
          brokerSelectionIdentity: null,
          runtimeAccountIdentitySelections: [],
          sessionDirectory: '/tmp/workspace',
          materializedRoot: '/run/root',
        },
      }),
    );
    const overrides = { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } };

    const options = await resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides, connectedServicesSelection: CONNECTED_SELECTION }),
      resolveAccountSettings: async () => ({ codexBackendMode: 'appServer' }),
      prepareConnectedServices,
    });

    expect(prepareConnectedServices).toHaveBeenCalledTimes(1);
    // The persisted selection is re-materialized verbatim (same account/profile).
    expect(prepareConnectedServices.mock.calls[0]?.[0]).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: CONNECTED_SELECTION,
      sessionId: 'sess_1',
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.sessionConfigOptionOverrides).toEqual(overrides);
    expect(options.accountSettings).toEqual({ codexBackendMode: 'appServer' });
    expect(options.connectedServicesEnv).toEqual({ CODEX_HOME: '/run/root/codex-home' });
    expect(options.connectedServicesCleanup).toBe(cleanup);
  });

  it('fails closed when a connected selection was persisted but no CS rehydrator is available', async () => {
    await expect(
      resolveExecutionRunResumeBackendOptions({
        run: baseRun({ connectedServicesSelection: CONNECTED_SELECTION }),
        resolveAccountSettings: async () => null,
        // prepareConnectedServices intentionally omitted.
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
  });

  it('fails closed when re-materialization returns nothing for a persisted connected selection', async () => {
    await expect(
      resolveExecutionRunResumeBackendOptions({
        run: baseRun({ connectedServicesSelection: CONNECTED_SELECTION }),
        resolveAccountSettings: async () => null,
        prepareConnectedServices: async () => null,
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
  });

  it('does not materialize CS when the launch record had no connected selection', async () => {
    const prepareConnectedServices = vi.fn(async () => null);
    const options = await resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5' }),
      resolveAccountSettings: async () => null,
      prepareConnectedServices,
    });
    expect(prepareConnectedServices).not.toHaveBeenCalled();
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.connectedServicesEnv).toBeUndefined();
  });
});
