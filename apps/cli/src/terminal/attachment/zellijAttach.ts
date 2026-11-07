import { configuration } from '@/configuration';
import {
  defaultZellijAttachActions,
  type ZellijAttachActions,
} from '@/integrations/zellij/actions';
import { resolveZellijRuntimeBinary } from '@/integrations/zellij/runtimeBinary';
import { prepareZellijSocketDir, resolveZellijSocketDir } from '@/integrations/zellij/socketDir';
import {
  resolveZellijWindowsGuard,
  type ZellijWindowsGuardResult,
} from '@/integrations/zellij/zellijWindowsGuards';

import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';
import { createTerminalAttachPlan } from './terminalAttachPlan';
import { fail } from '@happier-dev/cli-common/output';

async function bestEffortFocusPaneBeforeAttach(params: Readonly<{
  actions: ZellijAttachActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  timeoutMs: number;
}>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const focus = Promise.resolve()
    .then(() => params.actions.focusPane({
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      timeoutMs: params.timeoutMs,
    }))
    .catch(() => {});
  try {
    await Promise.race([
      focus,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, params.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runZellijAttach(
  params: Readonly<{
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }>,
  deps: Readonly<{
    resolveZellijBinaryFn?: () => Promise<string | null>;
    resolveWindowsGuardFn?: () => ZellijWindowsGuardResult;
    actions?: ZellijAttachActions;
    happyHomeDir?: string;
    prepareSocketDirFn?: ((socketDir: string) => Promise<void>) | undefined;
  }> = {},
): Promise<number> {
  const plan = createTerminalAttachPlan({
    terminal: params.terminal,
    insideTmux: false,
  });
  if (plan.type !== 'zellij') {
    const reason = plan.type === 'not-attachable'
      ? plan.reason
      : 'Session is not backed by a zellij terminal host.';
    console.error(fail(reason));
    return 1;
  }

  const resolveZellijBinaryFn = deps.resolveZellijBinaryFn ?? resolveZellijRuntimeBinary;
  const zellijBinary = await resolveZellijBinaryFn();
  if (!zellijBinary) {
    console.error(fail('Bundled zellij is unavailable; cannot attach to this terminal-hosted session.'));
    return 1;
  }

  const windowsGuard = (deps.resolveWindowsGuardFn ?? (() => resolveZellijWindowsGuard({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  })))();
  if (windowsGuard.status === 'disabled') {
    console.error(fail(windowsGuard.message));
    return 1;
  }

  const actions = deps.actions ?? defaultZellijAttachActions;
  const attachEnv = {
    ZELLIJ_SOCKET_DIR: resolveZellijSocketDir(deps.happyHomeDir ?? configuration.happyHomeDir),
  };
  await (deps.prepareSocketDirFn ?? prepareZellijSocketDir)(attachEnv.ZELLIJ_SOCKET_DIR);
  const actionEnv = {
    ...attachEnv,
    ZELLIJ_SESSION_NAME: plan.sessionName,
  };

  if (plan.paneId) {
    await bestEffortFocusPaneBeforeAttach({
      actions,
      zellijBinary,
      env: actionEnv,
      paneId: plan.paneId,
      timeoutMs: Math.max(1, Math.trunc(configuration.claudeUnifiedTerminalHostActionTimeoutMs)),
    });
  }

  const result = await actions.attachForeground({
    zellijBinary,
    env: attachEnv,
    sessionName: plan.sessionName,
  });
  if (result.exitCode !== 0) {
    console.error(fail(result.stderr || result.stdout || `zellij attach exited with ${result.exitCode}.`));
  }
  return result.exitCode;
}
