import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

const { loggerInfoMock, loggerWarnMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
  },
}));

import {
  ExecutionRunConnectedServicesUnavailableError,
  prepareExecutionRunConnectedServices,
} from './prepareExecutionRunConnectedServices';

const CREDENTIALS = { token: 'cred-1' } as unknown as Credentials;

const TEAM_DEFAULT_BINDINGS = {
  v: 1 as const,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
    'openai': { source: 'native' as const },
  },
};

function materialized(input: unknown, env: Record<string, string> = { CODEX_HOME: '/run/root/codex/codex-home' }) {
  const request = input as { materializationKey: string; connectedServicesBindingsRaw: typeof TEAM_DEFAULT_BINDINGS };
  return {
    env,
    proof: {
      v: 1 as const,
      agentId: 'codex',
      materializationKey: request.materializationKey,
      connectedServicesBindings: request.connectedServicesBindingsRaw,
    },
    registration: {
      v: 1 as const,
      agentId: 'codex',
      materializationKey: request.materializationKey,
      connectedServicesBindings: request.connectedServicesBindingsRaw,
      brokerSelectionIdentity: null,
      runtimeAccountIdentitySelections: [],
      sessionDirectory: '/tmp/workspace',
      materializedRoot: '/run/root/codex',
    },
  };
}

describe('prepareExecutionRunConnectedServices', () => {
  it('adds the exact non-secret child selection envelope to durable run registration', async () => {
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      ignoredSecret: 'must-not-persist',
    }]);
    const expectedPersistedSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    const materialize = vi.fn(async (input: unknown) => {
      const base = materialized(input, {
        CODEX_HOME: '/run/root/codex/codex-home',
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedServiceSelectionsJson,
      });
      return {
        ...base,
        registration: {
          ...base.proof,
          brokerSelectionIdentity: null,
          runtimeAccountIdentitySelections: [],
          sessionDirectory: '/tmp/workspace',
          materializedRoot: '/run/root/codex',
        },
      };
    });

    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: TEAM_DEFAULT_BINDINGS,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async () => true),
    });

    expect(prepared?.registration?.connectedServiceSelectionsJson).toBe(expectedPersistedSelectionsJson);
    expect(JSON.stringify(prepared?.registration)).not.toContain('CODEX_HOME');
    expect(JSON.stringify(prepared?.registration)).not.toContain('must-not-persist');
  });

  it('QA2-F02: an account default resolves through the SESSION spawn-default owner (not a runner settings snapshot) and materializes', async () => {
    const materialize = vi.fn(async (input: unknown) => materialized(input));
    const release = vi.fn(async (_input: unknown) => true);
    // The session owner (blocking settings bootstrap) resolves the default — prepare must consume IT,
    // not any in-process settings snapshot (the live G5 failure: stale snapshot => silent native run).
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => ({
      connectedServices: TEAM_DEFAULT_BINDINGS,
      connectedServicesUpdatedAt: Date.now(),
    }));

    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: release,
      resolveSessionSpawnDefaults,
    });

    expect(resolveSessionSpawnDefaults).toHaveBeenCalledTimes(1);
    expect(resolveSessionSpawnDefaults.mock.calls.at(0)?.[0]).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
    });
    expect(prepared).not.toBeNull();
    expect(prepared?.env).toEqual({ CODEX_HOME: '/run/root/codex/codex-home' });

    const materializeInput = materialize.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(materializeInput).toMatchObject({
      agentId: 'codex',
      pid: process.pid,
      sessionDirectory: '/tmp/workspace',
      sessionId: 'session-1',
      connectedServicesBindingsRaw: TEAM_DEFAULT_BINDINGS,
    });
    expect(String(materializeInput.materializationKey)).toMatch(/^execution_run:/u);

    await prepared?.cleanup();
    expect(release).toHaveBeenCalledTimes(1);

    // Cleanup is idempotent.
    await prepared?.cleanup();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight cleanup promise so concurrent owners await the same release', async () => {
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(async () => {
      await releaseGate;
      return true;
    });
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: TEAM_DEFAULT_BINDINGS,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input)),
      releaseViaDaemon: release,
    });

    const first = prepared!.cleanup();
    let secondSettled = false;
    const second = prepared!.cleanup().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);

    finishRelease();
    await Promise.all([first, second]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('an explicit per-target selection overrides the session default entirely', async () => {
    const materialize = vi.fn(async (input: unknown) => materialized(input));
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => ({
      connectedServices: TEAM_DEFAULT_BINDINGS,
      connectedServicesUpdatedAt: Date.now(),
    }));

    const explicit = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    };
    await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: explicit,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });

    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    expect(materialize.mock.calls.at(0)?.[0]).toMatchObject({
      connectedServicesBindingsRaw: explicit,
    });
  });

  it('QA2-F03: logs one info line when no selection resolves and proceeds native (no bridge call)', async () => {
    loggerInfoMock.mockClear();
    const materialize = vi.fn(async (input: unknown) => materialized(input, {}));
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => null),
    });
    expect(prepared).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    const nativeLog = loggerInfoMock.mock.calls.find(([message]) => String(message).includes('proceeding native'));
    expect(nativeLog).toBeDefined();
  });

  it('QA2-F03: logs one info line on successful materialization (env key NAMES only, never values)', async () => {
    loggerInfoMock.mockClear();
    await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input)),
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    });
    const materializedLog = loggerInfoMock.mock.calls.find(([message]) => String(message).includes('materialized'));
    expect(materializedLog).toBeDefined();
    expect(JSON.stringify(materializedLog)).toContain('CODEX_HOME');
    expect(JSON.stringify(materializedLog)).not.toContain('/run/root/codex/codex-home');
  });

  it('returns null for non-builtInAgent targets without touching the default owner', async () => {
    const materialize = vi.fn(async (input: unknown) => materialized(input, {}));
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => null);
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });
    expect(prepared).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
  });

  it('proceeds native (logged) when credentials are unavailable for default resolution', async () => {
    loggerInfoMock.mockClear();
    const resolveSessionSpawnDefaults = vi.fn(async (_input: unknown) => null);
    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: null,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input, {})),
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults,
    });
    expect(prepared).toBeNull();
    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    expect(loggerInfoMock.mock.calls.some(([message]) => String(message).includes('proceeding native'))).toBe(true);
  });

  it('fails CLOSED with a typed error (and a warn log) when a selection exists but the bridge fails', async () => {
    loggerWarnMock.mockClear();
    const materialize = vi.fn(async (_input: unknown) => {
      throw new Error('daemon unreachable');
    });
    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async (_input: unknown) => true),
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(loggerWarnMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('A1: releases best-effort on the FAILURE path so a daemon-side success after client timeout is reclaimed', async () => {
    // The client can abandon the call (transport timeout) while the daemon still completes the
    // materialization + registration. The failure path must fire the idempotent release (keyed by the
    // materialization key prepare already knows) so that late daemon-side success is always reclaimed.
    const release = vi.fn(async (_input: unknown) => true);
    const materialize = vi.fn(async (_input: unknown) => {
      throw new Error('Request failed: materialize, The operation was aborted due to timeout');
    });

    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: release,
      resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
        connectedServices: TEAM_DEFAULT_BINDINGS,
        connectedServicesUpdatedAt: Date.now(),
      })),
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);

    expect(release).toHaveBeenCalledTimes(1);
    const releaseInput = release.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(String(releaseInput.materializationKey)).toMatch(/^execution_run:/u);
    expect(releaseInput.pid).toBe(process.pid);
    // The materialize call and the reclaim release use the SAME run key.
    const materializeInput = materialize.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(releaseInput.materializationKey).toBe(materializeInput.materializationKey);
  });

  it('fails closed and releases exactly once when selected auth returns an empty materialization', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input, {})),
        releaseViaDaemon: release,
        resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
          connectedServices: TEAM_DEFAULT_BINDINGS,
          connectedServicesUpdatedAt: Date.now(),
        })),
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when selected auth returns only an empty env value', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input, { CODEX_HOME: '' })),
        releaseViaDaemon: release,
        resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
          connectedServices: TEAM_DEFAULT_BINDINGS,
          connectedServicesUpdatedAt: Date.now(),
        })),
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when selected auth returns only a whitespace env value', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (input: unknown) => materialized(input, { CODEX_HOME: '   ' })),
        releaseViaDaemon: release,
        resolveSessionSpawnDefaults: vi.fn(async (_input: unknown) => ({
          connectedServices: TEAM_DEFAULT_BINDINGS,
          connectedServicesUpdatedAt: Date.now(),
        })),
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when the bridge returns malformed materialization proof', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: TEAM_DEFAULT_BINDINGS,
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (_input: unknown) => ({
          env: { CODEX_HOME: '/run/root/codex/codex-home' },
          proof: {
            v: 1 as const,
            agentId: 'codex',
            materializationKey: '',
            connectedServicesBindings: TEAM_DEFAULT_BINDINGS,
          },
        })),
        releaseViaDaemon: release,
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when proof names a different selected profile', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: TEAM_DEFAULT_BINDINGS,
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (input: { materializationKey: string }) => ({
          env: { CODEX_HOME: '/run/root/codex/codex-home' },
          proof: {
            v: 1 as const,
            agentId: 'codex',
            materializationKey: input.materializationKey,
            connectedServicesBindings: {
              v: 1 as const,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected' as const,
                  selection: 'profile' as const,
                  profileId: 'another-profile',
                },
              },
            },
          },
        })),
        releaseViaDaemon: release,
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when proof names a different selected group', async () => {
    const release = vi.fn(async (_input: unknown) => true);
    const selectedGroup = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'primary' },
      },
    };
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: selectedGroup,
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: vi.fn(async (input: { materializationKey: string }) => ({
          env: { CODEX_HOME: '/run/root/codex/codex-home' },
          proof: {
            v: 1 as const,
            agentId: 'codex',
            materializationKey: input.materializationKey,
            connectedServicesBindings: {
              v: 1 as const,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected' as const,
                  selection: 'group' as const,
                  groupId: 'another-group',
                  profileId: 'member-a',
                },
              },
            },
          },
        })),
        releaseViaDaemon: release,
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases exactly once when exact daemon registration is missing', async () => {
    const selectedGroup = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'primary' },
      },
    };
    const release = vi.fn(async () => true);
    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: selectedGroup,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: { materializationKey: string }) => ({
        env: { CODEX_HOME: '/run/root/codex/codex-home' },
        proof: {
          v: 1 as const,
          agentId: 'codex',
          materializationKey: input.materializationKey,
          connectedServicesBindings: {
            v: 1 as const,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
                groupId: 'primary',
                profileId: 'member-a',
              },
            },
          },
        },
      })),
      releaseViaDaemon: release,
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed with joined cleanup when daemon registration does not match the reservation', async () => {
    const release = vi.fn(async () => true);
    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: TEAM_DEFAULT_BINDINGS,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: unknown) => {
        const base = materialized(input);
        return {
          ...base,
          registration: {
            ...base.registration,
            materializationKey: 'execution_run:different-reservation',
          },
        };
      }),
      releaseViaDaemon: release,
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed with joined cleanup when registration and materialization proof name different group members', async () => {
    const release = vi.fn(async () => true);
    const selectedGroup = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'primary' },
      },
    };
    await expect(prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: selectedGroup,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: vi.fn(async (input: { materializationKey: string }) => ({
        env: { CODEX_HOME: '/run/root/codex/codex-home' },
        proof: {
          v: 1 as const,
          agentId: 'codex',
          materializationKey: input.materializationKey,
          connectedServicesBindings: {
            v: 1 as const,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
                groupId: 'primary',
                profileId: 'member-a',
              },
            },
          },
        },
        registration: {
          v: 1 as const,
          agentId: 'codex',
          materializationKey: input.materializationKey,
          connectedServicesBindings: {
            v: 1 as const,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected' as const,
                selection: 'group' as const,
                groupId: 'primary',
                profileId: 'member-b',
              },
            },
          },
          brokerSelectionIdentity: null,
          runtimeAccountIdentitySelections: [],
          sessionDirectory: '/tmp/workspace',
          materializedRoot: '/run/root/codex',
        },
      })),
      releaseViaDaemon: release,
    })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('RO-F5: resolves a mixed bare-default + explicit selection, merging the resolved default UNDER explicit pins', async () => {
    const materialize = vi.fn(async (input: unknown) => materialized(input));
    const resolvePerServiceDefaults = vi.fn(async (_input: { serviceIds: readonly string[] }) => ({
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
      },
    }));

    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServicesDefaultServiceIds: ['openai-codex'],
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon: materialize,
      releaseViaDaemon: vi.fn(async () => true),
      resolvePerServiceDefaults,
    });

    expect(resolvePerServiceDefaults).toHaveBeenCalledTimes(1);
    expect(resolvePerServiceDefaults.mock.calls.at(0)?.[0]).toMatchObject({ serviceIds: ['openai-codex'] });
    expect(prepared).not.toBeNull();
    const mergedSelection = {
      v: 1,
      bindingsByServiceId: {
        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
      },
    };
    expect(prepared?.selection).toEqual(mergedSelection);
    const materializeInput = materialize.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(materializeInput.connectedServicesBindingsRaw).toEqual(mergedSelection);
  });

  it('treats canonical null as an explicit native opt-out without resolving account defaults', async () => {
    const resolveSessionSpawnDefaults = vi.fn(async () => ({
      connectedServices: {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
        },
      },
    }));
    const materializeViaDaemon = vi.fn();

    const prepared = await prepareExecutionRunConnectedServices({
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      connectedServices: null,
      credentials: CREDENTIALS,
      cwd: '/tmp/workspace',
      sessionId: 'session-1',
      materializeViaDaemon,
      releaseViaDaemon: vi.fn(async () => true),
      resolveSessionSpawnDefaults,
    });

    expect(prepared).toBeNull();
    expect(resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    expect(materializeViaDaemon).not.toHaveBeenCalled();
  });

  it('RO-F5: fails closed (typed) when a bare default token has no stored connected default', async () => {
    const materialize = vi.fn(async (input: unknown) => materialized(input, { CODEX_HOME: '/x' }));
    await expect(
      prepareExecutionRunConnectedServices({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
        connectedServicesDefaultServiceIds: ['openai-codex'],
        credentials: CREDENTIALS,
        cwd: '/tmp/workspace',
        sessionId: 'session-1',
        materializeViaDaemon: materialize,
        releaseViaDaemon: vi.fn(async () => true),
        // No stored default for openai-codex → resolver returns null.
        resolvePerServiceDefaults: vi.fn(async () => null),
      }),
    ).rejects.toBeInstanceOf(ExecutionRunConnectedServicesUnavailableError);
    expect(materialize).not.toHaveBeenCalled();
  });
});
