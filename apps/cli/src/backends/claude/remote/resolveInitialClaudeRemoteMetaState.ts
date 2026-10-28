import { applyClaudeRemoteMetaState, DEFAULT_CLAUDE_REMOTE_META_STATE, type ClaudeRemoteMetaState } from './claudeRemoteMetaState';

export function readDaemonClaudeUnifiedTerminalPin(startedBy: 'daemon' | 'terminal' | undefined, env: NodeJS.ProcessEnv): boolean | null {
  if (startedBy !== 'daemon') return null;
  if (env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN === '1') return true;
  if (env.HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN === '0') return false;
  return null;
}

export function pinClaudeUnifiedTerminalSelection(state: ClaudeRemoteMetaState, pinned: boolean | null): ClaudeRemoteMetaState {
  return pinned === null || state.claudeUnifiedTerminalEnabled === pinned
    ? state
    : { ...state, claudeUnifiedTerminalEnabled: pinned };
}

export function resolveInitialClaudeRemoteMetaState(params: Readonly<{
  metaDefaults?: Record<string, unknown> | null;
  requestedTerminalHost?: string;
  pinnedUnifiedTerminalEnabled?: boolean | null;
}>): typeof DEFAULT_CLAUDE_REMOTE_META_STATE {
  const initial = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, params.metaDefaults ?? {});
  const selected: ClaudeRemoteMetaState = params.requestedTerminalHost === 'tmux'
    || params.requestedTerminalHost === 'zellij'
    || params.requestedTerminalHost === 'herdr'
    ? { ...initial, claudeUnifiedTerminalHost: params.requestedTerminalHost }
    : initial;
  return pinClaudeUnifiedTerminalSelection(selected, params.pinnedUnifiedTerminalEnabled ?? null);
}
