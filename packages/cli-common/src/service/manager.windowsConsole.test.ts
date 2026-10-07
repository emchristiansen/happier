import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
// The service plans and command discovery stay real; only execution crosses the OS boundary.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

import { applyServicePlan, inspectServiceRegistration, planServiceAction } from './manager';

describe('Windows background service consoles', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
    spawnSyncMock.mockReset();
  });

  it('hides scheduler mutation and registration probes while retaining their results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-service-console-'));
    try {
      await Promise.all(['powershell.exe', 'schtasks.exe'].map((name) => writeFile(join(directory, name), '')));
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      vi.stubEnv('PATH', directory);
      spawnSyncMock.mockImplementation((command: string) => ({
        status: 0,
        stdout: command === 'powershell.exe' ? '{"exists":true,"state":"Running"}' : '',
        stderr: '',
      }));
      await applyServicePlan(planServiceAction({
        backend: 'schtasks-user', action: 'restart', label: 'happier-daemon.default',
        taskName: 'Happier\\happier-daemon.default',
        definitionPath: join(directory, 'happier-daemon.default.ps1'),
      }));
      expect(inspectServiceRegistration({ backend: 'schtasks-user', label: 'happier-daemon.default' })).toBe('registered');
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'powershell.exe')).toBe(true);
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
      for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
