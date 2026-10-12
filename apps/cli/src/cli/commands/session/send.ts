import chalk from 'chalk';

import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { PermissionIntent } from '@happier-dev/agents';
import { readPendingLocalId } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readIntFlagValue, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { cmd, fail } from '@happier-dev/cli-common/output';

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

export async function cmdSessionSend(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', message = ''] = readCommandPositionals(argv, {
    startIndex: 1,
    valueFlags: ['--permission-mode', '--model', '--timeout', '--local-id'],
  });
  const wait = hasFlag(argv, '--wait');
  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout', { min: 1 });
  const permissionModeFlag = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const modelFlagRaw = readFlagValue(argv, '--model');
  const optionTerminatorIndex = argv.indexOf('--');
  const localIdFlagIndex = argv.slice(0, optionTerminatorIndex < 0 ? argv.length : optionTerminatorIndex).indexOf('--local-id');
  const localIdRaw = localIdFlagIndex >= 0 ? argv[localIdFlagIndex + 1] : undefined;
  const localId = readPendingLocalId(localIdRaw);
  if (localIdFlagIndex >= 0 && (
    localId === null
    || localId.startsWith('-')
  )) {
    const err = new Error('Invalid --local-id');
    (err as Error & { code?: string }).code = 'invalid_arguments';
    throw err;
  }
  const hasModelFlag = modelFlagRaw !== null;
  const modelFlag = typeof modelFlagRaw === 'string' ? modelFlagRaw.trim() : '';
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  if (!idOrPrefix || !message) {
    throw new Error('Usage: happier session send <session-id-or-prefix> <message> [--local-id <id>] [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exit(1);
  }

  const permissionModeOverride = permissionModeFlag ? parsePermissionIntentOrThrow(permissionModeFlag) : undefined;
  const modelOverride =
    hasModelFlag
      ? (() => {
          if (!modelFlag) {
            const err = new Error('Invalid --model');
            (err as any).code = 'invalid_arguments';
            throw err;
          }
          return modelFlag === 'default' ? null : modelFlag;
        })()
      : undefined;

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.message.send',
    {
      sessionId: idOrPrefix,
      message,
      ...(localId !== null ? { localId } : {}),
      ...(permissionModeOverride ? { permissionModeOverride } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(wait ? { wait: true } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  if (!actionRes.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_send',
        error: {
          code: actionRes.errorCode,
          ...(actionRes.error ? { message: actionRes.error } : {}),
        },
      });
      return;
    }
    throw new Error(actionRes.errorCode);
  }

  const result = (actionRes as any).result as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_send', json, result })) {
    return;
  }
  if (result && typeof result === 'object' && result.ok === false) {
    const code = typeof result.errorCode === 'string' ? result.errorCode : typeof result.code === 'string' ? result.code : 'action_failed';
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_send',
        error: {
          code,
          ...(Array.isArray(result.candidates) ? { candidates: result.candidates } : {}),
          ...(typeof result.message === 'string' && result.message.trim().length > 0 ? { message: result.message } : {}),
        },
      });
      return;
    }
    throw new Error(code);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_send', data: { sessionId: result.sessionId, localId: result.localId, waited: result.waited } });
    return;
  }

  console.log(chalk.green('✓'), 'message sent');
  await writeJsonStdout({ sessionId: result.sessionId, localId: result.localId }, { pretty: true });
}
