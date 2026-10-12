import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(async () => ({
    pid: process.pid,
    httpPort: 43_210,
    controlToken: 'test-control-token',
  })),
}));

import {
  materializeDaemonConnectedServicesForExecutionRun,
  resolveExecutionRunConnectedServiceMaterializeTimeoutMs,
} from './controlClient';
import { ExecutionRunConnectedServiceMaterializeResponseSchema } from './connectedServices/runsBridge/contract';

const PROOF = {
  v: 1 as const,
  agentId: 'codex',
  materializationKey: 'execution_run:run-1',
  connectedServicesBindings: {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveExecutionRunConnectedServiceMaterializeTimeoutMs (A1)', () => {
  it('covers the daemon materialization tail backstop plus the materialization work itself', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({})).toBe(600_000);
  });

  it('honors the env override within bounds', () => {
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '30000',
    })).toBe(30_000);
    // Clamped to sane bounds; garbage falls back to the default.
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '1',
    })).toBe(1_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: '99999999',
    })).toBe(600_000);
    expect(resolveExecutionRunConnectedServiceMaterializeTimeoutMs({
      HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS: 'garbage',
    })).toBe(600_000);
  });

  it('applies the complete materialization budget to the effective request AbortSignal', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(timeoutSignal);
      return new Response(JSON.stringify({
        result: {
          env: { CODEX_HOME: '/tmp/materialized-codex-home' },
          proof: PROOF,
        },
      }), { status: 200 });
    }));

    await expect(materializeDaemonConnectedServicesForExecutionRun({
      runId: 'run-1',
      agentId: 'codex',
      pid: process.pid,
      materializationKey: PROOF.materializationKey,
      connectedServicesBindingsRaw: PROOF.connectedServicesBindings,
    })).resolves.toMatchObject({ env: { CODEX_HOME: '/tmp/materialized-codex-home' } });

    expect(timeoutSpy).toHaveBeenCalledWith(600_000);
  });
});

describe('ExecutionRunConnectedServiceMaterializeResponseSchema', () => {
  it('rejects empty and whitespace-only materialization effects while retaining provider-owned env keys', () => {
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { CODEX_HOME: '' },
      proof: PROOF,
    }).success).toBe(false);
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { CODEX_HOME: '   ' },
      proof: PROOF,
    }).success).toBe(false);
    expect(ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse({
      env: { PROVIDER_DEFINED_HOME: '', ANOTHER_PROVIDER_PATH: '/materialized/home' },
      proof: PROOF,
    }).success).toBe(true);
  });
});
