import { describe, expect, it, vi } from 'vitest';

import { requestClaudeExplicitRunnerStop } from './claudeExplicitRunnerStop';

describe('requestClaudeExplicitRunnerStop', () => {
  it('destroys the exact Unified host before requesting runner termination', async () => {
    const order: string[] = [];
    const destroyOwnedHostForExplicitStop = vi.fn(async () => {
      order.push('host_disposed');
    });
    const requestTermination = vi.fn(() => {
      order.push('termination_requested');
    });

    await requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: true,
      destroyOwnedHostForExplicitStop,
      requestTermination,
      whenTerminated: Promise.resolve(),
    });

    expect(order).toEqual(['host_disposed', 'termination_requested']);
  });

  it('does not request runner termination when exact Unified host disposal fails', async () => {
    const disposalError = new Error('injected exact-host disposal failure');
    const requestTermination = vi.fn();

    await expect(requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: true,
      destroyOwnedHostForExplicitStop: async () => {
        throw disposalError;
      },
      requestTermination,
      whenTerminated: Promise.resolve(),
    })).rejects.toBe(disposalError);

    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('does not request runner termination before Unified host ownership is available', async () => {
    const requestTermination = vi.fn();

    await expect(requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: true,
      destroyOwnedHostForExplicitStop: null,
      requestTermination,
      whenTerminated: Promise.resolve(),
    })).rejects.toThrow('exact terminal-host disposal is unavailable');

    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('uses the supplied local exit event after exact host disposal for an archived runner', async () => {
    const requestTermination = vi.fn();
    const destroyOwnedHostForExplicitStop = vi.fn(async () => {});
    await requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: true,
      destroyOwnedHostForExplicitStop,
      requestTermination,
      whenTerminated: Promise.resolve(),
      terminationEvent: { kind: 'exit', code: 0 },
    });
    expect(destroyOwnedHostForExplicitStop).toHaveBeenCalledOnce();
    expect(requestTermination).toHaveBeenCalledWith({ kind: 'exit', code: 0 });
  });

  it('preserves the existing direct termination path for non-Unified Claude sessions', async () => {
    const requestTermination = vi.fn();

    await requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: false,
      destroyOwnedHostForExplicitStop: null,
      requestTermination,
      whenTerminated: Promise.resolve(),
    });

    expect(requestTermination).toHaveBeenCalledWith({ kind: 'killSession' });
  });
});
