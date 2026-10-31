import { expectTerminalNativeInvocation, terminalLauncherBoundary } from '@/testkit/process/terminalLauncher';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor));

import { runOpenCodeProviderAttach } from './runOpenCodeProviderAttach';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

describe('runOpenCodeProviderAttach', () => {
  it('attaches a released OpenCode 2 target through the root dialect with its retained credential in the child env', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));
    const probeHeaders: Array<Record<string, string> | undefined> = [];

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_v2',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-v2',
        opencodeBackendMode: 'server',
      },
      command: 'opencode',
      commandArgs: [],
      spawnProcess: spawnProcess as any,
      env: { PATH: '/bin' } as NodeJS.ProcessEnv,
      readManagedServerStateFn: async () => ({
        baseUrl: 'http://127.0.0.1:7777',
        pid: 4242,
        startedAtMs: 1,
        authPassword: 'retained-secret',
      } as any),
      resolveDialectFn: ({ headers }) => {
        probeHeaders.push(headers);
        return 'v2';
      },
      prepareProviderCliAttach: async ({ providerSessionId }) => ({ ok: true, providerSessionId }),
    })).resolves.toBe(0);

    const expectedAuthorization = `Basic ${Buffer.from('opencode:retained-secret', 'utf8').toString('base64')}`;
    // The dialect probe authenticates as the managed server requires...
    expect(probeHeaders).toEqual([{ Authorization: expectedAuthorization }]);
    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'opencode',
      ['--server', 'http://127.0.0.1:7777', '--session', 'opencode-session-v2', '/tmp/opencode-workspace'],
      expect.objectContaining({
        // ...and the attached CLI authenticates from its environment, never from argv.
        env: { PATH: '/bin', OPENCODE_PASSWORD: 'retained-secret' },
      }),
    );
  });

  it.each(['missing', 'rejected', 'different-session'] as const)(
    'refuses V2 native attachment when preparation is %s', async (preparation) => {
      const spawnProcess = vi.fn(() => terminalLauncherBoundary({
        once: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'exit') setImmediate(() => handler(0, null));
        },
      }));
      await expect(runOpenCodeProviderAttach({
        sessionId: 'sid_opencode_v2',
        metadata: {
          path: '/tmp', opencodeSessionId: 'native-session', opencodeBackendMode: 'server',
          opencodeServerBaseUrl: 'http://127.0.0.1:7777', opencodeServerBaseUrlExplicit: true,
        },
        command: 'opencode', commandArgs: [], spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
        readManagedServerStateFn: async () => null,
        resolveDialectFn: () => 'v2',
        ...(preparation === 'missing' ? {} : {
          prepareProviderCliAttach: async () => preparation === 'rejected'
            ? { ok: false as const, errorCode: 'provider_cli_attach_not_ready' }
            : { ok: true as const, providerSessionId: 'another-session' },
        }),
      })).rejects.toThrow();
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it('never hands the managed credential to a remote attach target', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_remote',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-remote',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://remote.example.test',
        opencodeServerBaseUrlExplicit: true,
      },
      command: 'opencode',
      commandArgs: [],
      spawnProcess: spawnProcess as any,
      env: { PATH: '/bin' } as NodeJS.ProcessEnv,
      resolveDialectFn: ({ headers }) => {
        expect(headers).toEqual({});
        return 'v1';
      },
      readManagedServerStateFn: async () => ({
        baseUrl: 'http://127.0.0.1:7777',
        pid: 4242,
        startedAtMs: 1,
        authPassword: 'retained-secret',
      } as any),
    })).resolves.toBe(0);

    // Explicit metadata base URLs are normalized to an origin with a trailing slash.
    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'opencode',
      expect.arrayContaining(['attach', 'https://remote.example.test/']),
      expect.objectContaining({ env: { PATH: '/bin' } }),
    );
  });

  it('reuses existing OpenCode session metadata and explicit server affinity to launch provider attach', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_1',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => null,
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'opencode',
      ['attach', 'http://127.0.0.1:4096/', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-1'],
      expect.objectContaining({
        stdio: 'inherit',
        shell: false,
      }),
    );
  });

  it('falls back to the shared managed OpenCode server URL when the session has no explicit server url', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_2',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-2',
        opencodeBackendMode: 'server',
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:7777' } as any),
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'opencode',
      ['attach', 'http://127.0.0.1:7777', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-2'],
      expect.any(Object),
    );
  });

  it('prefers agentRuntimeDescriptorV1 over legacy top-level OpenCode session metadata', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_descriptor_1',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'legacy-session-1',
        opencodeBackendMode: 'acp',
        opencodeServerBaseUrl: 'http://127.0.0.1:1111/',
        opencodeServerBaseUrlExplicit: true,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'descriptor-session-1',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
      },
      command: 'opencode',
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => null,
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'opencode',
      ['attach', 'http://127.0.0.1:4096/', '--dir', '/tmp/opencode-workspace', '--session', 'descriptor-session-1'],
      expect.any(Object),
    );
  });

  it('uses the resolved OpenCode CLI command when no explicit command override is passed', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_3',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-3',
        opencodeBackendMode: 'server',
      },
      env: {
        ...process.env,
        HAPPIER_OPENCODE_PATH: '/tmp/custom-opencode',
      },
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:8888' } as any),
      resolveCommandFn: (): ProviderCliLaunchSpec => ({
        source: 'override',
        resolvedPath: '/tmp/custom-opencode',
        command: '/tmp/custom-opencode',
        args: [],
      }),
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      '/tmp/custom-opencode',
      ['attach', 'http://127.0.0.1:8888', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-3'],
      expect.any(Object),
    );
  });

  it('does not resolve the CLI command when an explicit command override is provided', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));
    const resolveCommandFn: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec = vi.fn((): ProviderCliLaunchSpec => ({
      source: 'override',
      resolvedPath: '/tmp/unused-opencode',
      command: '/tmp/unused-opencode',
      args: [],
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_5',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-5',
        opencodeBackendMode: 'server',
      },
      command: '/tmp/custom-opencode',
      commandArgs: ['--stdio-wrapper'],
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:7777' } as any),
      resolveCommandFn,
    })).resolves.toBe(0);

    expect(resolveCommandFn).not.toHaveBeenCalled();
    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      '/tmp/custom-opencode',
      ['--stdio-wrapper', 'attach', 'http://127.0.0.1:7777', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-5'],
      expect.any(Object),
    );
  });

  it('prepends resolved launch args when the provider CLI needs a runtime wrapper', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_4',
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-4',
        opencodeBackendMode: 'server',
      },
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:9999' } as any),
      resolveCommandFn: (): ProviderCliLaunchSpec => ({
        source: 'system',
        resolvedPath: '/tmp/custom-opencode',
        command: '/tmp/custom-node',
        args: ['/tmp/custom-opencode'],
      }),
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      '/tmp/custom-node',
      ['/tmp/custom-opencode', 'attach', 'http://127.0.0.1:9999', '--dir', '/tmp/opencode-workspace', '--session', 'opencode-session-4'],
      expect.any(Object),
    );
  });

  it('wraps Windows shell shims before launching provider attach', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));
    // Platform identity is an OS boundary; command rendering remains real.
    Object.defineProperty(process, 'platform', { value: 'win32' });

    await expect(runOpenCodeProviderAttach({
      sessionId: 'sid_opencode_6',
      metadata: {
        path: 'C:\\repo',
        opencodeSessionId: 'opencode-session-6',
        opencodeBackendMode: 'server',
      },
      spawnProcess: spawnProcess as any,
      resolveDialectFn: () => 'v1',
      readManagedServerStateFn: async () => ({ baseUrl: 'http://127.0.0.1:7777' } as any),
      resolveCommandFn: (): ProviderCliLaunchSpec => ({
        source: 'system',
        resolvedPath: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
        command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
        args: [],
      }),
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv,
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', expect.stringContaining('opencode.CMD')],
      expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
    );
  });
});
