import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: spawnMock }));

describe('TmuxUtilities command execution timeout', () => {
  it.each([undefined, '/tmp/happier-timeout-test.sock'])('reports the operation and settles without close (socket: %s)', async (socketPath) => {
    vi.resetModules();
    const { TmuxUtilities } = await import('./TmuxUtilities');
    const { logger } = await import('@/ui/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => undefined };
    child.kill = vi.fn();
    spawnMock.mockReset().mockImplementation((_command: string, _args: readonly string[], _options: SpawnOptions) => child);

    try {
      const resultPromise = new TmuxUtilities(undefined, undefined, socketPath).executeTmuxCommand(
        ['list-sessions'],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toMatchObject({ returncode: 1, timedOut: true });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[TMUX] Command timed out', expect.objectContaining({
        operation: 'list-sessions',
        timeoutMs: 10,
      }));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
