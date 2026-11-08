import { describe, expect, it, vi } from 'vitest';

const { loggerInfoMock, loggerWarnMock, loggerDebugMock, loggerInfoFileMock, loggerWarnFileMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerInfoFileMock: vi.fn(),
  loggerWarnFileMock: vi.fn(),
}));

// File-log sink boundary (the real logger writes package log files; info and warn also write stdout).
vi.mock('@/ui/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
    infoFile: loggerInfoFileMock,
    warnFile: loggerWarnFileMock,
  },
}));

import type { DaemonLocallyPersistedState } from '@/persistence';
import {
  NativeConnectedServicesError,
  materializeClaudeProfileForNativeProcess,
  parseConnectNativeArgs,
  releaseClaudeProfileForNativeProcess,
} from './nativeConnectedServices';

const HOME = '/var/lib/happier/daemon/servers/w/daemon/connected-services/homes/claude-subscription/fixture/claude/claude-config';
const RUN_KEY = 'execution_run:5d2b7f0e-6a4c-4c1e-9d55-0b8f1f6a9e21';

// Mirrors the server's sessions.spawn.connected_services.list result shape.
const INVENTORY = {
  items: [
    { serviceId: 'claude-subscription', profiles: [{ profileId: 'fixture', status: 'connected' }, { profileId: 'other', status: 'connected' }] },
    { serviceId: 'anthropic', profiles: [] },
  ],
};

// Mirrors the daemon run-materialization bridge response (the daemon-side path is covered against the
// real bridge and registry in nativeConnectedServices.daemonBridge.test.ts).
function bridgeResponse(input: unknown, env: Record<string, string> = { CLAUDE_CONFIG_DIR: HOME }) {
  const request = input as { materializationKey: string; connectedServicesBindingsRaw: unknown };
  const bindings = request.connectedServicesBindingsRaw as {
    v: 1;
    bindingsByServiceId: Record<string, { source: 'native' } | { source: 'connected'; selection: 'profile'; profileId: string }>;
  };
  return {
    env,
    proof: { v: 1 as const, agentId: 'claude', materializationKey: request.materializationKey, connectedServicesBindings: bindings },
    registration: {
      v: 1 as const,
      agentId: 'claude',
      materializationKey: request.materializationKey,
      connectedServicesBindings: bindings,
      brokerSelectionIdentity: null,
      runtimeAccountIdentitySelections: [],
      sessionDirectory: '/state',
      materializedRoot: HOME,
    },
  };
}

function deps(overrides: Partial<Parameters<typeof materializeClaudeProfileForNativeProcess>[1]> = {}) {
  const base = {
    listInventory: vi.fn(async (): Promise<unknown> => INVENTORY),
    materializeViaDaemon: vi.fn(async (input: unknown) => bridgeResponse(input)),
    releaseViaDaemon: vi.fn(async (_body: unknown) => true),
    readDaemonPublication: vi.fn(async (): Promise<DaemonLocallyPersistedState | null> => PUBLICATION),
  };
  // Every override in this file is itself a vi.fn mock.
  return { ...base, ...overrides } as typeof base;
}

// The running daemon's publication: its pid is the registration's anchor, never this command or its caller.
const DAEMON_PID = 424242;
const PUBLICATION: DaemonLocallyPersistedState = {
  pid: DAEMON_PID,
  httpPort: 47011,
  startedAt: 1,
  startedWithCliVersion: '0.0.0-test',
  controlToken: 'publication-token',
};
const REQUEST = { profileId: 'fixture', expectedConfigDir: HOME, cwd: '/state' };

describe('materializeClaudeProfileForNativeProcess', () => {
  it('sends exactly the selected profile, without a session, and leaves release to the caller', async () => {
    const d = deps();
    const ready = await materializeClaudeProfileForNativeProcess(REQUEST, d);

    expect(d.materializeViaDaemon).toHaveBeenCalledTimes(1);
    const sent = d.materializeViaDaemon.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.agentId).toBe('claude');
    expect(sent.connectedServicesBindingsRaw).toEqual({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'fixture' },
        anthropic: { source: 'native' },
      },
    });
    expect(sent).not.toHaveProperty('sessionId');
    // The registration is anchored to the daemon's pid, not this short-lived command's.
    expect(sent.pid).toBe(DAEMON_PID);
    expect(sent.pid).not.toBe(process.pid);
    expect(ready).toEqual({
      v: 1,
      status: 'ready',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'fixture',
      materializationKey: sent.materializationKey,
    });
    expect(d.releaseViaDaemon).not.toHaveBeenCalled();
  });

  it('writes its decision lines to the log file only, never to stdout, so --json prints just the record', async () => {
    loggerInfoMock.mockClear();
    loggerWarnMock.mockClear();
    loggerInfoFileMock.mockClear();
    loggerWarnFileMock.mockClear();
    await materializeClaudeProfileForNativeProcess(REQUEST, deps());
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, deps({
      materializeViaDaemon: vi.fn(async () => {
        throw new Error('daemon control request timed out');
      }),
    }))).rejects.toThrow(NativeConnectedServicesError);
    expect(loggerInfoFileMock).toHaveBeenCalledWith('[EXECUTION RUN] connected services: materialized', expect.anything());
    expect(loggerWarnFileMock).toHaveBeenCalledWith(
      '[EXECUTION RUN] connected services: materialization FAILED; failing run start closed',
      expect.anything(),
    );
    expect(loggerInfoMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('never reports materialized env values, including a provider secret', async () => {
    const d = deps({
      materializeViaDaemon: vi.fn(async (input: unknown) => bridgeResponse(input, {
        CLAUDE_CONFIG_DIR: HOME,
        ANTHROPIC_API_KEY: 'sk-ant-test-secret-value',
      })),
    });
    const serialized = JSON.stringify(await materializeClaudeProfileForNativeProcess(REQUEST, d));
    expect(serialized).not.toContain('sk-ant-test-secret-value');
    expect(serialized).not.toContain(HOME);
  });

  it('fails closed and releases when the daemon prepared a different home', async () => {
    const d = deps({
      materializeViaDaemon: vi.fn(async (input: unknown) => bridgeResponse(input, { CLAUDE_CONFIG_DIR: '/elsewhere/claude-config' })),
    });
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, d)).rejects.toMatchObject({
      code: 'native_connected_services_expectation_failed',
    });
    const key = (d.materializeViaDaemon.mock.calls[0]![0] as { materializationKey: string }).materializationKey;
    expect(d.releaseViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ materializationKey: key }));
  });

  it('fails closed when the daemon cannot materialize, reclaiming the run key', async () => {
    const d = deps({
      materializeViaDaemon: vi.fn(async () => {
        throw new Error('Daemon is not running, file is stale');
      }),
    });
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, d)).rejects.toMatchObject({
      code: 'native_connected_services_not_materialized',
    });
    const key = (d.materializeViaDaemon.mock.calls[0]![0] as { materializationKey: string }).materializationKey;
    expect(d.releaseViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ materializationKey: key }));
  });

  it.each([
    ['a profile the account does not have', INVENTORY, 'missing'],
    ['a profile that needs reauthentication', { items: [{ serviceId: 'claude-subscription', profiles: [{ profileId: 'fixture', status: 'needs_reauth' }] }] }, 'fixture'],
    ['a profile id that only another service has', { items: [{ serviceId: 'anthropic', profiles: [{ profileId: 'fixture', status: 'connected' }] }] }, 'fixture'],
  ])('refuses %s before any daemon call', async (_label, inventory, profileId) => {
    const d = deps({ listInventory: vi.fn(async () => inventory) });
    await expect(materializeClaudeProfileForNativeProcess({ ...REQUEST, profileId }, d)).rejects.toMatchObject({
      code: 'native_connected_services_selection_invalid',
    });
    expect(d.materializeViaDaemon).not.toHaveBeenCalled();
  });

  it.each([
    ['no daemon is published', null],
    ['the publication has no control token to pin', { ...PUBLICATION, controlToken: undefined }],
  ])('refuses to materialize when %s', async (_label, publication) => {
    const d = deps({ readDaemonPublication: vi.fn(async () => publication) });
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, d)).rejects.toMatchObject({
      code: 'native_connected_services_daemon_unavailable',
    });
    expect(d.materializeViaDaemon).not.toHaveBeenCalled();
  });

  it('reads the daemon publication exactly once', async () => {
    const d = deps();
    await materializeClaudeProfileForNativeProcess(REQUEST, d);
    expect(d.readDaemonPublication).toHaveBeenCalledTimes(1);
  });

  it('reclaims the run key under the daemon pid when materialization fails', async () => {
    const d = deps({
      materializeViaDaemon: vi.fn(async () => {
        throw new Error('daemon control request timed out');
      }),
    });
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, d)).rejects.toMatchObject({
      code: 'native_connected_services_not_materialized',
    });
    expect(d.releaseViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ pid: DAEMON_PID }));
  });

  it('fails closed when the account inventory cannot be read, before any daemon call', async () => {
    const d = deps({
      listInventory: vi.fn(async () => {
        throw new Error('server unreachable');
      }),
    });
    await expect(materializeClaudeProfileForNativeProcess(REQUEST, d)).rejects.toMatchObject({
      code: 'native_connected_services_inventory_unavailable',
    });
    expect(d.materializeViaDaemon).not.toHaveBeenCalled();
  });
});

describe('releaseClaudeProfileForNativeProcess', () => {
  it('releases the exact run key through the daemon bridge', async () => {
    const releaseViaDaemon = vi.fn(async () => true);
    await releaseClaudeProfileForNativeProcess({ materializationKey: RUN_KEY }, { releaseViaDaemon });
    expect(releaseViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_KEY, materializationKey: RUN_KEY }));
  });

  it('reports a release the daemon did not confirm', async () => {
    await expect(releaseClaudeProfileForNativeProcess(
      { materializationKey: RUN_KEY },
      { releaseViaDaemon: vi.fn(async () => false) },
    )).rejects.toMatchObject({ code: 'native_connected_services_release_failed' });
  });
});

describe('parseConnectNativeArgs', () => {
  it('parses a materialize request', () => {
    expect(parseConnectNativeArgs([
      'materialize', 'claude', '--profile', 'fixture', '--expect-config-dir', HOME, '--json',
    ])).toEqual({ kind: 'materialize', profileId: 'fixture', expectedConfigDir: HOME, json: true });
  });

  it('parses a release request', () => {
    expect(parseConnectNativeArgs(['release', '--materialization-key', RUN_KEY])).toEqual({
      kind: 'release',
      materializationKey: RUN_KEY,
    });
  });

  it.each([
    [['materialize', '--profile', 'fixture', '--expect-config-dir', HOME]],
    [['materialize', 'codex', '--profile', 'fixture', '--expect-config-dir', HOME]],
    [['materialize', 'claude', '--expect-config-dir', HOME]],
    [['materialize', 'claude', '--profile', 'fixture']],
    [['materialize', 'claude', '--profile', 'fixture', '--expect-config-dir', 'relative/claude-config']],
    [['materialize', 'claude', '--profile', 'fixture', '--profile', 'other', '--expect-config-dir', HOME]],
    [['materialize', 'claude', '--profile', '--json', '--expect-config-dir', HOME]],
    [['materialize', 'claude', '--profile', 'fixture', '--expect-config-dir', HOME, '--unknown', 'x']],
    // A caller-named pid is not accepted: the registration's anchor is the daemon's.
    [['materialize', 'claude', '--profile', 'fixture', '--expect-config-dir', HOME, '--host-pid', '4242']],
    [['release']],
    [['release', '--materialization-key', 'session:abc']],
  ])('rejects %j', (args) => {
    expect(() => parseConnectNativeArgs(args)).toThrow(NativeConnectedServicesError);
  });
});
