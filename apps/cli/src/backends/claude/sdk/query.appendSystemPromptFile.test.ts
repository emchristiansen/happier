import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { query } from './query';

const appendPrompt = `  ${'é漢🙂\n'.repeat(14_340)} \n`;

function writePromptReader(directory: string): string {
  const script = join(directory, 'prompt-reader.cjs');
  writeFileSync(script, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const index = args.indexOf('--append-system-prompt-file');
    if (index < 0 || args.includes('--append-system-prompt')) process.exit(9);
    const promptPath = args[index + 1];
    const contents = fs.readFileSync(promptPath);
    const report = { args, promptPath, bytes: contents.length, digest: require('node:crypto').createHash('sha256').update(contents).digest('hex') };
    fs.writeFileSync(${JSON.stringify(join(directory, 'report.json'))}, JSON.stringify(report));
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(join(directory, 'abort.tmp'))}, JSON.stringify({ exists: fs.existsSync(promptPath) }));
      fs.renameSync(${JSON.stringify(join(directory, 'abort.tmp'))}, ${JSON.stringify(join(directory, 'abort.json'))});
      process.exit(0);
    });
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session' }));
    const timer = setInterval(() => {
      const release = ${JSON.stringify(join(directory, 'release'))};
      if (fs.existsSync(release)) {
        clearInterval(timer);
        process.exit(Number(fs.readFileSync(release, 'utf8')));
      }
    }, 10);
  `);
  return script;
}

describe('claude sdk append-system-prompt file transport', () => {
  beforeEach(() => { vi.stubEnv('DEBUG', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each([0, 7])('retains all prompt bytes privately until child exit %s, then removes the artifact', async (exitCode) => {
    await withTempDir('happier-query-prompt-file-', async (directory) => {
      const script = writePromptReader(directory);
      const abort = new AbortController();
      const q = await query({
        prompt: 'hello',
        options: {
          pathToClaudeCodeExecutable: script,
          executable: process.execPath,
          appendSystemPrompt: appendPrompt,
          customSystemPrompt: 'custom system prompt',
          abort: abort.signal,
        },
      });
      try {
        expect((await q.next()).done).toBe(false);
        const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as { args: string[]; promptPath: string; bytes: number; digest: string };
        expect(report.bytes).toBe(143_404);
        expect(report.digest).toBe(createHash('sha256').update(appendPrompt).digest('hex'));
        expect(report.args).not.toContain(appendPrompt);
        expect(report.args).toContain('--system-prompt');
        expect(report.args).toContain('custom system prompt');
        expect(readFileSync(report.promptPath, 'utf8')).toBe(appendPrompt);
        if (process.platform !== 'win32') {
          expect(statSync(report.promptPath).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(report.promptPath)).mode & 0o777).toBe(0o700);
        }
        writeFileSync(join(directory, 'release'), String(exitCode));
        if (exitCode === 0) await expect(q.next()).resolves.toMatchObject({ done: true });
        else await expect(q.next()).rejects.toThrow('exited with code 7');
        await expect.poll(() => existsSync(dirname(report.promptPath))).toBe(false);
      } finally {
        abort.abort();
      }
    });
  });

  it('keeps the prompt readable during abort and removes it after the child closes', async () => {
    await withTempDir('happier-query-prompt-abort-', async (directory) => {
      const abort = new AbortController();
      const q = await query({
        prompt: 'hello',
        options: {
          pathToClaudeCodeExecutable: writePromptReader(directory),
          executable: process.execPath,
          appendSystemPrompt: appendPrompt,
          abort: abort.signal,
        },
      });
      try {
        expect((await q.next()).done).toBe(false);
        const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as { promptPath: string };
        abort.abort();
        await expect(q.next()).rejects.toThrow(/aborted/i);
        await expect.poll(() => existsSync(join(directory, 'abort.json'))).toBe(true);
        expect(JSON.parse(readFileSync(join(directory, 'abort.json'), 'utf8'))).toEqual({ exists: true });
        await expect.poll(() => existsSync(dirname(report.promptPath))).toBe(false);
      } finally {
        abort.abort();
      }
    });
  });
});
