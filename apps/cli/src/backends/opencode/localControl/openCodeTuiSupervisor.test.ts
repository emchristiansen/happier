import { expectTerminalNativeInvocation, terminalLauncherBoundary } from '@/testkit/process/terminalLauncher';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor));

import { createOpenCodeTuiSupervisor } from './openCodeTuiSupervisor';

type SpawnedProcessHarness = Readonly<{
  child: {
    exitCode: number | null;
    killed: boolean;
    once: {
      (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
      (event: 'error', handler: (error: Error) => void): void;
    };
    kill: ReturnType<typeof vi.fn>;
  };
  emitExit: () => void;
  emitError: (error?: Error) => void;
}>;

function createSpawnedProcessHarness(): SpawnedProcessHarness {
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  const child = {
    exitCode: null as number | null,
    killed: false,
    once: vi.fn((event: 'exit' | 'error', handler: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)) => {
      if (event === 'exit') exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
      if (event === 'error') errorHandlers.push(handler as (error: Error) => void);
    }),
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGINT' || signal === 'SIGKILL') {
        child.killed = true;
      }
      return true;
    }),
  };

  return {
    child,
    emitExit: () => {
      child.exitCode = 0;
      for (const handler of exitHandlers.splice(0)) {
        handler(0, null);
      }
    },
    emitError: (error = new Error('spawn failed')) => {
      for (const handler of errorHandlers.splice(0)) {
        handler(error);
      }
    },
  };
}

async function createFakeExecutable(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-cli-'));
  const commandPath = join(root, name);
  await writeFile(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function createNodeShebangExecutable(name: string): Promise<{ commandPath: string; runtimePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-cli-node-'));
  const commandPath = join(root, name);
  const runtimeDir = join(root, 'runtime');
  const runtimePath = join(runtimeDir, 'node');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(commandPath, '#!/usr/bin/env node\nprocess.stdout.write("ok\\n")\n', 'utf8');
  await chmod(commandPath, 0o755);
  await writeFile(runtimePath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(runtimePath, 0o755);
  return { commandPath, runtimePath };
}

describe('createOpenCodeTuiSupervisor', () => {
  it('attaches a released OpenCode 2 managed server through the root dialect with its retained credential', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v2',
      readManagedServerStateFn: async () => ({
        baseUrl: 'http://127.0.0.1:4096',
        pid: 321,
        startedAtMs: 1,
        authPassword: 'retained-secret',
      } as never),
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    })).resolves.toBe(true);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      commandPath,
      ['--server', 'http://127.0.0.1:4096', '--session', 'session-1', '/tmp/workspace'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ OPENCODE_PASSWORD: 'retained-secret' }),
      }),
    );

    proc.emitExit();
  });

  it('spawns the resolved opencode attach command with inherited stdio and tracks attachment state', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    })).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      commandPath,
      ['attach', 'http://127.0.0.1:4096', '--dir', '/tmp/workspace', '--session', 'session-1'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(supervisor.isAttached()).toBe(true);

    proc.emitExit();
    await vi.waitFor(() => expect(supervisor.isAttached()).toBe(false));
  });

  it('detaches the running process and clears attachment state', async () => {
    const proc = createSpawnedProcessHarness();
    const onExit = vi.fn();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      onExit,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    await supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    });

    const detachPromise = supervisor.detach();
    expect(proc.child.kill).toHaveBeenCalledWith('SIGINT');
    proc.emitExit();
    await detachPromise;

    expect(supervisor.isAttached()).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('fails closed when the attach process errors before startup completes', async () => {
    const proc = createSpawnedProcessHarness();
    // Resolving the invocation (target dialect + per-target credential env) is asynchronous, so the
    // "before startup completes" window is entered from the spawn itself.
    const spawnProcess = vi.fn(() => {
      setImmediate(() => proc.emitError(new Error('ENOENT')));
      return terminalLauncherBoundary(proc.child);
    });
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    const attachPromise = supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    });
    await expect(attachPromise).resolves.toBe(false);
    expect(supervisor.isAttached()).toBe(false);
  });

  it('invokes onExit only once when the child emits both error and exit after startup', async () => {
    const proc = createSpawnedProcessHarness();
    const onExit = vi.fn();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      onExit,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    })).resolves.toBe(true);

    proc.emitError(new Error('late error'));
    proc.emitExit();

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(supervisor.isAttached()).toBe(false);
  });

  it('wraps node-shebang opencode CLIs with the configured JS runtime when attaching', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const { commandPath, runtimePath } = await createNodeShebangExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      env: {
        HAPPIER_OPENCODE_PATH: commandPath,
        HAPPIER_JS_RUNTIME_PATH: runtimePath,
      } as NodeJS.ProcessEnv,
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    })).resolves.toBe(true);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      runtimePath,
      [commandPath, 'attach', 'http://127.0.0.1:4096', '--dir', '/tmp/workspace', '--session', 'session-1'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('wraps Windows shell shims before attaching', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => terminalLauncherBoundary(proc.child));
    const isolatedHome = await mkdtemp(join(tmpdir(), 'happier-opencode-supervisor-home-'));
    // Platform identity is an OS boundary; command rendering remains real.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATH: '',
        PATHEXT: '.CMD;.EXE',
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      } as NodeJS.ProcessEnv,
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      resolveDialectFn: async () => 'v1',
      readManagedServerStateFn: async () => null,
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: 'C:\\workspace',
      sessionId: 'session-2',
    })).resolves.toBe(true);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', expect.stringContaining('opencode.CMD')],
      expect.objectContaining({ stdio: 'inherit', windowsVerbatimArguments: true }),
    );
  });
});
