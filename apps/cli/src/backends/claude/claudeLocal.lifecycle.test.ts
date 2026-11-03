import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';

const prompt = `  ${'é漢🙂\n'.repeat(14_340)} \n`;

describe.skipIf(process.platform === 'win32')('claudeLocal native signal lifecycle', () => {
  it.each(['SIGTERM', 'SIGHUP', 'exit'] as const)('retains the prompt through %s shutdown and cleans it before the parent terminates', async (signal) => {
    await withTempDir('happier-native-signal-', async (directory) => {
      const executable = join(directory, 'fake-claude');
      const readyPath = join(directory, 'ready.json');
      const observedPath = join(directory, 'signal-prompt.txt');
      const releasePath = join(directory, 'release');
      const parentExitPath = join(directory, 'parent-exit');
      await writeFile(executable, `#!${process.execPath}
        const fs = require('node:fs');
        const promptPath = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
        for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => {
          fs.writeFileSync(${JSON.stringify(observedPath)}, fs.readFileSync(promptPath));
        });
        fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid, promptPath }));
        setInterval(() => {
          if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
        }, 10);
      `);
      await chmod(executable, 0o700);
      const inputPath = join(directory, 'input-prompt.txt');
      await writeFile(inputPath, prompt);
      const source = `
        import { existsSync, readFileSync } from 'node:fs';
        import { claudeLocal } from ${JSON.stringify(pathToFileURL(join(projectPath(), 'src/backends/claude/claudeLocal.ts')).href)};
        const exitTimer = setInterval(() => { if (existsSync(${JSON.stringify(parentExitPath)})) process.exit(0); }, 10);
        try {
          await claudeLocal({ abort: new AbortController().signal, sessionId: null,
            path: ${JSON.stringify(directory)}, onSessionFound: () => {}, systemPromptText: readFileSync(${JSON.stringify(inputPath)}, 'utf8') });
        } catch (error) { process.stderr.write(String(error)); } finally { clearInterval(exitTimer); }
      `;
      const parent = spawnTestProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: projectPath(),
        env: { ...process.env, DEBUG: '', HAPPIER_HOME_DIR: join(directory, 'happier'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), HAPPIER_CLAUDE_PATH: executable },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      parent.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      const closed = new Promise<void>((resolve) => { parent.once('close', () => resolve()); });
      const exited = new Promise<void>((resolve) => { parent.once('exit', () => resolve()); });
      let ready: { pid: number; promptPath: string } | undefined;
      try {
        await expect.poll(async () => {
          try { ready = JSON.parse(await readFile(readyPath, 'utf8')); return true; }
          catch { if (parent.exitCode !== null) throw new Error(`Native parent exited: ${stderr}`); return false; }
        }, { timeout: 10_000 }).toBe(true);
        if (signal === 'exit') {
          await writeFile(parentExitPath, '');
          await exited;
          expect(parent.exitCode).toBe(0);
          await expect(readFile(ready!.promptPath)).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        parent.kill(signal);
        await expect.poll(async () => {
          try { return await readFile(observedPath, 'utf8'); } catch { return ''; }
        }).toBe(prompt);
        expect(parent.signalCode).toBe(null);
        await expect(readFile(ready!.promptPath, 'utf8')).resolves.toBe(prompt);
        await writeFile(releasePath, '');
        await closed;
        expect(parent.signalCode).toBe(signal);
        await expect(readFile(ready!.promptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (ready) {
          try { process.kill(ready.pid, 'SIGKILL'); } catch {}
        }
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
        await closed;
        if (ready) await rm(dirname(ready.promptPath), { recursive: true, force: true });
      }
    });
  });
});
