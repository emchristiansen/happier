import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from './index';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('child_process')>(),
    spawn: spawnMock,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        // Only synthesize the bundled executable; preserve neighboring filesystem operations.
        existsSync: (path: import('node:fs').PathLike) =>
            /[\\/]tools[\\/]unpacked[\\/]difft(?:\.exe)?$/.test(String(path)) || actual.existsSync(path),
    };
});

describe('difftastic run', () => {
    afterEach(() => {
        spawnMock.mockReset();
    });

    it('reports signal termination as an unsuccessful exit code', async () => {
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        spawnMock.mockReturnValue(child);

        const resultPromise = run(['--version']);
        await Promise.resolve();
        child.stdout.write('partial stdout');
        child.stderr.write('partial stderr');
        child.emit('close', null, 'SIGTERM');

        await expect(resultPromise).resolves.toEqual({
            exitCode: -1,
            stdout: 'partial stdout',
            stderr: 'partial stderr',
        });
    });
});
