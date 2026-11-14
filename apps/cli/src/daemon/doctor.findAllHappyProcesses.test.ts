import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, psListMock, procfsReads, FIXTURE_PID, FIXTURE_COMMAND } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => ''),
  psListMock: vi.fn(),
  procfsReads: [] as string[],
  FIXTURE_PID: 123,
  FIXTURE_COMMAND: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
}));

// The listed process's /proc entry is part of the same OS boundary as ps-list: classification
// prefers a readable /proc/<pid>/cmdline. Answer for the fixture's process so that a real process
// that happens to hold pid 123 (in a fresh PID namespace, a test worker) is never read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fixtureEntry = (path: unknown): string | null => (
    typeof path === 'string' && path.startsWith(`/proc/${FIXTURE_PID}/`) ? path.slice(`/proc/${FIXTURE_PID}/`.length) : null
  );
  const absent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    ...actual,
    readFile: (async (path: unknown, ...rest: unknown[]) => {
      const entry = fixtureEntry(path);
      if (entry === null) return await (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      procfsReads.push(entry);
      if (entry === 'cmdline') return Buffer.from(`${FIXTURE_COMMAND.split(' ').join('\0')}\0`);
      // The fixture process exposes no environment.
      if (entry === 'environ') return Buffer.alloc(0);
      throw absent(String(path));
    }) as typeof actual.readFile,
    readlink: (async (path: unknown, ...rest: unknown[]) => {
      const entry = fixtureEntry(path);
      if (entry === null) return await (actual.readlink as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      procfsReads.push(entry);
      // Its working directory is not visible.
      throw absent(String(path));
    }) as typeof actual.readlink,
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: execFileSyncMock,
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

describe('findAllHappyProcesses', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    // This test controls the ps-list OS boundary; Darwin has its own ps boundary.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  });
  afterEach(async () => {
    const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
    clearProcessSnapshotCacheForTests();
    vi.resetModules();
    execFileSyncMock.mockReset();
    psListMock.mockReset();
    procfsReads.length = 0;
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('coalesces concurrent classified process snapshots and reuses the fresh raw snapshot cache', async () => {
    let resolveProcessSnapshot!: (processes: unknown[]) => void;
    psListMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProcessSnapshot = resolve;
      }),
    );

    const { findAllHappyProcesses } = await import('./doctor');
    const first = findAllHappyProcesses();
    const second = findAllHappyProcesses();

    await Promise.resolve();
    expect(psListMock).toHaveBeenCalledTimes(1);

    resolveProcessSnapshot([
      {
        pid: FIXTURE_PID,
        name: 'node',
        cmd: FIXTURE_COMMAND,
      },
    ]);

    const expected = [{
      pid: FIXTURE_PID,
      command: FIXTURE_COMMAND,
      type: 'daemon',
    }];
    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
    // Classification consulted the fixture's own /proc entry, not a live process.
    expect(procfsReads).toContain('cmdline');

    psListMock.mockResolvedValueOnce([]);
    await expect(findAllHappyProcesses()).resolves.toEqual(expected);
    expect(psListMock).toHaveBeenCalledTimes(1);

    const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
    clearProcessSnapshotCacheForTests();
    await expect(findAllHappyProcesses()).resolves.toEqual([]);
    expect(psListMock).toHaveBeenCalledTimes(2);
  });
});
