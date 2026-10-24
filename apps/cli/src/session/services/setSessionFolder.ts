import type { Credentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import {
  fetchSessionFolderAssignment,
  putSessionFolderAssignment,
} from '@/session/transport/http/sessionFolderAssignmentsHttp';

export type SetSessionFolderResult =
  | Readonly<{ ok: true; sessionId: string; folderId: string | null; readbackFolderId: string | null }>
  | Readonly<{
    ok: false;
    code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported';
    candidates?: string[];
    serverError?: string | null;
  }>
  | Readonly<{ ok: false; code: 'folder_not_found'; sessionId: string; folderId: string; serverError: string | null }>
  | Readonly<{
    ok: false;
    code: 'readback_mismatch';
    sessionId: string;
    requestedFolderId: string | null;
    assignedFolderId: string | null;
    readbackFolderId: string | null;
  }>;

/**
 * Moves one session into a folder (or out of every folder when `folderId` is `null`) and reads the
 * assignment back, so the caller learns what the server holds after the write rather than what it
 * acknowledged.
 */
export async function setSessionFolder(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  folderId: string | null;
}>): Promise<SetSessionFolderResult> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }
  const sessionId = resolved.sessionId;

  const put = await putSessionFolderAssignment({
    token: params.credentials.token,
    sessionId,
    folderId: params.folderId,
  });
  if (!put.ok) {
    if (put.code === 'folder_not_found') {
      if (params.folderId === null) {
        // Clearing an assignment names no folder, so the server has no folder to reject.
        throw new Error(`The server rejected removing session ${sessionId} from its folder: ${put.serverError ?? 'no error body'}`);
      }
      return {
        ok: false,
        code: 'folder_not_found',
        sessionId,
        folderId: params.folderId,
        serverError: put.serverError,
      };
    }
    return { ok: false, code: put.code, serverError: put.serverError };
  }

  let readback: Awaited<ReturnType<typeof fetchSessionFolderAssignment>>;
  try {
    readback = await fetchSessionFolderAssignment({ token: params.credentials.token, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `The server accepted folder ${put.assignment.folderId ?? '(none)'} for session ${sessionId}, `
          + `but reading the assignment back failed: ${message}`,
      ),
      typeof (error as { code?: unknown } | null)?.code === 'string' ? { code: (error as { code: string }).code } : {},
    );
  }

  if (put.assignment.folderId !== params.folderId || readback.folderId !== params.folderId) {
    return {
      ok: false,
      code: 'readback_mismatch',
      sessionId,
      requestedFolderId: params.folderId,
      assignedFolderId: put.assignment.folderId,
      readbackFolderId: readback.folderId,
    };
  }

  return { ok: true, sessionId, folderId: put.assignment.folderId, readbackFolderId: readback.folderId };
}
