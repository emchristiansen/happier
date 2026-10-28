import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';
import { runTmuxAttach } from './tmuxAttach';
import { runZellijAttach } from './zellijAttach';
import { runHerdrAttach } from './herdrAttach';

type Terminal = NonNullable<TerminalAttachmentInfo['terminal']>;

export type TerminalHostAttachRunners = Readonly<{
  runTmuxAttachFn?: typeof runTmuxAttach;
  runZellijAttachFn?: typeof runZellijAttach;
  runHerdrAttachFn?: typeof runHerdrAttach;
}>;

/** The one dispatch for local terminal-host attachment, including foreground startup. */
export async function runTerminalHostAttach(
  params: Readonly<{ sessionId: string; terminal: Terminal; refreshRemoteControl?: boolean }>,
  runners: TerminalHostAttachRunners = {},
): Promise<number | null> {
  if (params.terminal.mode === 'tmux') {
    return await (runners.runTmuxAttachFn ?? runTmuxAttach)({
      sessionId: params.sessionId,
      terminal: params.terminal,
      ...(params.refreshRemoteControl ? { refreshRemoteControl: true } : {}),
    });
  }
  if (params.terminal.mode === 'zellij') {
    return await (runners.runZellijAttachFn ?? runZellijAttach)({
      sessionId: params.sessionId,
      terminal: params.terminal,
    });
  }
  if (params.terminal.mode === 'herdr') {
    return await (runners.runHerdrAttachFn ?? runHerdrAttach)({ terminal: params.terminal });
  }
  return null;
}
