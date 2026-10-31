import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { claudeLocal } from './claudeLocal';
import { resolveClaudeCliPath } from './utils/resolveClaudeCliPath';

it('reports a disappeared executable and releases the local launch abort listener', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-local-spawn-failure-'));
    const executable = join(directory, 'cli.js');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR']);
    const abort = new AbortController();
    const stdinWasPaused = process.stdin.isPaused();
    const exits: Array<Readonly<{ providerStopped: boolean }>> = [];
    writeFileSync(executable, '', { mode: 0o700 });
    env.patch({ HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: join(directory, 'config') });

    try {
        expect(resolveClaudeCliPath()).toBe(executable);
        unlinkSync(executable);

        await expect(claudeLocal({
            abort: abort.signal,
            sessionId: null,
            path: directory,
            onSessionFound: () => undefined,
            onProcessExit: result => { exits.push(result); },
        })).rejects.toMatchObject({ code: 'ENOENT', path: executable });

        expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
        expect(exits).toEqual([]);
    } finally {
        env.restore();
        if (stdinWasPaused) process.stdin.pause();
        rmSync(directory, { recursive: true, force: true });
    }
});
