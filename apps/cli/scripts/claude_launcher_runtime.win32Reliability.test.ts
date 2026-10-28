import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeBinarySpawnInvocation } from '../scripts/claude_launcher_runtime.cjs';

describe('claude_launcher_runtime buildClaudeBinarySpawnInvocation', () => {
  const originalForceViaComspec = process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC;

  afterEach(() => {
    if (originalForceViaComspec === undefined) {
      delete process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC;
    } else {
      process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC = originalForceViaComspec;
    }
  });

  it('wraps cmd shims with ComSpec on Windows', () => {
    const inv = buildClaudeBinarySpawnInvocation({
      platform: 'win32',
      cliPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--print', 'hello'],
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(inv).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      providerIsChild: false,
      args: ['/d', '/s', '/c', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', '--print', 'hello'],
    });
  });

  it('can force ComSpec wrapping for executables on Windows', () => {
    process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC = '1';

    const inv = buildClaudeBinarySpawnInvocation({
      platform: 'win32',
      cliPath: 'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe',
      args: ['--version'],
      comspec: 'cmd.exe',
    });

    expect(inv).toEqual({
      command: 'cmd.exe',
      providerIsChild: false,
      args: ['/d', '/s', '/c', 'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe', '--version'],
    });
  });

  it('spawns binaries directly on non-Windows platforms', () => {
    const inv = buildClaudeBinarySpawnInvocation({
      platform: 'darwin',
      cliPath: '/opt/homebrew/bin/claude',
      args: ['--version'],
    });

    expect(inv).toEqual({
      command: '/opt/homebrew/bin/claude',
      providerIsChild: true,
      args: ['--version'],
    });
  });
});
