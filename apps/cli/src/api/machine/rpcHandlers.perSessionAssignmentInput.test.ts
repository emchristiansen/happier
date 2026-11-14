import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

/**
 * Spec A.1 / T15 at the machine SPAWN_HAPPY_SESSION RPC: a new spawn rejects caller-supplied
 * assignment state; a resume drops it (the spawn path restores the session's own record).
 */
vi.mock('ps-list', () => ({ default: vi.fn(async () => []) }));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials: vi.fn(async () => null),
  readDaemonState: async () => null,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://example.invalid',
    apiServerUrl: 'http://example.invalid',
    activeServerId: 'cloud',
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    daemonStateFile: '/tmp/happier-test-home/daemon.state.json',
    daemonReattachCatchUpConcurrency: 0,
    isDaemonProcess: false,
    replaySeedMaxChars: 50_000,
    replaySeedCandidateLimit: 500,
  },
}));

import { registerMachineRpcHandlers } from './rpcHandlers';

const FORGED_VALUES: Record<string, unknown> = {
  member: { assignment: 'per_session', profileId: 'B', decisionId: 'forged-decision', reason: 'initial_sampled', appliedAtMs: 1 },
  materializedAssignment: { profileId: 'B', decisionId: 'forged-decision', reason: 'initial_sampled', materializedAtMs: 1 },
  pendingAssignment: { profileId: 'B' },
  decisionId: 'forged-decision',
};

const group = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', ...extra } },
});

function registerSpawnHandler() {
  const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ type: 'success', sessionId: 'sess_existing' } as const));
  const registered = new Map<string, (params: any) => Promise<any>>();
  registerMachineRpcHandlers({
    rpcHandlerManager: {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any,
    handlers: {
      spawnSession: spawnSession as any,
      stopSession: async () => true,
      requestShutdown: () => {},
    },
  });
  const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
  expect(handler).toBeDefined();
  return { handler: handler!, spawnSession };
}

const request = (overrides: Record<string, unknown>) => ({
  type: 'spawn-in-directory',
  directory: '/repo',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  approvedNewDirectoryCreation: true,
  ...overrides,
});

describe('SPAWN_HAPPY_SESSION per-session assignment input provenance (spec A.1)', () => {
  for (const field of CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS) {
    it(`new spawn rejects caller ${field}`, async () => {
      const { handler, spawnSession } = registerSpawnHandler();
      const result = await handler(request({ connectedServices: group({ [field]: FORGED_VALUES[field] }) }));
      expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
      expect(String(result.errorMessage)).toContain('connected_service_internal_assignment_field_forbidden');
      expect(spawnSession).not.toHaveBeenCalled();
    });

    it(`resume drops caller ${field} and keeps the named-start request`, async () => {
      const { handler, spawnSession } = registerSpawnHandler();
      await handler(request({
        type: 'resume-session',
        sessionId: 'sess_existing',
        connectedServices: group({ initialProfileId: 'A', [field]: FORGED_VALUES[field] }),
      }));
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(spawnSession.mock.calls[0]![0]).toMatchObject({ existingSessionId: 'sess_existing' });
      expect(spawnSession.mock.calls[0]![0].connectedServices).toEqual(group({ initialProfileId: 'A' }));
    });
  }

  it('positive control: a new spawn with an explicit named start reaches spawn unchanged', async () => {
    const { handler, spawnSession } = registerSpawnHandler();
    await handler(request({ connectedServices: group({ initialProfileId: 'A' }) }));
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession.mock.calls[0]![0].connectedServices).toEqual(group({ initialProfileId: 'A' }));
  });
});
