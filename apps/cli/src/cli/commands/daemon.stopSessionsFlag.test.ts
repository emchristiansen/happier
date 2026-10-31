import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonRunningInspection } from '@/daemon/controlClient';

import { captureStdout } from '@/testkit/logger/captureOutput';

const { inspectDaemonMock, stopDaemonMock, stopAllDaemonsBestEffortMock } = vi.hoisted(() => ({
  inspectDaemonMock: vi.fn<() => Promise<DaemonRunningInspection>>(async () => ({ status: 'not-running' })),
  stopDaemonMock: vi.fn(),
  stopAllDaemonsBestEffortMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    inspectDaemonRunningStateAndCleanupStaleState: inspectDaemonMock,
    checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
    listDaemonSessions: vi.fn(async () => []),
    stopDaemon: stopDaemonMock,
    stopDaemonSession: vi.fn(async () => false),
  };
});

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: vi.fn(async () => []),
  stopAllDaemonsBestEffort: stopAllDaemonsBestEffortMock,
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand: daemon stop --kill-sessions', () => {
  beforeEach(() => {
    stopDaemonMock.mockResolvedValue({ status: 'stopped', method: 'graceful' });
    stopAllDaemonsBestEffortMock.mockResolvedValue({ status: 'stopped', stoppedCount: 1 });
  });

  it.each([false, true])('reports absence from the stop owner (all=%s)', async (all) => {
    stopDaemonMock.mockResolvedValue({ status: 'not_running' });
    stopAllDaemonsBestEffortMock.mockResolvedValue({ status: 'not_running' });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:0'); }) as never);
    const stdout = captureStdout();
    try {
      await expect(handleDaemonCliCommand({ args: ['daemon', 'stop', ...(all ? ['--all'] : [])] } as never)).rejects.toThrow('exit:0');
      expect(stdout.text()).toContain(all ? 'No daemons were running' : 'No daemon was running');
      expect(stdout.text()).not.toContain('Stopped daemon');
    } finally {
      stdout.restore();
    }
  });

  afterEach(() => {
    inspectDaemonMock.mockReset();
    inspectDaemonMock.mockImplementation(async () => ({ status: 'not-running' as const }));
    stopDaemonMock.mockReset();
    stopAllDaemonsBestEffortMock.mockReset();
    vi.restoreAllMocks();
  });

  it('passes stopSessions to stopDaemon', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);
    const stdout = captureStdout();

    try {
      await expect(
        handleDaemonCliCommand({
          args: ['daemon', 'stop', '--kill-sessions'],
        } as any),
      ).rejects.toThrow(/exit:0/);
    } finally {
      stdout.restore();
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: true });
    expect(stdout.text()).toBe('- [..] Stopping daemon\n- [✓] Stopped daemon\n');
  }, 60_000);

  it('keeps daemon stop --all --json output silent for machine callers', async () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);
    const stdout = captureStdout();

    try {
      await expect(
        handleDaemonCliCommand({
          args: ['daemon', 'stop', '--all', '--json'],
        } as any),
      ).rejects.toThrow(/exit:0/);
    } finally {
      stdout.restore();
    }

    expect(stdout.text()).toBe('');
  }, 60_000);

  it('passes stopSessions to stopAllDaemonsBestEffort when --all is present', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);

    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop', '--all', '--kill-sessions'],
      } as any),
    ).rejects.toThrow(/exit:0/);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopAllDaemonsBestEffortMock).toHaveBeenCalledWith({ stopSessions: true });
  }, 60_000);

  it('allows stopping a legacy manually started daemon when startup metadata is missing', async () => {
    const runningInspection: DaemonRunningInspection = {
      status: 'running',
      state: {
        pid: process.pid,
        httpPort: 43110,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
      },
    };
    inspectDaemonMock.mockResolvedValue(runningInspection);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as any);
    await expect(
      handleDaemonCliCommand({
        args: ['daemon', 'stop'],
      } as any),
    ).rejects.toThrow(/exit:0/);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stopDaemonMock).toHaveBeenCalledWith({ stopSessions: false });
  }, 60_000);
});
