import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from './controlClient';
import { restartAllDaemonSessionRunners } from './controlClient';

const readDaemonStateMock = vi.hoisted(() => vi.fn(async () => ({
  pid: process.pid,
  httpPort: 48765,
  controlToken: 'control-token',
})));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readDaemonState: readDaemonStateMock,
  };
});

describe('daemon control client: session runner restart', () => {
  afterEach(() => {
    readDaemonStateMock.mockReset();
    readDaemonStateMock.mockImplementation(async () => ({
      pid: process.pid,
      httpPort: 48765,
      controlToken: 'control-token',
    }));
    vi.restoreAllMocks();
  });

  it('posts bulk restart requests to the authenticated daemon control endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        mode: 'force_current_cli',
        requestedCount: 2,
        restartedCount: 1,
        skippedCount: 1,
        failedCount: 0,
        results: [
          { ok: true, status: 'restarted', sessionId: 'sess_1' },
          { ok: true, status: 'already_current', sessionId: 'sess_2' },
        ],
      }),
    } as Response);

    await expect(restartAllDaemonSessionRunners({
      mode: 'force_current_cli',
      dryRun: false,
      reason: 'daemon_restart_session_runners',
    })).resolves.toMatchObject({
      ok: true,
      requestedCount: 2,
      restartedCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:48765/session-runners/restart-all',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'control-token',
        }),
        body: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'daemon_restart_session_runners',
        }),
      }),
    );
  });

  it('fails closed when the daemon returns a malformed bulk restart response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    await expect(restartAllDaemonSessionRunners({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow('Invalid daemon session runner restart response');
  });
});


describe('signal-free pending queue wake: control client', () => {
  beforeEach(() => {
    readDaemonStateMock.mockResolvedValue({ pid: process.pid, httpPort: 48765, controlToken: 'control-token' });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
    expect(vi.isMockFunction(process.kill)).toBe(true);
    expect(vi.isMockFunction(readDaemonStateMock)).toBe(true);
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([{ type: 'wake_published' }, { type: 'unavailable', reason: 'runtime_upgrade_required' }, { type: 'unavailable', reason: 'rpc_failed' }] as const)('preserves diagnostic $type $reason through authenticated local HTTP', async (diagnostic) => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(diagnostic) } as Response);
    expect(typeof client.requestDaemonSessionPendingQueueWake).toBe('function');
    await expect(client.requestDaemonSessionPendingQueueWake({ sessionId: 'session_full_1' })).resolves.toEqual(diagnostic);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:48765/session-pending-queue-wake', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 'session_full_1' }), headers: expect.objectContaining({ 'x-happier-daemon-token': 'control-token' }) }));
  });
  it.each([
    [200, { type: 'wake_published', processed: true }],
    [200, { type: 'unavailable', reason: 'invented' }],
    [200, { ok: true }],
    [404, { message: 'Route not found' }],
    [501, { ok: false, errorCode: 'session_pending_queue_wake_handler_unavailable' }],
  ] as const)('refuses unsupported response %s %j with no retry', async (status, body) => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue({ ok: status === 200, status, text: async () => JSON.stringify(body) } as Response);
    expect(typeof client.requestDaemonSessionPendingQueueWake).toBe('function');
    await expect(client.requestDaemonSessionPendingQueueWake({ sessionId: 'session_full_1' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects an empty session before process or HTTP work', async () => {
    expect(typeof client.requestDaemonSessionPendingQueueWake).toBe('function');
    await expect(client.requestDaemonSessionPendingQueueWake({ sessionId: '' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
  });
});
