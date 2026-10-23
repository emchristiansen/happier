import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { hasFlag, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { setSessionFolder, type SetSessionFolderResult } from '@/session/services/setSessionFolder';
import { SetSessionFolderAssignmentRequestSchema } from '@happier-dev/protocol';

export const SESSION_SET_FOLDER_USAGE = 'happier session set-folder <session-id-or-prefix-or-tag> (<folder-id> | --none) [--json]';

const NO_FOLDER_FLAG = '--none';

/**
 * The folder is named by its id, the only folder identity the server accepts and keeps unique.
 * `--none` removes the session from its folder, the same `folderId: null` write the app sends when
 * a session is moved out of every folder.
 */
function parseTargetFolderId(argv: readonly string[]): Readonly<{ idOrPrefix: string; folderId: string | null }> {
  const positionals = readCommandPositionals(argv, { startIndex: 1 });
  const noFolder = hasFlag(argv, NO_FOLDER_FLAG);
  const [idOrPrefix = '', folder = '', ...extra] = positionals;
  const hasFolder = folder.length > 0;
  if (!idOrPrefix || extra.length > 0 || hasFolder === noFolder) {
    throw new Error(`Usage: ${SESSION_SET_FOLDER_USAGE}`);
  }
  if (noFolder) return { idOrPrefix, folderId: null };

  const parsed = SetSessionFolderAssignmentRequestSchema.safeParse({ folderId: folder });
  if (!parsed.success || parsed.data.folderId === null) {
    throw new Error(`Invalid folder id: ${folder}`);
  }
  return { idOrPrefix, folderId: parsed.data.folderId };
}

function describeFolder(folderId: string | null): string {
  return folderId === null ? 'no folder' : `folder ${folderId}`;
}

type SetSessionFolderFailure = Extract<SetSessionFolderResult, { ok: false }>;

function describeFailure(result: SetSessionFolderFailure): Readonly<{ message?: string; details?: Record<string, unknown> }> {
  switch (result.code) {
    case 'folder_not_found':
      return {
        message: `Folder ${result.folderId} is not an active folder of this account; session ${result.sessionId} was not moved.`,
        details: { sessionId: result.sessionId, folderId: result.folderId, serverError: result.serverError },
      };
    case 'readback_mismatch':
      return {
        message: `Session ${result.sessionId} was asked to move to ${describeFolder(result.requestedFolderId)}, `
          + `but the server reports ${describeFolder(result.readbackFolderId)}.`,
        details: {
          sessionId: result.sessionId,
          requestedFolderId: result.requestedFolderId,
          assignedFolderId: result.assignedFolderId,
          readbackFolderId: result.readbackFolderId,
        },
      };
    case 'unsupported':
      return {
        message: 'The server does not serve session folder assignments (the sessions.folders feature is disabled or unavailable).',
        details: { serverError: result.serverError ?? null },
      };
    case 'session_not_found':
      return result.serverError ? { details: { serverError: result.serverError } } : {};
    case 'session_id_ambiguous':
    case 'session_lookup_timeout':
      return {};
  }
}

export async function cmdSessionSetFolder(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const { idOrPrefix, folderId } = parseTargetFolderId(argv);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_set_folder', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const result = await setSessionFolder({ credentials, idOrPrefix, folderId });
  if (!result.ok) {
    const { message, details } = describeFailure(result);
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_set_folder',
        error: {
          code: result.code,
          ...('candidates' in result && result.candidates ? { candidates: result.candidates } : {}),
          ...(message ? { message } : {}),
          ...(details ? { details } : {}),
        },
      });
      return;
    }
    throw new Error(message ? `${result.code}: ${message}` : result.code);
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_set_folder',
      data: {
        sessionId: result.sessionId,
        folderId: result.folderId,
        readback: { folderId: result.readbackFolderId },
      },
    });
    return;
  }
  console.log(chalk.green('✓'), `${result.sessionId} is in ${describeFolder(result.readbackFolderId)} (read back from the server)`);
}
