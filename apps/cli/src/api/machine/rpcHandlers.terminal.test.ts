import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '@/daemon/terminalPty/terminalPtySessionManager';
import type { PtyProcess, PtyProvider, PtySpawnParams } from '@/integrations/pty/ptyProvider';

class FakePty implements PtyProcess {
  write(): void { }
  resize(): void { }
  kill(): void { }
  onData(_listener: (data: string) => void): { dispose: () => void } { return { dispose: () => { } }; }
  onExit(_listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose: () => void } {
    return { dispose: () => { } };
  }
}

class FakePtyProvider implements PtyProvider {
  public readonly spawned: PtySpawnParams[] = [];

  spawn(params: PtySpawnParams): PtyProcess {
    this.spawned.push(params);
    return new FakePty();
  }
}

describe('registerMachineTerminalRpcHandlers', () => {
  it('launches a typed Happier CLI intent through the daemon current-runtime resolver', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-cli-'));
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;
    const buildLaunchSpec = vi.fn(() => ({
      runtime: 'binary' as const,
      filePath: '/opt/happier/bin/happier',
      args: ['agy', 'auth', 'login'],
      env: { HAPPIER_CLI_TEST: '1' },
    }));

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: suiteDir,
        sessionManager,
        buildHappyCliSubprocessLaunchSpecFn: buildLaunchSpec,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!;
    const result = await ensure({
      terminalKey: 'provider-login:machine-1:agy:primary',
      launch: { kind: 'happier_cli', args: ['agy', 'auth', 'login'] },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(buildLaunchSpec).toHaveBeenCalledWith(['agy', 'auth', 'login']);
    expect(provider.spawned[0]).toEqual(expect.objectContaining({
      file: '/opt/happier/bin/happier',
      args: ['agy', 'auth', 'login'],
      options: expect.objectContaining({
        env: expect.objectContaining({ HAPPIER_CLI_TEST: '1' }),
      }),
    }));
  });

  it('launches typed session attach through the current CLI entrypoint and daemon-owned terminal key', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-attach-'));
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;
    const buildLaunchSpec = vi.fn(() => ({
      runtime: 'binary' as const,
      filePath: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
      env: { HAPPIER_ATTACH_TEST: '1' },
    }));

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: suiteDir,
        sessionManager,
        buildHappyCliSubprocessLaunchSpecFn: buildLaunchSpec,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!;
    const first = await ensure({
      terminalKey: 'caller-must-not-own-this-key',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
      cols: 90,
      rows: 30,
    });
    const second = await ensure({
      terminalKey: 'different-caller-key',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
      cols: 100,
      rows: 40,
    });

    expect(first).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(second).toEqual(expect.objectContaining({ ok: true, reused: true, terminalId: first.terminalId }));
    expect(buildLaunchSpec).toHaveBeenCalledTimes(2);
    expect(buildLaunchSpec).toHaveBeenCalledWith(['attach', 'session-1']);
    expect(provider.spawned).toHaveLength(1);
    expect(provider.spawned[0]).toEqual(expect.objectContaining({
      file: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
      options: expect.objectContaining({
        env: expect.objectContaining({ HAPPIER_ATTACH_TEST: '1' }),
      }),
    }));
  });

  it('fails closed when explicitly disabled', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '0' },
        workingDirectory: process.cwd(),
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_disabled',
      error: 'terminal_disabled',
    });
  });

  it('spawns a PTY session by default when cwd is allowed', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    const subDir = join(rootDir, 'subdir');
    await mkdir(rootDir, { recursive: true });
    await mkdir(subDir, { recursive: true });
    const realSubDir = await realpath(subDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: 'subdir', cols: 90, rows: 30 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realSubDir);
  });

  it('allows an absolute cwd outside the default directory when no restricted policy is configured', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const defaultDir = join(suiteDir, 'default');
    const externalDir = join(suiteDir, 'external');
    await mkdir(defaultDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });
    const realExternalDir = await realpath(externalDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: defaultDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: externalDir, cols: 80, rows: 24 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realExternalDir);
  });

  it('rejects an absolute cwd outside every restricted root', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const defaultDir = join(suiteDir, 'default');
    const restrictedRoot = join(suiteDir, 'allowed');
    const outsideDir = join(suiteDir, 'outside');
    await mkdir(defaultDir, { recursive: true });
    await mkdir(restrictedRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: defaultDir,
        accessPolicy: {
          kind: 'restrictedRoots',
          roots: [restrictedRoot],
        },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cwd: outsideDir, cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });
    expect(provider.spawned).toHaveLength(0);
  });

  it('uses comma-delimited HAPPIER_MACHINE_RPC_WORKING_DIRECTORY as restricted roots', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootA = join(suiteDir, 'allowed-a');
    const rootB = join(suiteDir, 'allowed-b');
    const outsideDir = join(suiteDir, 'outside');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const realRootB = await realpath(rootB);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {
          HAPPIER_DAEMON_TERMINAL_ENABLED: '1',
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: `${rootA}, ${rootB}`,
        },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'outside', cwd: outsideDir, cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });

    const result = await ensure!({ terminalKey: 'allowed', cwd: rootB, cols: 80, rows: 24 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realRootB);
  });

  it('rejects cwd outside the configured restricted root', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        accessPolicy: {
          kind: 'restrictedRoots',
          roots: [rootDir],
        },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cwd: '/etc', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });
  });

  it('expands ~/ cwd against env HOME before validating terminal sessions', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-home-'));
    const homeDir = join(suiteDir, 'home');
    const rootDir = join(homeDir, 'workspace');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HOME: homeDir, HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: '~/workspace', cols: 80, rows: 24 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(await realpath(rootDir));
  });
});
