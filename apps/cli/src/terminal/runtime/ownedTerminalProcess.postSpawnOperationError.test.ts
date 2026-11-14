import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { launchOwnedTerminalProcess } from './ownedTerminalProcess';

// A zombie or dead PID is not a running native provider.
function isRunning(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0];
    return state !== undefined && state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

const prompt = '  exact synthetic prompt\n';
const waitOptions = { timeout: 15_000, interval: 25 };

/**
 * Real controller -> runner executable -> native child. Node's post-spawn operation `error` is
 * injected only at the runner's `child_process.spawn` boundary, after the native child runs.
 */
async function launchThenInjectPostSpawnOperationError(root: string) {
  const promptDir = await mkdtemp(join(tmpdir(), 'happier-claude-system-prompt-'));
  const promptPath = join(promptDir, 'text-artifact.txt');
  const pidPath = join(root, 'native.pid');
  const releasePath = join(root, 'release');
  const observedPath = join(root, 'observed.txt');
  const triggerPath = join(root, 'inject-error');
  const injectedPath = join(root, 'error-injected');
  await writeFile(promptPath, prompt, { mode: 0o600 });
  const nativePath = join(root, 'native.cjs');
  await writeFile(nativePath, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
      fs.writeFileSync(${JSON.stringify(observedPath)}, fs.readFileSync(${JSON.stringify(promptPath)}));
      process.exit(0);
    }, 10);
  `);
  const preloadPath = join(root, 'preload.cjs');
  await writeFile(preloadPath, `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const spawn = cp.spawn;
    cp.spawn = (...args) => {
      const child = spawn(...args);
      if (!Array.isArray(args[1]) || args[1][0] !== ${JSON.stringify(nativePath)}) return child;
      child.once('spawn', () => {
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(triggerPath)})) return;
          clearInterval(timer);
          child.emit('error', Object.assign(new Error('synthetic post-spawn operation error'), { code: 'EPERM' }));
          fs.writeFileSync(${JSON.stringify(injectedPath)}, 'emitted');
        }, 10);
        child.once('exit', () => clearInterval(timer));
      });
      return child;
    };
  `);
  const specPath = join(root, 'launch.json');
  await writeFile(specPath, JSON.stringify({
    command: process.execPath, args: [nativePath], cwd: root,
    env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir() }, inheritStderr: true, cleanupPaths: [promptPath],
  }));
  let launcher: ReturnType<typeof spawn> | undefined;
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    launcher = spawn(...args);
    return launcher;
  }) as typeof spawn;
  const owned = await launchOwnedTerminalProcess({
    cwd: root,
    spawnProcess,
    spawn: {
      spawnArgv: [process.execPath, '--require', preloadPath, resolve('scripts/terminal_launch_spec_runner.cjs'), specPath],
      spawnEnv: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir() },
    },
  });
  let launcherExited = false;
  void owned.whenExited.then(() => { launcherExited = true; }, () => { launcherExited = true; });
  let nativePid = 0;
  await vi.waitFor(async () => {
    nativePid = Number(await readFile(pidPath, 'utf8'));
    expect(nativePid).toBeGreaterThan(0);
  }, waitOptions);
  await writeFile(triggerPath, 'trigger');
  await vi.waitFor(() => expect(existsSync(injectedPath)).toBe(true), waitOptions);
  return {
    owned, launcher: launcher!, nativePid, promptDir, promptPath, releasePath, observedPath,
    launcherExited: () => launcherExited,
  };
}

type Launched = Awaited<ReturnType<typeof launchThenInjectPostSpawnOperationError>>;

async function withPostSpawnOperationError(run: (launched: Launched) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'happier-terminal-operation-error-'));
  let launched: Launched | undefined;
  try {
    launched = await launchThenInjectPostSpawnOperationError(root);
    // The error is reported without settling native lifetime: its owner and prompt remain.
    // Soft, so each case still reaches its own lifecycle assertions below.
    expect.soft(isRunning(launched.nativePid)).toBe(true);
    expect.soft(launched.launcherExited()).toBe(false);
    expect.soft(isRunning(launched.launcher.pid!)).toBe(true);
    await expect.soft(readFile(launched.promptPath, 'utf8')).resolves.toBe(prompt);
    await run(launched);
  } finally {
    // Fixture teardown only; product assertions above never rely on these kills.
    if (launched) {
      for (const pid of [launched.nativePid, launched.launcher.pid]) {
        if (pid && isRunning(pid)) process.kill(pid, 'SIGKILL');
      }
      await rm(launched.promptDir, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')('launchOwnedTerminalProcess after a post-spawn native operation error', () => {
  it('lets the owner terminate the still-running native child', async () => {
    await withPostSpawnOperationError(async ({ owned, nativePid }) => {
      await owned.terminate();
      const exit = await owned.whenExited;
      expect(isRunning(nativePid)).toBe(false);
      // Stop evidence is the launcher's report of the native child's actual exit, not its
      // operation-error status. The launcher leads no group, so its snapshot cleanup is no tree proof.
      expect(exit).toMatchObject({ nativeExited: true });
      expect(exit).not.toHaveProperty('processTreeStopped');
    });
  }, 60_000);

  it('stops the native child when the controller channel is lost', async () => {
    await withPostSpawnOperationError(async ({ owned, launcher, nativePid, promptDir }) => {
      if (launcher.connected) launcher.disconnect();
      await vi.waitFor(() => expect(isRunning(nativePid)).toBe(false), waitOptions);
      const exit = await owned.whenExited;
      expect(exit.nativeExited).not.toBe(true);
      expect(existsSync(promptDir)).toBe(false);
    });
  }, 60_000);

  it('keeps the prompt readable until natural native exit, then reports that exit and retires it', async () => {
    await withPostSpawnOperationError(async ({ owned, nativePid, promptDir, releasePath, observedPath }) => {
      await writeFile(releasePath, '');
      const exit = await owned.whenExited;
      expect(exit).toMatchObject({ code: 127, signal: null, nativeExited: true });
      expect(isRunning(nativePid)).toBe(false);
      await expect(readFile(observedPath, 'utf8')).resolves.toBe(prompt);
      expect(existsSync(promptDir)).toBe(false);
    });
  }, 60_000);
});
