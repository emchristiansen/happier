import { describe, expect, it, vi } from 'vitest';

import { requestClaudeExplicitRunnerStop } from './claudeExplicitRunnerStop';

describe('requestClaudeExplicitRunnerStop', () => {
  it('stops the exact Unified terminal before requesting runner termination', async () => {
    const order: string[] = [];
    const stopTerminalHostForExplicitStop = vi.fn(async () => {
      order.push('host_disposed');
    });
    const requestTermination = vi.fn(() => {
      order.push('termination_requested');
    });

    await requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: true,
      stopTerminalHostForExplicitStop,
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
      stopTerminalHostForExplicitStop: async () => {
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
      stopTerminalHostForExplicitStop: null,
      requestTermination,
      whenTerminated: Promise.resolve(),
    })).rejects.toThrow('exact terminal-host stop is unavailable');

    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('preserves the existing direct termination path for non-Unified Claude sessions', async () => {
    const requestTermination = vi.fn();

    await requestClaudeExplicitRunnerStop({
      unifiedTerminalEnabled: false,
      stopTerminalHostForExplicitStop: null,
      requestTermination,
      whenTerminated: Promise.resolve(),
    });

    expect(requestTermination).toHaveBeenCalledWith({ kind: 'killSession' });
  });
});
