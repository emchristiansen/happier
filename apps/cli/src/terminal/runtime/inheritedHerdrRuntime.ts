import { configuration } from '@/configuration';
import { createHerdrClient } from '@/integrations/herdr/client';
import { resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';
import { createTerminalAttachmentId } from '@/terminal/attachment/terminalAttachmentInfo';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

export async function resolveInheritedHerdrRuntime(params: Readonly<{
  terminalRuntime: TerminalRuntimeFlags | null;
  env: NodeJS.ProcessEnv;
}>): Promise<TerminalRuntimeFlags | null> {
  if (params.terminalRuntime?.mode && params.terminalRuntime.mode !== 'herdr') {
    return params.terminalRuntime;
  }
  const socketPath = params.env.HERDR_SOCKET_PATH?.trim();
  const paneId = params.env.HERDR_PANE_ID?.trim();
  if (params.env.HERDR_ENV !== '1' || !socketPath || !paneId) {
    if (params.terminalRuntime?.mode === 'herdr') {
      throw new Error('Herdr terminal mode requires a live Herdr pane context');
    }
    return params.terminalRuntime;
  }

  const actionTimeoutMs = configuration.claudeUnifiedTerminalHostActionTimeoutMs;
  const binary = await resolveHerdrRuntimeBinary({ actionTimeoutMs });
  if (!binary) throw new Error('A supported Herdr installation is required for this terminal session');
  const client = createHerdrClient({
    binary,
    sessionName: 'default',
    socketPath,
    actionTimeoutMs,
    startupTimeoutMs: actionTimeoutMs,
  });
  await client.assertServerVersion();
  let sessionName = params.terminalRuntime?.herdrSessionName?.trim();
  if (!sessionName) {
    // The successful snapshot above is the authoritative live-socket probe.
    // The inventory is needed only when a foreground wrapper was typed into an
    // existing pane and no launch owner could carry the session name.
    const session = (await client.listSessions()).find((item) => item.socketPath === socketPath);
    if (!session) throw new Error('The current Herdr session is unavailable');
    sessionName = session.name;
  }
  const pane = await client.getPane(paneId);
  // Keep the socket/pane identity for Happier, but stop native provider hooks in
  // managed children from claiming this pane with a provider-native resume plan.
  // Herdr reinjects HERDR_ENV into new panes; provider subprocess launch also
  // strips it at the child boundary.
  delete params.env.HERDR_ENV;
  return {
    ...params.terminalRuntime,
    mode: 'herdr',
    requested: 'herdr',
    herdrSessionName: sessionName,
    herdrSocketPath: socketPath,
    herdrTerminalId: pane.terminalId,
    herdrPaneId: pane.paneId,
    attachmentId: params.terminalRuntime?.attachmentId?.trim()
      || params.env.HAPPIER_TERMINAL_ATTACHMENT_ID?.trim()
      || createTerminalAttachmentId(),
  };
}
