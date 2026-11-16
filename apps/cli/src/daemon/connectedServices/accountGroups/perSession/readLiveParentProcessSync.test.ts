import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(() => { throw new Error('the parent reader must not start a child process'); }),
    execFileSync: vi.fn(() => { throw new Error('the parent reader must not start a child process'); }),
  };
});

import { readLiveParentProcessSync } from './readLiveParentProcessSync';

const statOf = (pid: number, ppid: number, startTime: number) =>
  `${pid} (node (w)) S ${[ppid, ...Array.from({ length: 17 }, (_, index) => index + 2)].join(' ')} ${startTime} 0 0`;

describe('readLiveParentProcessSync', () => {
  it('reads the live parent and its process instance from /proc', () => {
    const files: Record<string, string> = { '/proc/77/stat': statOf(77, 42, 900), '/proc/42/stat': statOf(42, 1, 500) };
    expect(readLiveParentProcessSync(77, { platform: 'linux', readFileSyncImpl: ((path: string) => files[path]) as never }))
      .toEqual({ pid: 42, processInstanceFingerprint: 'linux-proc:500' });
  });

  // R18-PARENT-SYNC-01: the parent exits between the child and parent reads.
  it('is unknown, without starting any child process, when the parent disappears between reads', () => {
    const readFileSyncImpl = ((path: string) => {
      if (path === '/proc/77/stat') return statOf(77, 42, 900);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as never;
    expect(readLiveParentProcessSync(77, { platform: 'linux', readFileSyncImpl })).toBeNull();
  });

  it('is unknown off Linux', () => {
    expect(readLiveParentProcessSync(77, { platform: 'darwin' })).toBeNull();
  });

  it.runIf(process.platform === 'linux')('reads a real live parent with the same instance as the shared fingerprint reader', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const parent = readLiveParentProcessSync(child.pid!);
      expect(parent?.pid).toBe(process.pid);
      expect(parent?.processInstanceFingerprint).toMatch(/^linux-proc:\d+$/u);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
