import { describe, expect, it, vi } from 'vitest';

import { waitForTerminatingSessionRunnerExit } from './waitForTerminatingSessionRunnerExit';

describe('waitForTerminatingSessionRunnerExit', () => {
  it('keeps polling an explicitly terminating runner until process evidence proves it absent', async () => {
    let nowMs = 0;
    const probe = vi.fn()
      .mockResolvedValueOnce({
        state: 'runner_present' as const,
        control: { state: 'recoverable_unservable' as const, reason: 'runtime_terminating' as const },
      })
      .mockResolvedValueOnce({ state: 'runner_absent' as const });

    await expect(waitForTerminatingSessionRunnerExit({
      initialProbe: {
        state: 'runner_present',
        control: { state: 'recoverable_unservable', reason: 'runtime_terminating' },
      },
      probe,
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => nowMs,
      sleep: async (delayMs) => { nowMs += delayMs; },
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('waits for an unresponsive live runner and returns once its process exits', async () => {
    let nowMs = 0;
    const probe = vi.fn().mockResolvedValue({ state: 'runner_absent' as const });
    const initialProbe = {
      state: 'runner_present' as const,
      control: { state: 'unknown' as const, reason: 'rpc_failed' as const },
    };
    await expect(waitForTerminatingSessionRunnerExit({
      initialProbe,
      probe,
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => nowMs,
      sleep: async (delayMs) => { nowMs += delayMs; },
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('keeps a persistently live unresponsive runner fenced when the bounded wait expires', async () => {
    let nowMs = 0;
    const unresponsiveProbe = {
      state: 'runner_present' as const,
      control: { state: 'recoverable_unservable' as const, reason: 'rpc_method_unavailable' as const },
    };
    const probe = vi.fn().mockResolvedValue(unresponsiveProbe);

    await expect(waitForTerminatingSessionRunnerExit({
      initialProbe: unresponsiveProbe,
      probe,
      timeoutMs: 25,
      pollIntervalMs: 10,
      now: () => nowMs,
      sleep: async (delayMs) => { nowMs += delayMs; },
    })).resolves.toEqual(unresponsiveProbe);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(nowMs).toBe(25);
  });
});
