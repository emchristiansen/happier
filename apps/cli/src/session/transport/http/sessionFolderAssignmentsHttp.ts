import axios from 'axios';
import {
  SessionOrganizationSnapshotResponseSchema,
  SetSessionFolderAssignmentResponseSchema,
  type SessionOrganizationFolder,
  type SessionOrganizationSnapshot,
  type SetSessionFolderAssignmentResponse,
} from '@happier-dev/protocol';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

const SESSION_ORGANIZATION_ROUTE = '/v2/session-organization';

/**
 * Outcome of `PUT /v2/session-organization/folder-assignments/:sessionId`.
 *
 * The server answers an unknown or archived folder with 400 `invalid-session-folder-assignment`;
 * the request body is validated against the same protocol schema before it is sent, so that 400 can
 * only mean the folder is not an active folder of this account. A 404 carrying `Session not found`
 * means the session is not visible to this account; any other 404 means the server does not serve
 * the route (the `sessions.folders` feature is disabled, or the server predates it).
 */
export type PutSessionFolderAssignmentResult =
  | Readonly<{ ok: true; assignment: SetSessionFolderAssignmentResponse }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'folder_not_found' | 'unsupported'; serverError: string | null }>;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function readServerError(data: unknown): string | null {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return null;
}

export async function putSessionFolderAssignment(params: Readonly<{
  token: string;
  sessionId: string;
  folderId: string | null;
}>): Promise<PutSessionFolderAssignmentResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const path = `${SESSION_ORGANIZATION_ROUTE}/folder-assignments/${encodeURIComponent(params.sessionId)}`;
  const response = await axios.put(
    `${serverUrl}${path}`,
    { folderId: params.folderId },
    {
      headers: authHeaders(params.token),
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throw createHttpStatusError(response.status, `Unauthorized (${response.status})`, 'not_authenticated');
  }
  const serverError = readServerError(response.data);
  if (response.status === 404) {
    return {
      ok: false,
      code: serverError === 'Session not found' ? 'session_not_found' : 'unsupported',
      serverError,
    };
  }
  if (response.status === 400 && serverError === 'invalid-session-folder-assignment') {
    return { ok: false, code: 'folder_not_found', serverError };
  }
  if (response.status !== 200) {
    throw createHttpStatusError(response.status, `Unexpected status from PUT ${path}: ${response.status}`);
  }

  const parsed = SetSessionFolderAssignmentResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Unexpected PUT ${path} response shape`);
  }
  return { ok: true, assignment: parsed.data };
}

type SessionOrganizationSnapshotReadResult =
  | Readonly<{ ok: true; snapshot: SessionOrganizationSnapshot }>
  | Readonly<{ ok: false; code: 'unsupported'; serverError: string | null }>;

/**
 * `GET /v2/session-organization` with the given query. A 404 means the server does not serve the
 * organization snapshot at all (it predates session organization).
 */
async function getSessionOrganizationSnapshot(params: Readonly<{
  token: string;
  query: URLSearchParams;
}>): Promise<SessionOrganizationSnapshotReadResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const path = `${SESSION_ORGANIZATION_ROUTE}?${params.query.toString()}`;
  const response = await axios.get(`${serverUrl}${path}`, {
    headers: authHeaders(params.token),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createHttpStatusError(response.status, `Unauthorized (${response.status})`, 'not_authenticated');
  }
  if (response.status === 404) {
    return { ok: false, code: 'unsupported', serverError: readServerError(response.data) };
  }
  if (response.status !== 200) {
    throw createHttpStatusError(response.status, `Unexpected status from GET ${SESSION_ORGANIZATION_ROUTE}: ${response.status}`);
  }

  const parsed = SessionOrganizationSnapshotResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Unexpected GET ${SESSION_ORGANIZATION_ROUTE} response shape`);
  }
  return { ok: true, snapshot: parsed.data.snapshot };
}

function readSingleFolderAssignment(
  snapshot: SessionOrganizationSnapshot,
  sessionId: string,
): string | null {
  const matches = snapshot.folderAssignments.filter((assignment) => assignment.sessionId === sessionId);
  if (matches.length > 1) {
    throw new Error(`GET ${SESSION_ORGANIZATION_ROUTE} returned ${matches.length} folder assignments for one session`);
  }
  return matches[0]?.folderId ?? null;
}

/**
 * Reads one session's folder assignment through the scoped organization snapshot, the same query
 * the app uses (`assignmentSessionIds=<id>` with folders, tags and labels excluded). A session with
 * no assignment row is in no folder, reported as `null`.
 */
export async function fetchSessionFolderAssignment(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<Readonly<{ sessionId: string; folderId: string | null }>> {
  const query = new URLSearchParams({
    includeFolders: 'false',
    includeTags: 'false',
    includeLabels: 'false',
    assignmentSessionIds: params.sessionId,
  });
  const result = await getSessionOrganizationSnapshot({ token: params.token, query });
  if (!result.ok) {
    throw createHttpStatusError(404, `Unexpected status from GET ${SESSION_ORGANIZATION_ROUTE}: 404`);
  }
  return { sessionId: params.sessionId, folderId: readSingleFolderAssignment(result.snapshot, params.sessionId) };
}

export type FetchSessionOrganizationFoldersResult =
  | Readonly<{
    ok: true;
    folders: readonly SessionOrganizationFolder[];
    session: Readonly<{ sessionId: string; folderId: string | null }> | null;
  }>
  | Readonly<{ ok: false; code: 'unsupported'; serverError: string | null }>;

/**
 * Reads the account's active folders (the snapshot excludes archived ones) and, when `sessionId` is
 * given, that session's folder assignment, in one snapshot request with tags and labels excluded.
 * Folder display envelopes are returned as the server stores them; opening them is the caller's job.
 */
export async function fetchSessionOrganizationFolders(params: Readonly<{
  token: string;
  sessionId: string | null;
}>): Promise<FetchSessionOrganizationFoldersResult> {
  const query = new URLSearchParams({
    includeFolders: 'true',
    includeTags: 'false',
    includeLabels: 'false',
    ...(params.sessionId !== null ? { assignmentSessionIds: params.sessionId } : {}),
  });
  const result = await getSessionOrganizationSnapshot({ token: params.token, query });
  if (!result.ok) return result;
  return {
    ok: true,
    folders: result.snapshot.folders,
    session: params.sessionId === null
      ? null
      : { sessionId: params.sessionId, folderId: readSingleFolderAssignment(result.snapshot, params.sessionId) },
  };
}
