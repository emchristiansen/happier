import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { listSessionFolders } from './listSessionFolders';

afterEach(() => vi.restoreAllMocks());

describe('listSessionFolders with a plain account', () => {
  it.each(['plain', 'encrypted'] as const)('handles a %s display without account encryption keys', async (kind) => {
    const workspace = { t: 'workspaceScope', serverId: 'server_1', machineId: 'machine_1', rootPath: '/repo' };
    const display = { name: 'Account folder', workspace };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { snapshot: {
      schemaVersion: 1, version: 1, pins: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
      folders: [{
        folderId: 'folder_1', folderKey: 'key_1', parentFolderId: null, parentFolderKey: null,
        sortKey: 'a0', archivedAt: null, createdAt: 10, updatedAt: 20,
        display: kind === 'plain' ? { t: 'plain', v: display } : {
          t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind: 'session_organization_display', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
            payload: display, randomBytes: (length) => new Uint8Array(length).fill(3),
          }),
        },
      }],
    } } });

    const result = await listSessionFolders({ credentials: { token: 'test-token', encryption: null }, sessionIdOrPrefix: null });

    expect(result).toMatchObject({ ok: true, session: null, folders: [kind === 'plain'
      ? { nameShown: true, name: display.name, workspace: { serverId: workspace.serverId, machineId: workspace.machineId, rootPath: workspace.rootPath } }
      : { nameShown: false, name: null, nameNotShownReason: 'display_not_decryptable', workspace: null }] });
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]?.[0]).toContain('/v2/session-organization?');
  });
});
