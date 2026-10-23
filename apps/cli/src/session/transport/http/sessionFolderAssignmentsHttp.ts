import axios from 'axios';
import {
  SessionOrganizationSnapshotResponseSchema,
  SetSessionFolderAssignmentResponseSchema,
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

/**
 * Reads one session's folder assignment through the scoped organization snapshot, the same query
 * the app uses (`assignmentSessionIds=<id>` with folders, tags and labels excluded). A session with
 * no assignment row is in no folder, reported as `null`.
 */
export async function fetchSessionFolderAssignment(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<Readonly<{ sessionId: string; folderId: string | null }>> {
  const serverUrl = resolveServerHttpBaseUrl();
  const query = new URLSearchParams({
    includeFolders: 'false',
    includeTags: 'false',
    includeLabels: 'false',
    assignmentSessionIds: params.sessionId,
  });
  const path = `${SESSION_ORGANIZATION_ROUTE}?${query.toString()}`;
  const response = await axios.get(`${serverUrl}${path}`, {
    headers: authHeaders(params.token),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createHttpStatusError(response.status, `Unauthorized (${response.status})`, 'not_authenticated');
  }
  if (response.status !== 200) {
    throw createHttpStatusError(response.status, `Unexpected status from GET ${SESSION_ORGANIZATION_ROUTE}: ${response.status}`);
  }

  const parsed = SessionOrganizationSnapshotResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Unexpected GET ${SESSION_ORGANIZATION_ROUTE} response shape`);
  }
  const matches = parsed.data.snapshot.folderAssignments.filter((assignment) => assignment.sessionId === params.sessionId);
  if (matches.length > 1) {
    throw new Error(`GET ${SESSION_ORGANIZATION_ROUTE} returned ${matches.length} folder assignments for one session`);
  }
  return { sessionId: params.sessionId, folderId: matches[0]?.folderId ?? null };
}
