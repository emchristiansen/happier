import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { withTempDir } from '@/testkit/fs/tempDir';
import { projectPath } from '@/projectPath';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('terminal_launch_spec_runner.cjs', () => {
  it('reads Windows verbatim argument handling and rejects malformed values', async () => {
    const mod = require('./terminal_launch_spec_runner.cjs') as {
      readLaunchSpecFile: (specPath: string) => Promise<{ windowsVerbatimArguments?: boolean }>;
    };
    const workDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-work-'));
    const validSpecDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const validSpecPath = join(validSpecDir, 'launch.json');
    await writeFile(validSpecPath, JSON.stringify({
      command: process.execPath,
      args: [],
      cwd: workDir,
      env: {},
      windowsVerbatimArguments: true,
    }), { mode: 0o600 });

    await expect(mod.readLaunchSpecFile(validSpecPath)).resolves.toMatchObject({
      windowsVerbatimArguments: true,
    });

    const invalidSpecDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const invalidSpecPath = join(invalidSpecDir, 'launch.json');
    await writeFile(invalidSpecPath, JSON.stringify({
      command: process.execPath,
      args: [],
      cwd: workDir,
      env: {},
      windowsVerbatimArguments: 'true',
    }), { mode: 0o600 });

    try {
      await expect(mod.readLaunchSpecFile(invalidSpecPath)).rejects.toThrow(
        'windowsVerbatimArguments must be a boolean',
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('keeps a full prompt file readable by the child and removes it after termination', async () => {
    const mod = require('./terminal_launch_spec_runner.cjs') as {
      runLaunchSpecFile: (path: string) => Promise<number>;
    };
    const specDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const promptDir = await mkdtemp(join(tmpdir(), 'happier-claude-system-prompt-'));
    const promptPath = join(promptDir, 'text-artifact.txt');
    const workDir = await mkdtemp(join(tmpdir(), 'happier-prompt-observation-'));
    const outputPath = join(workDir, 'observed.txt');
    const specPath = join(specDir, 'launch.json');
    const prompt = `  ${'λ'.repeat(80_000)}\n`;
    await writeFile(promptPath, prompt, { mode: 0o600 });
    await writeFile(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]));', promptPath, outputPath],
      cwd: tmpdir(), env: {}, cleanupPaths: [promptPath],
    }), { mode: 0o600 });
    try {
      await expect(mod.runLaunchSpecFile(specPath)).resolves.toBe(0);
      await expect(readFile(outputPath, 'utf8')).resolves.toBe(prompt);
      expect(existsSync(promptPath)).toBe(false);
      expect(existsSync(promptDir)).toBe(false);
    } finally {
      await rm(promptDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('retains the handed-off prompt when its preparing wrapper exits before the runner starts', async () => {
    await withTempDir('happier-terminal-handoff-', async (directory) => {
      const specPath = join(directory, 'launch.json');
      const outputPath = join(directory, 'observed.txt');
      const prompt = '  retained wrapper handoff prompt\n';
      const helperUrl = pathToFileURL(join(projectPath(), 'src/backends/claude/utils/materializeClaudeSystemPromptArgsForSpawn.ts')).href;
      const wrapper = spawnTestProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        import { writeFileSync } from 'node:fs';
        import { materializeClaudeSystemPromptArgsForSpawn } from ${JSON.stringify(helperUrl)};
        const prepared = await materializeClaudeSystemPromptArgsForSpawn(['--append-system-prompt', ${JSON.stringify(prompt)}]);
        writeFileSync(${JSON.stringify(specPath)}, JSON.stringify({
          command: process.execPath,
          args: ['-e', 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]));', prepared.cleanupPaths[0], ${JSON.stringify(outputPath)}],
          cwd: ${JSON.stringify(directory)}, env: {}, cleanupPaths: prepared.cleanupPaths,
        }));
        process.exit(0);
      `], { cwd: projectPath() });
      await new Promise<void>((resolve) => { wrapper.once('close', () => resolve()); });
      expect(wrapper.exitCode).toBe(0);
      const spec = JSON.parse(await readFile(specPath, 'utf8')) as { cleanupPaths: string[] };
      const promptPath = spec.cleanupPaths[0]!;
      try {
        await expect(readFile(promptPath, 'utf8')).resolves.toBe(prompt);
        const runner = spawnTestProcess(process.execPath, [require.resolve('./terminal_launch_spec_runner.cjs'), specPath]);
        await new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
        expect(runner.exitCode).toBe(0);
        await expect(readFile(outputPath, 'utf8')).resolves.toBe(prompt);
        expect(existsSync(dirname(promptPath))).toBe(false);
      } finally {
        await rm(dirname(promptPath), { recursive: true, force: true });
      }
    });
  });

  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGHUP'] as const)(
    'forwards %s and removes the prompt only after the retained child terminates',
    async (signal) => {
      await withTempDir('happier-terminal-signal-', async (directory) => {
        const promptDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-system-prompt-'));
        const promptPath = join(promptDirectory, 'text-artifact.txt');
        const readyPath = join(directory, 'ready.json');
        const observedPath = join(directory, 'observed.txt');
        const releasePath = join(directory, 'release');
        const prompt = '  terminal runner signal prompt\n';
        await writeFile(promptPath, prompt, { mode: 0o600 });
        const source = `
          const fs = require('node:fs');
          for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => {
            fs.writeFileSync(${JSON.stringify(observedPath)}, fs.readFileSync(${JSON.stringify(promptPath)}));
          });
          fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid }));
          setInterval(() => {
            if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
          }, 10);
        `;
        const specPath = join(directory, 'launch.json');
        await writeFile(specPath, JSON.stringify({
          command: process.execPath, args: ['-e', source], cwd: directory,
          env: {}, cleanupPaths: [promptPath],
        }));
        const runner = spawnTestProcess(process.execPath, [require.resolve('./terminal_launch_spec_runner.cjs'), specPath]);
        const closed = new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
        let childPid: number | undefined;
        try {
          await expect.poll(async () => {
            try { childPid = JSON.parse(await readFile(readyPath, 'utf8')).pid; return true; } catch { return false; }
          }).toBe(true);
          runner.kill(signal);
          await expect.poll(async () => {
            try { return await readFile(observedPath, 'utf8'); } catch { return ''; }
          }).toBe(prompt);
          expect(runner.signalCode).toBe(null);
          await expect(readFile(promptPath, 'utf8')).resolves.toBe(prompt);
          await writeFile(releasePath, '');
          await closed;
          expect(runner.signalCode).toBe(signal);
          expect(existsSync(promptDirectory)).toBe(false);
        } finally {
          if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
          if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
          await closed;
          await rm(promptDirectory, { recursive: true, force: true });
        }
      });
    },
  );

  it('runs a launch spec, forwards cwd/env/args, and removes the spec directory after reading', async () => {
    const mod = require('./terminal_launch_spec_runner.cjs') as {
      runLaunchSpecFile: (specPath: string) => Promise<number>;
    };
    const specDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const workDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-work-'));
    const outputPath = join(workDir, 'child-output.json');
    const cleanupDir = await mkdtemp(join(tmpdir(), 'happier-claude-mcp-config-'));
    const cleanupPath = join(cleanupDir, 'happier-claude-mcp-config.success.json');
    const specPath = join(specDir, 'launch.json');
    const previousSecret = process.env.SPEC_SECRET;
    process.env.SPEC_SECRET = 'from-runner-env';
    await writeFile(cleanupPath, '{"mcpServers":{}}', { mode: 0o600 });
    await writeFile(specPath, JSON.stringify({
      command: process.execPath,
      args: [
        '-e',
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), env: process.env.SPEC_ENV, secret: process.env.SPEC_SECRET, argv: process.argv.slice(2) }));',
        outputPath,
        'child-arg',
      ],
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? '',
        SPEC_ENV: 'from-spec',
      },
      envPassthroughKeys: ['SPEC_SECRET'],
      cleanupPaths: [cleanupPath],
    }), { mode: 0o600 });

    if (process.platform !== 'win32') {
      expect((await stat(specPath)).mode & 0o777).toBe(0o600);
    }
    const realDir = await realpath(workDir);
    try {
      await expect(mod.runLaunchSpecFile(specPath)).resolves.toBe(0);
      expect(existsSync(specPath)).toBe(false);
      expect(existsSync(cleanupPath)).toBe(false);
      expect(existsSync(dirname(cleanupPath))).toBe(false);
      await expect(readFile(outputPath, 'utf8')).resolves.toBe(JSON.stringify({
        cwd: realDir,
        env: 'from-spec',
        secret: 'from-runner-env',
        argv: ['child-arg'],
      }));
      expect(existsSync(specDir)).toBe(false);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.SPEC_SECRET;
      } else {
        process.env.SPEC_SECRET = previousSecret;
      }
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('tees child stderr to a per-session diagnostic log and non-zero exit report', async () => {
    const mod = require('./terminal_launch_spec_runner.cjs') as {
      runLaunchSpecFile: (specPath: string) => Promise<number>;
    };
    const specDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const workDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-work-'));
    const logsDir = join(workDir, 'logs', 'terminal-runner');
    const sessionExitDir = join(workDir, 'logs', 'session-exit');
    const cleanupPath = join(workDir, 'happier-claude-mcp-config.failure.json');
    const specPath = join(specDir, 'launch.json');
    await writeFile(cleanupPath, '{"mcpServers":{}}', { mode: 0o600 });
    await writeFile(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("raw claude stderr\\n"); process.exit(1);'],
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? '',
      },
      cleanupPaths: [cleanupPath],
      diagnostics: {
        sessionId: 'sess_stderr',
        logsDir,
        sessionExitDir,
      },
    }), { mode: 0o600 });

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(mod.runLaunchSpecFile(specPath)).resolves.toBe(1);
      expect(stderrWrite).toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }

    const logNames = await readdir(logsDir);
    expect(logNames).toHaveLength(1);
    expect(logNames[0]).toMatch(/^session-sess_stderr-pid-\d+\.stderr\.log$/);
    await expect(readFile(join(logsDir, logNames[0]!), 'utf8')).resolves.toBe('raw claude stderr\n');

    const reportNames = await readdir(sessionExitDir);
    expect(existsSync(cleanupPath)).toBe(false);
    expect(reportNames).toHaveLength(1);
    expect(reportNames[0]).toMatch(/^session-sess_stderr-pid-\d+\.json$/);
    const report = JSON.parse(await readFile(join(sessionExitDir, reportNames[0]!), 'utf8'));
    expect(report).toMatchObject({
      sessionId: 'sess_stderr',
      observedBy: 'session',
      reason: 'terminal-launch-child-exited',
      code: 1,
      stderrLogPath: join(logsDir, logNames[0]!),
      stderrTail: 'raw claude stderr\n',
    });
  });

  it('does not delete cleanup paths outside the owned Claude MCP filename contract', async () => {
    const mod = require('./terminal_launch_spec_runner.cjs') as {
      runLaunchSpecFile: (specPath: string) => Promise<number>;
    };
    const specDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-test-'));
    const workDir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-spec-work-'));
    const retainedPath = join(workDir, 'unowned-config.json');
    const specPath = join(specDir, 'launch.json');
    await writeFile(retainedPath, '{"keep":true}', { mode: 0o600 });
    await writeFile(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      cwd: workDir,
      env: { PATH: process.env.PATH ?? '' },
      cleanupPaths: [retainedPath],
    }), { mode: 0o600 });

    try {
      await expect(mod.runLaunchSpecFile(specPath)).resolves.toBe(0);
      expect(existsSync(retainedPath)).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
