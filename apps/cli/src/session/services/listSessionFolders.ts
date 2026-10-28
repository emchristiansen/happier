import {
  openAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
  type SessionOrganizationContentEnvelope,
  type SessionOrganizationFolder,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionOrganizationFolders } from '@/session/transport/http/sessionFolderAssignmentsHttp';

/**
 * Why a folder's name is not shown:
 * - `display_not_decryptable`: the display is encrypted and this CLI's account key does not open it;
 * - `no_display`: the server holds no display for the folder;
 * - `display_has_no_name`: the display opened but carries no non-empty `name`.
 */
export type SessionFolderNameNotShownReason = 'display_not_decryptable' | 'no_display' | 'display_has_no_name';

/** The workspace a folder belongs to, as the app records it inside the folder's display. */
export type SessionFolderWorkspace = Readonly<{ serverId: string; machineId: string; rootPath: string }>;

export type ListedSessionFolder = Readonly<{
  folderId: string;
  parentFolderId: string | null;
  sortKey: string | null;
  createdAt: number;
  updatedAt: number;
  workspace: SessionFolderWorkspace | null;
}> & (
  | Readonly<{ nameShown: true; name: string; nameNotShownReason: null }>
  | Readonly<{ nameShown: false; name: null; nameNotShownReason: SessionFolderNameNotShownReason }>
);

export type ListSessionFoldersResult =
  | Readonly<{
    ok: true;
    folders: readonly ListedSessionFolder[];
    session: Readonly<{ sessionId: string; folderId: string | null }> | null;
  }>
  | Readonly<{
    ok: false;
    code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported';
    candidates?: string[];
    serverError?: string | null;
  }>;

const SESSION_ORGANIZATION_DISPLAY_KIND = 'session_organization_display';

function accountScopedMaterial(credentials: Credentials): AccountScopedCryptoMaterial | null {
  if (credentials.encryption === null) return null;
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Opens a display envelope the way the app does: plain envelopes carry the value directly; encrypted
 * ones are account-scoped `session_organization_display` blobs sealed with the account content key,
 * the same key and scheme the CLI already uses to open account settings.
 */
function openDisplayValue(
  material: AccountScopedCryptoMaterial | null,
  display: SessionOrganizationContentEnvelope | null,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: 'no_display' | 'display_not_decryptable' }> {
  if (display === null) return { ok: false, reason: 'no_display' };
  if (display.t === 'plain') return { ok: true, value: display.v };
  if (material === null) return { ok: false, reason: 'display_not_decryptable' };
  const opened = openAccountScopedBlobCiphertext({
    kind: SESSION_ORGANIZATION_DISPLAY_KIND,
    material,
    ciphertext: display.c,
  });
  return opened === null ? { ok: false, reason: 'display_not_decryptable' } : { ok: true, value: opened.value };
}

function readName(value: unknown): string | null {
  const name = isRecord(value) && typeof value.name === 'string' ? value.name.trim() : '';
  return name || null;
}

function readWorkspace(value: unknown): SessionFolderWorkspace | null {
  const workspace = isRecord(value) ? value.workspace : null;
  if (!isRecord(workspace) || workspace.t !== 'workspaceScope') return null;
  const serverId = typeof workspace.serverId === 'string' ? workspace.serverId.trim() : '';
  const machineId = typeof workspace.machineId === 'string' ? workspace.machineId.trim() : '';
  const rootPath = typeof workspace.rootPath === 'string' ? workspace.rootPath.trim() : '';
  if (!serverId || !machineId || !rootPath) return null;
  return { serverId, machineId, rootPath };
}

function describeFolder(material: AccountScopedCryptoMaterial | null, folder: SessionOrganizationFolder): ListedSessionFolder {
  const base = {
    folderId: folder.folderId,
    parentFolderId: folder.parentFolderId,
    sortKey: folder.sortKey,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
  const opened = openDisplayValue(material, folder.display);
  if (!opened.ok) {
    return { ...base, workspace: null, nameShown: false, name: null, nameNotShownReason: opened.reason };
  }
  const workspace = readWorkspace(opened.value);
  const name = readName(opened.value);
  return name === null
    ? { ...base, workspace, nameShown: false, name: null, nameNotShownReason: 'display_has_no_name' }
    : { ...base, workspace, nameShown: true, name, nameNotShownReason: null };
}

/**
 * Lists the account's active folders, with each name where this CLI can read it, and, when
 * `sessionIdOrPrefix` is given, the folder that session is in. Read only.
 */
export async function listSessionFolders(params: Readonly<{
  credentials: Credentials;
  sessionIdOrPrefix: string | null;
}>): Promise<ListSessionFoldersResult> {
  let sessionId: string | null = null;
  if (params.sessionIdOrPrefix !== null) {
    const resolved = await resolveSessionIdOrPrefix({
      credentials: params.credentials,
      idOrPrefix: params.sessionIdOrPrefix,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }
    sessionId = resolved.sessionId;
  }

  const fetched = await fetchSessionOrganizationFolders({ token: params.credentials.token, sessionId });
  if (!fetched.ok) return fetched;

  const material = accountScopedMaterial(params.credentials);
  return {
    ok: true,
    folders: fetched.folders.map((folder) => describeFolder(material, folder)),
    session: fetched.session,
  };
}
