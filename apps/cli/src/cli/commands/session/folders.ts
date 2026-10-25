import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { listSessionFolders, type ListedSessionFolder } from '@/session/services/listSessionFolders';

export const SESSION_FOLDERS_USAGE = 'happier session folders [--session <session-id-or-prefix-or-tag>] [--json]';

const SESSION_FLAG = '--session';

/**
 * `--session` names one session whose current folder is reported alongside the listing, so a caller
 * (for example a fork copying its predecessor's folder) gets the folder id from the same read.
 */
function parseFoldersArgs(argv: readonly string[]): Readonly<{ sessionIdOrPrefix: string | null }> {
  const positionals = readCommandPositionals(argv, { startIndex: 1, valueFlags: [SESSION_FLAG] });
  if (positionals.length > 0) {
    throw new Error(`Usage: ${SESSION_FOLDERS_USAGE}`);
  }
  if (!hasFlag(argv, SESSION_FLAG)) return { sessionIdOrPrefix: null };
  const sessionIdOrPrefix = readFlagValue(argv, SESSION_FLAG);
  if (sessionIdOrPrefix === null || sessionIdOrPrefix.startsWith('-')) {
    throw new Error(`Usage: ${SESSION_FOLDERS_USAGE}`);
  }
  return { sessionIdOrPrefix };
}

function describeName(folder: ListedSessionFolder): string {
  return folder.nameShown ? folder.name : chalk.gray(`(name not shown: ${folder.nameNotShownReason})`);
}

function describeFolderLine(folder: ListedSessionFolder): string {
  const parent = folder.parentFolderId ? ` ${chalk.gray(`parent ${folder.parentFolderId}`)}` : '';
  const workspace = folder.workspace ? ` ${chalk.gray(`${folder.workspace.machineId}:${folder.workspace.rootPath}`)}` : '';
  return `${folder.folderId} ${describeName(folder)}${parent}${workspace}`;
}

export async function cmdSessionFolders(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const { sessionIdOrPrefix } = parseFoldersArgs(argv);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_folders', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const result = await listSessionFolders({ credentials, sessionIdOrPrefix });
  if (!result.ok) {
    const message = result.code === 'unsupported'
      ? 'The server does not serve the session organization snapshot (it predates session folders).'
      : undefined;
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_folders',
        error: {
          code: result.code,
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(message ? { message } : {}),
          ...(result.code === 'unsupported' ? { details: { serverError: result.serverError ?? null } } : {}),
        },
      });
      return;
    }
    throw new Error(message ? `${result.code}: ${message}` : result.code);
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_folders',
      data: {
        folders: result.folders,
        ...(result.session ? { session: result.session } : {}),
      },
    });
    return;
  }

  if (result.session) {
    const where = result.session.folderId === null ? 'no folder' : `folder ${result.session.folderId}`;
    console.log(`${result.session.sessionId} is in ${where}`);
  }
  if (result.folders.length === 0) {
    console.log(chalk.gray('No folders.'));
    return;
  }
  for (const folder of result.folders) {
    console.log(describeFolderLine(folder));
  }
}
