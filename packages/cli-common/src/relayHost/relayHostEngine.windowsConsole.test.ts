import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock, state } = vi.hoisted(() => ({ spawnSyncMock: vi.fn(), state: { home: '' } }));
// These are the local OS boundaries; relay discovery and scheduled-task parsing stay real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync: spawnSyncMock,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => state.home,
}));

import { createRelayHostEngine } from './relayHostEngine';

describe('local Windows relay status consoles', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    spawnSyncMock.mockReset();
  });

  it('keeps repeated scheduler and PowerShell probes hidden when no relay is installed', async () => {
    state.home = await mkdtemp(join(tmpdir(), 'happier-relay-console-'));
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      spawnSyncMock.mockImplementation((command: string) => ({
        status: command === 'schtasks' ? 1 : 0,
        stdout: command === 'powershell.exe' ? '{"exists":false,"enabled":false,"active":false}' : '', stderr: '',
      }));
      const unavailableRemote = async (): Promise<never> => { throw new Error('remote operation was not requested'); };
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: unavailableRemote, runRemoteText: unavailableRemote,
        copyLocalDirectoryToRemote: unavailableRemote, installRemoteComponent: unavailableRemote,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await engine.readStatus({ target: { kind: 'local' }, channel: 'stable', mode: 'user' })).toMatchObject({
          installed: false, service: { enabled: null, active: null },
        });
      }
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'powershell.exe')).toBe(true);
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
      for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
    } finally {
      await rm(state.home, { recursive: true, force: true });
    }
  });
});
