import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';

import { afterEach, describe, expect, it } from 'vitest';

import { query } from './query';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

describe('claude sdk query signal cleanup', () => {
  let tmpRoot = '';

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('cleans up the child process when the parent receives SIGTERM (no hang)', { timeout: 30_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-sigterm-'));
    const sleeper = join(tmpRoot, `sleep-${Date.now()}.js`);
    const markerPath = join(tmpRoot, 'marker.json');
    writeFileSync(
      sleeper,
      `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const markerPath = ${JSON.stringify(markerPath)};
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        writeFileSync(markerPath, JSON.stringify({ childPid: child.pid }), 'utf8');

        // Stay alive until the parent terminates us.
        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    const abortController = new AbortController();

    const sigtermBefore = process.listeners('SIGTERM').length;
    const sigintBefore = process.listeners('SIGINT').length;

    const q = await query({
      prompt: 'hi',
      options: {
        cwd: tmpRoot,
        executable: process.execPath,
        executableArgs: [],
        pathToClaudeCodeExecutable: sleeper,
        abort: abortController.signal,
      },
    });
    let descendantPid: number | null = null;

    try {
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore + 1);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore + 1);

      const iter = q[Symbol.asyncIterator]();
      const nextPromise = withTimeout(iter.next(), 5_000, 'query to terminate after SIGTERM');

      const marker = await withTimeout(
        new Promise<{ childPid: number }>((resolve, reject) => {
          const startedAt = Date.now();
          const poll = () => {
            try {
              resolve(JSON.parse(readFileSync(markerPath, 'utf8')) as { childPid: number });
            } catch (error) {
              if (Date.now() - startedAt > 10_000) {
                reject(error);
                return;
              }
              setTimeout(poll, 25);
            }
          };
          poll();
        }),
        11_000,
        'descendant marker before SIGTERM',
      );
      descendantPid = marker.childPid;

      process.emit('SIGTERM');

      await expect(nextPromise).rejects.toThrow(/Claude Code process/i);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const check = () => {
            try {
              process.kill(marker.childPid, 0);
              if (Date.now() - startedAt > 10_000) {
                reject(new Error(`Timed out waiting for descendant ${marker.childPid} to exit`));
                return;
              }
              setTimeout(check, 25);
            } catch {
              resolve();
            }
          };
          check();
        }),
        11_000,
        'descendant process cleanup after SIGTERM',
      );

      // Allow processExitPromise.finally() to run and detach listeners.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.listeners('SIGTERM').length).toBe(sigtermBefore);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    } finally {
      abortController.abort();
      if (descendantPid !== null) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });
});

it.skipIf(process.platform === 'win32')('cleans the SDK child and private prompt when its parent receives SIGHUP', async () => {
  await withTempDir('happier-sdk-hup-', async (directory) => {
    const readyPath = join(directory, 'ready.json');
    const observedPath = join(directory, 'observed.txt');
    const script = join(directory, 'fake-claude.cjs');
    const prompt = 'private SDK SIGHUP prompt';
    writeFileSync(script, `
      const fs = require('node:fs');
      const promptPath = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(observedPath)}, fs.readFileSync(promptPath));
        process.exit(0);
      });
      fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid, promptPath }));
      setInterval(() => {}, 1000);
    `);
    const parent = spawnTestProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { query } from ${JSON.stringify(pathToFileURL(join(projectPath(), 'src/backends/claude/sdk/query.ts')).href)};
      const q = await query({ prompt: 'fixture', options: {
        pathToClaudeCodeExecutable: ${JSON.stringify(script)}, executable: process.execPath,
        appendSystemPrompt: ${JSON.stringify(prompt)} } });
      try { for await (const message of q) {} } catch {}
    `], { cwd: projectPath(), env: { ...process.env, DEBUG: '', HAPPIER_HOME_DIR: join(directory, 'happier') } });
    const closed = new Promise<void>((resolve) => { parent.once('close', () => resolve()); });
    let ready: { pid: number; promptPath: string } | undefined;
    try {
      await expect.poll(() => {
        try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); return true; } catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
      parent.kill('SIGHUP');
      await closed;
      expect(existsSync(ready!.promptPath)).toBe(false);
      expect(readFileSync(observedPath, 'utf8')).toBe(prompt);
    } finally {
      if (ready) { try { process.kill(-ready.pid, 'SIGKILL'); } catch {} }
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await closed;
      if (ready) rmSync(dirname(ready.promptPath), { recursive: true, force: true });
    }
  });
});
