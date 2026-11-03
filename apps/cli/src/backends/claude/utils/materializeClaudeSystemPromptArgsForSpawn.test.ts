import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeClaudeSystemPromptArgsForSpawn } from './materializeClaudeSystemPromptArgsForSpawn';

describe('Claude append prompt file transport', () => {
    it('preserves UTF-8 bytes, empty values, argument order and independent cleanup', async () => {
        const text = `  ${'λ'.repeat(80_000)}\n`;
        const first = await materializeClaudeSystemPromptArgsForSpawn(['--append-system-prompt', text]);
        const second = await materializeClaudeSystemPromptArgsForSpawn(['--append-system-prompt=']);
        try {
            expect(first.args[0]).toBe('--append-system-prompt-file');
            await expect(readFile(first.args[1]!, 'utf8')).resolves.toBe(text);
            expect(second.args[0]).toBe(`--append-system-prompt-file=${second.cleanupPaths[0]}`);
            await expect(readFile(second.cleanupPaths[0]!, 'utf8')).resolves.toBe('');
            await first.cleanup();
            await expect(stat(dirname(first.cleanupPaths[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(second.cleanupPaths[0]!, 'utf8')).resolves.toBe('');
        } finally {
            await first.cleanup();
            await second.cleanup();
        }
    });

    it('does not reinterpret another flag value, a positional prompt, or an existing file', async () => {
        const args = ['--system-prompt', '--append-system-prompt=literal', '-p', '--append-system-prompt=question',
            '--append-system-prompt-file', '/user/owned.txt', '--', '--append-system-prompt=positional'];
        const prepared = await materializeClaudeSystemPromptArgsForSpawn(args);
        try {
            expect(prepared.args).toEqual(args);
            expect(prepared.cleanupPaths).toEqual([]);
        } finally {
            await prepared.cleanup();
        }
    });
});
