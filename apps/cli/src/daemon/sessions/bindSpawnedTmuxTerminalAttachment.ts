import { createTmuxTerminalHostHandle } from '@/integrations/tmux/hostHandle';
import { bindSpawnedTerminalHostAttachment } from './bindSpawnedTerminalHostAttachment';

export async function bindSpawnedTmuxTerminalAttachment(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  tmuxSessionName: string;
  tmuxWindowId: string;
  tmuxTmpDir?: string;
  disposeUnboundHost: () => Promise<void>;
}>): Promise<void> {
  const handle = createTmuxTerminalHostHandle({
    sessionName: params.tmuxSessionName,
    windowId: params.tmuxWindowId,
    tmuxTmpDir: params.tmuxTmpDir,
    topology: 'shared',
  });
  await bindSpawnedTerminalHostAttachment({
    happyHomeDir: params.happyHomeDir,
    sessionId: params.sessionId,
    handle,
    disposeUnboundHost: params.disposeUnboundHost,
  });
}
