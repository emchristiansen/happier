import { describe, expect, it } from 'vitest';

import { resolveTerminalHost } from './resolveTerminalHost';
import type { TerminalHostAdapter, TerminalHostResolverPlatform } from './_types';

function adapter(kind: 'tmux' | 'zellij' | 'herdr' | 'windows_console'): TerminalHostAdapter {
  return {
    kind,
    createOrAttachHost: async () => {
      throw new Error('not used');
    },
    injectUserPrompt: async () => {
      throw new Error('not used');
    },
    interruptTurn: async () => {
      throw new Error('not used');
    },
    evaluateLiveness: async () => ({ paneAlive: true, observedAt: 0 }),
    dispose: async () => {},
  };
}

describe('resolveTerminalHost', () => {
  it('uses Herdr only when explicitly selected and available', () => {
    const result = resolveTerminalHost({
      preference: 'herdr',
      platform: { os: 'linux', arch: 'arm64' },
      adapters: { herdr: adapter('herdr'), tmux: adapter('tmux') },
      tmuxAvailable: true,
      zellijAvailable: false,
    });
    expect(result).toMatchObject({ status: 'resolved', adapter: { kind: 'herdr' } });

    expect(resolveTerminalHost({
      preference: 'herdr',
      platform: { os: 'linux', arch: 'arm64' },
      adapters: { tmux: adapter('tmux') },
      tmuxAvailable: true,
      zellijAvailable: false,
    })).toMatchObject({ status: 'disabled', reason: 'herdr_unavailable' });
  });
  it('prefers tmux on POSIX auto when tmux is available', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'darwin', arch: 'arm64' },
      adapters: { tmux: adapter('tmux'), zellij: adapter('zellij') },
      tmuxAvailable: true,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({ status: 'resolved', adapter: { kind: 'tmux' }, reason: 'tmux_available' });
  });

  it('falls back to zellij on POSIX auto when tmux is unavailable', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'linux', arch: 'x64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({ status: 'resolved', adapter: { kind: 'zellij' }, reason: 'tmux_unavailable' });
  });

  it('falls back to tmux on POSIX when zellij is selected but unavailable', () => {
    const result = resolveTerminalHost({
      preference: 'zellij',
      platform: { os: 'linux', arch: 'arm64' },
      adapters: { tmux: adapter('tmux') },
      tmuxAvailable: true,
      zellijAvailable: false,
    });

    expect(result).toMatchObject({ status: 'resolved', adapter: { kind: 'tmux' }, reason: 'zellij_unavailable_tmux_fallback' });
  });

  it('prefers a Windows console host on Windows x64 auto and disables Windows arm64', () => {
    const windowsX64 = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { windows_console: adapter('windows_console'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });
    const windowsArm64 = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(windowsX64).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_available',
    });
    expect(windowsArm64).toMatchObject({ status: 'disabled', reason: 'windows_arm64_unsupported' });
  });

  it('fails closed on Windows x64 auto when no Windows console host is available', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });
    const withoutZellij = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'x64' },
      adapters: {},
      tmuxAvailable: false,
      zellijAvailable: false,
    });

    expect(result).toMatchObject({ status: 'disabled', reason: 'windows_zellij_unvalidated' });
    expect(withoutZellij).toMatchObject({ status: 'disabled', reason: 'windows_zellij_unvalidated' });
  });

  it('uses the Windows console host on Windows arm64 auto when available', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { windows_console: adapter('windows_console'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_available',
    });
  });

  it('uses the forced Windows console host on Windows arm64 when available', () => {
    const result = resolveTerminalHost({
      preference: 'windows_console',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { windows_console: adapter('windows_console') },
      tmuxAvailable: false,
      zellijAvailable: false,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_forced',
    });
  });

  it('fails closed when zellij is forced on native Windows', () => {
    const windowsX64 = resolveTerminalHost({
      preference: 'zellij',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });
    const windowsArm64 = resolveTerminalHost({
      preference: 'zellij',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(windowsX64).toMatchObject({ status: 'disabled', reason: 'windows_zellij_unvalidated' });
    expect(windowsArm64).toMatchObject({ status: 'disabled', reason: 'windows_arm64_unsupported' });
  });

  it('rejects forced tmux on native Windows', () => {
    const platform: TerminalHostResolverPlatform = { os: 'win32', arch: 'x64' };
    expect(
      resolveTerminalHost({
        preference: 'tmux',
        platform,
        adapters: { tmux: adapter('tmux'), zellij: adapter('zellij') },
        tmuxAvailable: true,
        zellijAvailable: true,
      }),
    ).toMatchObject({ status: 'disabled', reason: 'tmux_unsupported_on_windows' });
  });
});
