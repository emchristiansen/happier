import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';

import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';
import { runZellijAttach as runZellijAttachBase } from './zellijAttach';
import { prepareZellijSocketDir, resolveZellijSocketDir } from '@/integrations/zellij/socketDir';

const skipPrepareZellijSocketDir = async (): Promise<void> => {};

function runZellijAttach(
  params: Parameters<typeof runZellijAttachBase>[0],
  deps: Parameters<typeof runZellijAttachBase>[1] = {},
) {
  return runZellijAttachBase(params, {
    prepareSocketDirFn: skipPrepareZellijSocketDir,
    ...deps,
  });
}

describe('runZellijAttach', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('focuses the Claude pane and foreground-attaches the zellij session', async () => {
    const focusPane = vi.fn(async () => {});
    const attachForeground = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const socketDir = resolveZellijSocketDir('/home/happier');

    await expect(runZellijAttach({
      sessionId: 'sid-zellij',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happy-zellij',
          paneId: 'terminal_7',
        },
      },
    }, {
      resolveZellijBinaryFn: async () => '/tools/zellij',
      actions: {
        focusPane,
        attachForeground,
      },
      happyHomeDir: '/home/happier',
    })).resolves.toBe(0);

    expect(focusPane).toHaveBeenCalledWith({
      zellijBinary: '/tools/zellij',
      env: {
        ZELLIJ_SESSION_NAME: 'happy-zellij',
        ZELLIJ_SOCKET_DIR: socketDir,
      },
      paneId: 'terminal_7',
      timeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
    });
    expect(attachForeground).toHaveBeenCalledWith({
      zellijBinary: '/tools/zellij',
      env: {
        ZELLIJ_SOCKET_DIR: socketDir,
      },
      sessionName: 'happy-zellij',
    });
  });

  it('bounds best-effort pane focus before unbounded foreground attach', async () => {
    vi.useFakeTimers();
    const focusTimeoutMs = configuration.claudeUnifiedTerminalHostActionTimeoutMs;
    const focusPane = vi.fn(async () => new Promise<void>(() => {}));
    const socketDir = resolveZellijSocketDir('/home/happier');
    let finishAttach: (() => void) | undefined;
    const attachForeground = vi.fn(async () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      finishAttach = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
    }));

    let settled = false;
    const attach = runZellijAttach({
      sessionId: 'sid-zellij',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happy-zellij',
          paneId: 'terminal_7',
        },
      },
    }, {
      resolveZellijBinaryFn: async () => '/tools/zellij',
      actions: {
        focusPane,
        attachForeground,
      },
      happyHomeDir: '/home/happier',
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(focusTimeoutMs - 1);
    expect(attachForeground).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(focusPane).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: focusTimeoutMs }));
    expect(attachForeground).toHaveBeenCalledWith({
      zellijBinary: '/tools/zellij',
      env: {
        ZELLIJ_SOCKET_DIR: socketDir,
      },
      sessionName: 'happy-zellij',
    });

    await vi.advanceTimersByTimeAsync(focusTimeoutMs * 2);
    expect(settled).toBe(false);

    finishAttach?.();
    await expect(attach).resolves.toBe(0);
  });

  it('ignores stale zellij socket directory metadata and derives the local control directory', async () => {
    const focusPane = vi.fn(async () => {});
    const attachForeground = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const socketDir = resolveZellijSocketDir('/home/happier');
    const terminal = {
      mode: 'zellij',
      zellij: {
        sessionName: 'happy-zellij',
        paneId: 'terminal_7',
        socketDir: '/tmp/happier-zellij-a',
      },
    } as unknown as NonNullable<TerminalAttachmentInfo['terminal']>;

    await expect(runZellijAttach({
      sessionId: 'sid-zellij',
      terminal,
    }, {
      resolveZellijBinaryFn: async () => '/tools/zellij',
      actions: {
        focusPane,
        attachForeground,
      },
      happyHomeDir: '/home/happier',
    })).resolves.toBe(0);

    expect(focusPane).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        ZELLIJ_SOCKET_DIR: socketDir,
      }),
    }));
    expect(attachForeground).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        ZELLIJ_SOCKET_DIR: socketDir,
      }),
    }));
  });

  it('creates the shortened local zellij socket directory before focusing and attaching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-zellij-attach-socket-test-'));
    const happyHomeDir = join(root, 'long-happy-home-path-for-zellij-attach-socket-dir-'.repeat(3));
    const socketDir = resolveZellijSocketDir(happyHomeDir);
    await rm(socketDir, { recursive: true, force: true });
    const focusPane = vi.fn(async (params: { env: Readonly<Record<string, string>> }) => {
      const socketStat = await stat(params.env.ZELLIJ_SOCKET_DIR);
      expect(socketStat.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(socketStat.mode & 0o777).toBe(0o700);
      }
    });
    const attachForeground = vi.fn(async (params: { env: Readonly<Record<string, string>> }) => {
      const socketStat = await stat(params.env.ZELLIJ_SOCKET_DIR);
      expect(socketStat.isDirectory()).toBe(true);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    try {
      await expect(runZellijAttach({
        sessionId: 'sid-zellij',
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'happy-zellij',
            paneId: 'terminal_7',
          },
        },
      }, {
        resolveZellijBinaryFn: async () => '/tools/zellij',
      actions: {
        focusPane,
        attachForeground,
      },
      happyHomeDir,
      prepareSocketDirFn: prepareZellijSocketDir,
    })).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    }
  });

  it('returns a clear non-zero result when the bundled zellij binary is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runZellijAttach({
        sessionId: 'sid-zellij',
        terminal: {
          mode: 'zellij',
          zellij: { sessionName: 'happy-zellij' },
        },
      }, {
        resolveZellijBinaryFn: async () => null,
        happyHomeDir: '/home/happier',
      })).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('zellij is unavailable'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns a clear non-zero result when zellij is not supported by the Windows architecture', async () => {
    const focusPane = vi.fn(async () => {});
    const attachForeground = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runZellijAttach({
        sessionId: 'sid-zellij',
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'happy-zellij',
            paneId: 'terminal_7',
          },
        },
      }, {
        resolveZellijBinaryFn: async () => '/tools/zellij',
        resolveWindowsGuardFn: () => ({
          status: 'disabled',
          reason: 'windows_arm64_unsupported',
          message: 'Bundled zellij has no upstream Windows ARM64 binary; install WSL2 or use Agent SDK runner.',
        }),
        actions: {
          focusPane,
          attachForeground,
        },
        happyHomeDir: '/home/happier',
      })).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Windows ARM64'));
      expect(focusPane).not.toHaveBeenCalled();
      expect(attachForeground).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
