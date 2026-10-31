import { describe, expect, it } from 'vitest';

import { pinClaudeUnifiedTerminalSelection, readDaemonClaudeUnifiedTerminalPin, resolveInitialClaudeRemoteMetaState } from './resolveInitialClaudeRemoteMetaState';

describe('resolveInitialClaudeRemoteMetaState', () => {
  it('only consumes a daemon-owned runtime pin for daemon starts', () => {
    expect(readDaemonClaudeUnifiedTerminalPin('daemon', { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' })).toBe(true);
    expect(readDaemonClaudeUnifiedTerminalPin('daemon', { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '0' })).toBe(false);
    expect(readDaemonClaudeUnifiedTerminalPin('terminal', { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' })).toBeNull();
  });

  it('keeps the daemon-selected runtime family when later message settings disagree', () => {
    const initial = resolveInitialClaudeRemoteMetaState({
      metaDefaults: { claudeUnifiedTerminalEnabled: false },
      pinnedUnifiedTerminalEnabled: true,
    });
    expect(initial.claudeUnifiedTerminalEnabled).toBe(true);
    expect(pinClaudeUnifiedTerminalSelection({ ...initial, claudeUnifiedTerminalEnabled: false }, true).claudeUnifiedTerminalEnabled).toBe(true);
    expect(pinClaudeUnifiedTerminalSelection({ ...initial, claudeUnifiedTerminalEnabled: true }, false).claudeUnifiedTerminalEnabled).toBe(false);
  });

  it('honors the selected session terminal host for unified Claude', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: { claudeUnifiedTerminalEnabled: true, claudeUnifiedTerminalHost: 'tmux' },
      requestedTerminalHost: 'herdr',
    });
    expect(resolved.claudeUnifiedTerminalHost).toBe('herdr');
  });

  it('defaults to Agent SDK enabled when account defaults omit the flag', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {},
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    // Default should be enabled unless explicitly disabled by user settings.
    expect(resolved.claudeLocalPermissionBridgeEnabled).toBe(true);
  });

  it('seeds claude remote meta state from account defaults', () => {
    const resolved = resolveInitialClaudeRemoteMetaState({
      metaDefaults: {
        claudeRemoteAgentSdkEnabled: true,
        claudeRemoteSettingSourcesV2: ['user', 'project'],
        claudeLocalPermissionBridgeEnabled: true,
        claudeLocalPermissionBridgeWaitIndefinitely: true,
        claudeLocalPermissionBridgeTimeoutSeconds: 600,
        claudeRemoteAdvancedOptionsJson: '{"plugins":[]}',
      },
    });

    expect(resolved.claudeRemoteAgentSdkEnabled).toBe(true);
    expect((resolved as any).claudeRemoteSettingSourcesV2).toEqual(['user', 'project']);
    expect((resolved as any).claudeLocalPermissionBridgeEnabled).toBe(true);
    expect((resolved as any).claudeLocalPermissionBridgeWaitIndefinitely).toBe(true);
    expect((resolved as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(600);
    // Normalized by applyClaudeRemoteMetaState.
    expect(resolved.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');
  });
});
