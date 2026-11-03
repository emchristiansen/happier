import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

describe('claude sdk query executable resolution', () => {
  const originalPlatform = process.platform;
  const originalVersionsDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  const envKeys = [
    'DEBUG',
    'HAPPIER_MANAGED_NODE_BIN',
    'HAPPIER_JS_RUNTIME_PATH',
    'HAPPIER_NODE_PATH',
    'HAPPIER_HOME_DIR',
    'PATH',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  function setBunRuntime(enabled: boolean): void {
    if (enabled) {
      Object.defineProperty(process.versions, 'bun', {
        configurable: true,
        enumerable: true,
        value: '1.0.0',
      });
      return;
    }

    if (originalVersionsDescriptor) {
      Object.defineProperty(process.versions, 'bun', originalVersionsDescriptor);
      return;
    }

    delete (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    setBunRuntime(false);
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses process.execPath for JS entrypoints when executable is omitted (node runtime)', async () => {
    envScope.patch({ DEBUG: undefined });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('adds the Claude hook-event stream flag only when explicitly requested', async () => {
    envScope.patch({ DEBUG: undefined });
    const spawnMock = vi.fn((..._args: any[]) => { throw new Error('spawn invoked'); });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });
    const { query } = (await import('./query')) as typeof import('./query');

    await expect(query({
      prompt: 'hi',
      options: {
        cwd: '/tmp',
        pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        includeHookEvents: true,
      },
    })).rejects.toThrow(/spawn invoked/);

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain('--include-hook-events');
  });

  it('treats executable=\"node\" as an alias for process.execPath for JS entrypoints (node runtime)', async () => {
    envScope.patch({ DEBUG: undefined });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          executable: 'node',
          executableArgs: [],
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('prefers the managed node override for JS entrypoints when configured', async () => {
    await withTempDir('happier-query-managed-node-', async (overrideDir) => {
      const overridePath = writeExecutableShimSync({
        dir: overrideDir,
        fileName: process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node',
        contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
      });
      envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: () => true };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      await expect(
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).rejects.toThrow(/spawn invoked/);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe(overridePath);
    });
  });

  it('treats executable="node" as a managed-runtime alias under bun', async () => {
    await withTempDir('happier-query-managed-node-bun-', async (overrideDir) => {
      const overridePath = writeExecutableShimSync({
        dir: overrideDir,
        fileName: process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node',
        contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
      });
      envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });
      setBunRuntime(true);
      expect(process.versions.bun).toBe('1.0.0');

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: () => true };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      await expect(
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            executable: 'node',
            executableArgs: [],
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).rejects.toThrow(/spawn invoked/);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe(overridePath);
    });
  });

  it('fails closed for JS entrypoints under bun when executable="node" but no managed runtime is available', async () => {
    await withTempDir('happier-js-runtime-query-test-', async (happyHomeDir) => {
      const managedRuntimePath = join(
        happyHomeDir,
        'tools',
        'js-runtime',
        'current',
        'bin',
        process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
      );
      envScope.patch({
        HAPPIER_MANAGED_NODE_BIN: undefined,
        HAPPIER_JS_RUNTIME_PATH: undefined,
        HAPPIER_NODE_PATH: undefined,
        PATH: '',
        HAPPIER_HOME_DIR: happyHomeDir,
      });
      setBunRuntime(true);
      expect(process.versions.bun).toBe('1.0.0');

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: import('node:fs').PathLike) => path !== managedRuntimePath,
        };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      await expect(
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            executable: 'node',
            executableArgs: [],
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).rejects.toThrow(/HAPPIER_MANAGED_NODE_BIN/);

      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it('does not use shell when spawning an explicit .exe path on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: 'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Claude\\\\claude.exe',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(spawnOpts?.shell).not.toBe(true);
  });

  it('wraps .cmd shims with cmd.exe on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\\\\claude.cmd',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnCommand = spawnMock.mock.calls[0]?.[0] as unknown;
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as unknown;
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(String(spawnCommand).replaceAll('\\', '/').split('/').at(-1)).toBe('cmd.exe');
    expect((spawnArgs as any)?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect((spawnArgs as any)?.[3]).toContain('claude.cmd');
    expect(spawnOpts?.shell).not.toBe(true);
    expect(spawnOpts?.windowsVerbatimArguments).toBe(true);
  });

  it('strips nested Claude Code env vars from the spawned process environment', async () => {
    envScope.patch({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'parent',
    });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, any> | undefined;
    expect(spawnOpts?.env?.CLAUDECODE).toBeUndefined();
    expect(spawnOpts?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('does not forward HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON into the spawned Claude process environment', async () => {
    envScope.patch({
      HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: JSON.stringify(['GITHUB_TOKEN']),
    });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, any> | undefined;
    expect(spawnOpts?.env?.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON).toBeUndefined();
  });

  it('does not forward Claude OAuth refresh material into the spawned Claude process environment', async () => {
    envScope.patch({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-secret',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
    });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    await expect(
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          env: {
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'overlay-refresh-secret',
            CLAUDE_CODE_OAUTH_SCOPES: 'overlay-scope',
          },
        },
      }),
    ).rejects.toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, any> | undefined;
    expect(spawnOpts?.env?.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(spawnOpts?.env?.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined();
  });
  it('removes the private append prompt artifact when spawn throws synchronously', async () => {
    let promptPath = '';
    const spawnMock = vi.fn((_command: string, args: readonly string[]) => {
      promptPath = args[args.indexOf('--append-system-prompt-file') + 1] ?? '';
      expect(readFileSync(promptPath, 'utf8')).toBe('  private prompt\n');
      throw new Error('spawn failed synchronously');
    });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });
    const { query } = await import('./query');

    await expect(Promise.resolve().then(() => query({
      prompt: 'hello',
      options: {
        pathToClaudeCodeExecutable: process.execPath,
        appendSystemPrompt: '  private prompt\n',
      },
    }))).rejects.toThrow('spawn failed synchronously');
    expect(promptPath).not.toBe('');
    expect(existsSync(dirname(promptPath))).toBe(false);
  });

  it('removes the private append prompt artifact after an asynchronous spawn error', async () => {
    await withTempDir('happier-query-spawn-error-', async (directory) => {
      let promptPath = '';
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
            promptPath = args[args.indexOf('--append-system-prompt-file') + 1] ?? '';
            return actual.spawn(command, args, options);
          },
        };
      });
      const { query } = await import('./query');
      const q = await query({
        prompt: 'hello',
        options: {
          pathToClaudeCodeExecutable: process.execPath,
          cwd: join(directory, 'does-not-exist'),
          appendSystemPrompt: 'private prompt',
        },
      });

      await expect(q.next()).rejects.toThrow('Failed to spawn');
      expect(promptPath).not.toBe('');
      await expect.poll(() => existsSync(dirname(promptPath))).toBe(false);
    });
  });

  it.each([
    { mode: 'bypassPermissions', extra: [], prefix: ['--dangerously-skip-permissions'], retained: [] },
    { mode: 'bypassPermissions', extra: ['--permission-mode', 'plan'], prefix: ['--permission-mode', 'plan'], retained: [] },
    { mode: 'plan', extra: ['--permission-mode=bypassPermissions'], prefix: ['--dangerously-skip-permissions'], retained: [] },
    { mode: 'default', extra: ['--dangerously-skip-permissions', '--permission-mode=plan'], prefix: ['--permission-mode', 'plan'], retained: [] },
    { mode: 'default', extra: ['--permission-mode=plan', '--dangerously-skip-permissions'], prefix: ['--dangerously-skip-permissions'], retained: [] },
    { mode: 'bypassPermissions', extra: ['--permission-mode=default'], prefix: ['--permission-mode', 'default'], retained: [] },
    { mode: 'default', extra: ['--system-prompt', '--dangerously-skip-permissions'], prefix: [], retained: ['--system-prompt', '--dangerously-skip-permissions'] },
    { mode: 'bypassPermissions', extra: ['--system-prompt', '--permission-mode=plan'], prefix: ['--dangerously-skip-permissions'], retained: ['--system-prompt', '--permission-mode=plan'] },
    { mode: 'plan', extra: ['--', '--dangerously-skip-permissions'], prefix: ['--permission-mode', 'plan'], retained: ['--', '--dangerously-skip-permissions'] },
    { mode: 'bypassPermissions', extra: ['--', '--permission-mode=plan'], prefix: ['--dangerously-skip-permissions'], retained: ['--', '--permission-mode=plan'] },
  ] as const)('emits only the effective permission selection for $mode with $extra', async ({ mode, extra, prefix, retained }) => {
    const spawnMock = vi.fn((_command: string, _args: readonly string[]) => { throw new Error('spawn inspected'); });
    vi.doMock('node:child_process', async () => ({
      ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
      spawn: spawnMock,
    }));
    const { query } = await import('./query');
    await expect(query({ prompt: 'hello', options: {
      pathToClaudeCodeExecutable: process.execPath,
      permissionMode: mode,
      extraArgs: [...extra],
    } })).rejects.toThrow('spawn inspected');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      ...prefix, '--output-format', 'stream-json', '--verbose', ...retained, '--print', 'hello',
    ]);
  });

});
