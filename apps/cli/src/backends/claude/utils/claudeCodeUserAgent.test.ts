import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, resolveProviderCliLaunchSpecMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  resolveProviderCliLaunchSpecMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  resolveProviderCliLaunchSpec: resolveProviderCliLaunchSpecMock,
}));

import {
  DEFAULT_CLAUDE_CODE_USER_AGENT,
  parseClaudeCodeVersionForUserAgent,
  resetClaudeCodeUserAgentCacheForTests,
  resolveClaudeCodeUserAgent,
} from './claudeCodeUserAgent';

describe('resolveClaudeCodeUserAgent', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveProviderCliLaunchSpecMock.mockReset();
    resetClaudeCodeUserAgentCacheForTests();
  });

  it('parses Claude Code version output into a user-agent version', () => {
    expect(parseClaudeCodeVersionForUserAgent('2.1.138 (Claude Code)\n')).toBe('2.1.138');
    expect(parseClaudeCodeVersionForUserAgent('claude version 1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(parseClaudeCodeVersionForUserAgent('Claude Code')).toBeNull();
  });

  it('uses the installed Claude CLI version when no explicit user-agent is configured', () => {
    resolveProviderCliLaunchSpecMock.mockReturnValue({
      source: 'path',
      resolvedPath: '/usr/local/bin/claude',
      command: '/usr/local/bin/claude',
      args: [],
    });
    execFileSyncMock.mockReturnValue('2.1.138 (Claude Code)\n');

    expect(resolveClaudeCodeUserAgent()).toBe('claude-cli/2.1.138 (external, cli)');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['--version'],
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    );
  });

  it('preserves launch args and caches the resolved version', () => {
    resolveProviderCliLaunchSpecMock.mockReturnValue({
      source: 'path',
      resolvedPath: '/opt/claude/cli.js',
      command: '/managed/js-runtime',
      args: ['/opt/claude/cli.js'],
    });
    execFileSyncMock.mockReturnValue('3.0.0\n');

    expect(resolveClaudeCodeUserAgent()).toBe('claude-cli/3.0.0 (external, cli)');
    expect(resolveClaudeCodeUserAgent()).toBe('claude-cli/3.0.0 (external, cli)');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      '/managed/js-runtime',
      ['/opt/claude/cli.js', '--version'],
      expect.anything(),
    );
  });

  it('uses an explicit override without probing the CLI', () => {
    expect(resolveClaudeCodeUserAgent('claude-code/custom')).toBe('claude-code/custom');
    expect(resolveProviderCliLaunchSpecMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to the safe Claude Code user-agent when probing is unavailable', () => {
    resolveProviderCliLaunchSpecMock.mockReturnValue(null);
    expect(resolveClaudeCodeUserAgent()).toBe(DEFAULT_CLAUDE_CODE_USER_AGENT);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
