import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// Only the OS process boundary is replaced; CLI invocation and capture remain real.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: spawnMock,
}));
import { runLocalHappierJsonCommand } from './happierCli.js';
import { installService } from './localDaemonCli.js';

describe('service command lifetime', () => {
  afterEach(() => { vi.useRealTimers(); spawnMock.mockReset(); });
  const cli = { command: '/test/happier', provenance: 'override' as const };
  function childProcess() {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    spawnMock.mockReturnValue(child);
    return child;
  }
  it.each(['install', 'start', 'stop', 'restart'])('lets the CLI own the %s deadline beyond the generic minute', async (action) => {
    vi.useFakeTimers();
    const child = childProcess();
    const pending = runLocalHappierJsonCommand({ cli, releaseRing: 'stable', args: ['daemon', 'service', action, '--json'] });
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(60_001);
    child.stdout.emit('data', '{"ok":true}\n');
    child.emit('close', 0, null);
    expect(await outcome).toEqual({ value: { ok: true } });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('cancels a service command at the OS boundary without waiting for its deadline', async () => {
    const child = childProcess();
    const controller = new AbortController();
    const pending = installService('stable', { replaceExisting: false, takeover: false }, { ...cli, version: '0.2.13', signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    controller.abort();
    child.emit('close', 1, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });
  it.each([['daemon', 'service', 'status', '--json'], ['daemon', 'service', 'install', '--dry-run', '--json']])('keeps the generic deadline for read-only %j', async (...args) => {
    vi.useFakeTimers();
    const child = childProcess();
    const outcome = runLocalHappierJsonCommand({ cli, releaseRing: 'stable', args }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatchObject({ code: 'cli_command_timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
