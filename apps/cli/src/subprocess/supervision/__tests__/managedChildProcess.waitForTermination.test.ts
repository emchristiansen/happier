import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createManagedChildProcess } from '../managedChildProcess';

describe('managedChildProcess.waitForTermination', () => {
  it('settles for non-zero exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    const managed = createManagedChildProcess(child);
    const event = await managed.waitForTermination();
    expect(event).toEqual({ type: 'exited', code: 7 });
  });

  it('waits for physical exit after aborting an already running child', async () => {
    const abort = new AbortController();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: abort.signal,
      stdio: 'ignore',
    });
    const managed = createManagedChildProcess(child);
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await once(child, 'spawn');
      abort.abort();
      expect(await managed.waitForTermination()).toMatchObject({ type: 'signaled', signal: 'SIGTERM' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
  });

  it('settles failed process creation without waiting for an exit event', async () => {
    const child = spawn('happier-nonexistent-managed-process-fixture', [], { stdio: 'ignore' });
    const managed = createManagedChildProcess(child);
    expect(await managed.waitForTermination()).toMatchObject({ type: 'spawn_error' });
  });
});

