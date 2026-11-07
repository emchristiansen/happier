import type {
  TerminalHostAdapter,
  TerminalHostPreference,
  TerminalHostResolution,
  TerminalHostResolverPlatform,
} from './_types';

export function resolveTerminalHost(params: Readonly<{
  preference: TerminalHostPreference;
  platform: TerminalHostResolverPlatform;
  adapters: Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;
  tmuxAvailable: boolean;
  zellijAvailable: boolean;
}>): TerminalHostResolution {
  const { preference, platform, adapters } = params;

  if (preference === 'herdr') {
    if (platform.os === 'win32') {
      return {
        status: 'disabled',
        reason: 'herdr_attach_unsupported_on_windows',
        message: 'Herdr direct terminal attach is unavailable on native Windows; use WSL2.',
      };
    }
    if (!adapters.herdr) {
      return { status: 'disabled', reason: 'herdr_unavailable', message: 'A supported Herdr installation is required.' };
    }
    return { status: 'resolved', adapter: adapters.herdr, reason: 'herdr_forced' };
  }

  if (preference === 'tmux') {
    if (platform.os === 'win32') {
      return {
        status: 'disabled',
        reason: 'tmux_unsupported_on_windows',
        message: "tmux is not supported on native Windows; use 'auto' or 'zellij', or install WSL2.",
      };
    }
    if (!params.tmuxAvailable || !adapters.tmux) {
      return { status: 'disabled', reason: 'tmux_unavailable', message: 'tmux is required for the selected terminal host.' };
    }
    return { status: 'resolved', adapter: adapters.tmux, reason: 'tmux_forced' };
  }

  if (preference === 'zellij') {
    if (platform.os === 'win32') {
      if (platform.arch === 'arm64') {
        return {
          status: 'disabled',
          reason: 'windows_arm64_unsupported',
          message: 'Bundled zellij has no upstream Windows ARM64 binary; install WSL2 or use Agent SDK runner.',
        };
      }
      return {
        status: 'disabled',
        reason: 'windows_zellij_unvalidated',
        message: 'Bundled zellij is not validated on native Windows; use auto with the Windows console host or install WSL2.',
      };
    }
    if (!params.zellijAvailable || !adapters.zellij) {
      if (params.tmuxAvailable && adapters.tmux) {
        return { status: 'resolved', adapter: adapters.tmux, reason: 'zellij_unavailable_tmux_fallback' };
      }
      return { status: 'disabled', reason: 'zellij_unavailable', message: 'Bundled zellij is unavailable.' };
    }
    return { status: 'resolved', adapter: adapters.zellij, reason: 'zellij_forced' };
  }

  if (preference === 'windows_console') {
    if (!adapters.windows_console) {
      return {
        status: 'disabled',
        reason: 'windows_console_unavailable',
        message: 'Windows console terminal host is unavailable.',
      };
    }
    return { status: 'resolved', adapter: adapters.windows_console, reason: 'windows_console_forced' };
  }

  if (platform.os === 'win32') {
    if (adapters.windows_console) {
      return { status: 'resolved', adapter: adapters.windows_console, reason: 'windows_console_available' };
    }
    if (platform.arch === 'arm64') {
      return {
        status: 'disabled',
        reason: 'windows_arm64_unsupported',
        message: 'Bundled zellij has no upstream Windows ARM64 binary; install WSL2 or use Agent SDK runner.',
      };
    }
    return {
      status: 'disabled',
      reason: 'windows_zellij_unvalidated',
      message: 'Bundled zellij is not validated on native Windows; use the Windows console host or install WSL2.',
    };
  }

  if (params.tmuxAvailable && adapters.tmux) {
    return { status: 'resolved', adapter: adapters.tmux, reason: 'tmux_available' };
  }

  if (params.zellijAvailable && adapters.zellij) {
    return { status: 'resolved', adapter: adapters.zellij, reason: 'tmux_unavailable' };
  }

  return { status: 'disabled', reason: 'no_host_available', message: 'No supported terminal host is available.' };
}
