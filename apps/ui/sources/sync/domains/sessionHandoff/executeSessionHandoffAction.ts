import type {
  ActionExecuteResult,
  ActionExecutorContext,
  SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;

type ExecuteSessionHandoffActionArgs = Readonly<{
  execute: ExecuteAction;
  sessionId: string;
  targetMachineId: string;
  targetPath?: string;
  targetSessionStorageMode?: 'direct' | 'persisted';
  stateTransfer?: 'transfer' | 'existing';
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  context: ActionExecutorContext;
}>;

type ExecuteSessionHandoffActionResult =
  | Readonly<{ ok: true; handoffId: string }>
  | Readonly<{ ok: false; error: string; errorCode?: string; recovery?: unknown }>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function executeSessionHandoffAction(
  args: ExecuteSessionHandoffActionArgs,
): Promise<ExecuteSessionHandoffActionResult> {
  const actionResult = await args.execute(
    'session.handoff',
    {
      sessionId: args.sessionId,
      targetMachineId: args.targetMachineId,
      ...(args.targetPath ? { targetPath: args.targetPath } : {}),
      ...(args.targetSessionStorageMode ? { targetSessionStorageMode: args.targetSessionStorageMode } : {}),
      ...(args.stateTransfer ? { stateTransfer: args.stateTransfer } : {}),
      ...(args.workspaceTransfer ? { workspaceTransfer: args.workspaceTransfer } : {}),
    },
    args.context,
  );
  if (!actionResult.ok) {
    return {
      ok: false,
      error: normalizeNonEmptyString(actionResult.error) ?? 'failed_to_start_session_handoff',
      ...(actionResult.errorCode ? { errorCode: actionResult.errorCode } : {}),
    };
  }

  const handoffResult = actionResult.result && typeof actionResult.result === 'object'
    ? actionResult.result as Record<string, unknown>
    : null;
  if (handoffResult?.ok !== true) {
    const errorCode = normalizeNonEmptyString(handoffResult?.errorCode);
    return {
      ok: false,
      ...(errorCode ? { errorCode } : {}),
      error:
        normalizeNonEmptyString(handoffResult?.errorMessage)
        ?? normalizeNonEmptyString(handoffResult?.error)
        ?? 'failed_to_start_session_handoff',
      ...(handoffResult?.recovery ? { recovery: handoffResult.recovery } : {}),
    };
  }

  const handoffId = normalizeNonEmptyString(handoffResult?.handoffId);
  if (!handoffId) {
    return { ok: false, error: 'failed_to_start_session_handoff' };
  }

  return { ok: true, handoffId };
}
