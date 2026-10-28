import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileMock: vi.fn() }));
// Archive preparation and copying stay real; only the native archive process is replaced.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnMock, execFile: execFileMock,
}));

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive';

describe('remote payload archive process', () => {
  it('hides the background tar process while keeping the prepared payload available until cleanup', async () => {
    const payload = await mkdtemp(join(tmpdir(), 'happier-archive-console-'));
    await writeFile(join(payload, 'happier.exe'), 'fixture');
    execFileMock.mockImplementation((...call: unknown[]) => {
      const callback = call.at(-1);
      if (typeof callback === 'function') callback(null, '', '');
      return {};
    });
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    try {
      const result = await createScpReadyPayloadArchive(payload);
      try {
        const options = spawnMock.mock.calls[0]?.[2] ?? execFileMock.mock.calls[0]?.[2];
        expect(options?.windowsHide).toBe(true);
        expect(result.archiveFileName).toMatch(/\.tar$/u);
      } finally {
        await result.cleanup();
      }
    } finally {
      await rm(payload, { recursive: true, force: true });
    }
  });
});
