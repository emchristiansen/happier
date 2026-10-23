import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SessionControlEnvelopeErrorSchema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

type RecordedRequest = Readonly<{ method: string; pathname: string; search: URLSearchParams }>;

type SnapshotReply = Readonly<{ status: number; body: unknown }> | 'snapshot';

describe('happier session folders (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let previousExitCode: typeof process.exitCode;

  const sessionId = 'cmvlfolders00000000000001';
  const secret = new Uint8Array(32).fill(7);
  const otherAccountSecret = new Uint8Array(32).fill(9);
  const credentials = {
    token: 'token_test',
    encryption: { type: 'legacy' as const, secret },
  };
  const workspace = { t: 'workspaceScope', serverId: 'server_1', machineId: 'machine_1', rootPath: '/repo' };

  const requests: RecordedRequest[] = [];
  let snapshotReply: SnapshotReply = 'snapshot';
  let folders: unknown[] = [];
  let assignedFolderId: string | null = null;
  let sessionRecord: Record<string, unknown> | null = null;

  function sealDisplay(value: unknown, sealingSecret: Uint8Array): { t: 'encrypted'; c: string } {
    return {
      t: 'encrypted',
      c: sealAccountScopedBlobCiphertext({
        kind: 'session_organization_display',
        material: { type: 'legacy', secret: sealingSecret },
        payload: value,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
      }),
    };
  }

  function folderRecord(folderId: string, display: unknown, parentFolderId: string | null = null): Record<string, unknown> {
    return {
      folderId,
      folderKey: `key_${folderId}`,
      parentFolderId,
      parentFolderKey: parentFolderId ? `key_${parentFolderId}` : null,
      sortKey: 'a0',
      display,
      archivedAt: null,
      createdAt: 10,
      updatedAt: 20,
    };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  function organizationRequests(): RecordedRequest[] {
    return requests.filter((request) => request.pathname.startsWith('/v2/session-organization'));
  }

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-folders-');
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    requests.length = 0;
    snapshotReply = 'snapshot';
    folders = [];
    assignedFolderId = null;

    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    sessionRecord = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: encodeBase64(encryptLegacy({ path: '/repo', host: 'host1', tag: 'FoldersTag' }, secret), 'base64'),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
      archivedAt: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      requests.push({ method: req.method ?? '', pathname: url.pathname, search: url.searchParams });

      if (req.method === 'GET' && url.pathname === '/v2/account/settings') {
        sendJson(res, 200, { version: 1, content: { t: 'plain', v: { schemaVersion: 2 } } });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        if (!sessionRecord) {
          sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        sendJson(res, 200, { session: sessionRecord });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/archived')) {
        const sessions = sessionRecord && url.pathname === '/v2/sessions' ? [sessionRecord] : [];
        sendJson(res, 200, { sessions, nextCursor: null, hasNext: false });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v2/session-organization') {
        if (snapshotReply !== 'snapshot') {
          sendJson(res, snapshotReply.status, snapshotReply.body);
          return;
        }
        const scopedSessionIds = (url.searchParams.get('assignmentSessionIds') ?? '').split(',');
        sendJson(res, 200, {
          snapshot: {
            schemaVersion: 1,
            version: 4,
            pins: [],
            folders: url.searchParams.get('includeFolders') === 'false' ? [] : folders,
            folderAssignments: assignedFolderId !== null && scopedSessionIds.includes(sessionId)
              ? [{ sessionId, folderId: assignedFolderId }]
              : [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
          },
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }
    process.exitCode = previousExitCode;

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function runJson(argv: string[]): Promise<any> {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(argv, { readCredentialsFn: async () => credentials });
      return output.json();
    } finally {
      output.restore();
    }
  }

  async function runText(argv: string[]): Promise<string> {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleText();
    try {
      await handleSessionCommand(argv, { readCredentialsFn: async () => credentials });
      // Compare the words, not chalk's colour codes.
      return output.text().replace(/\u001b\[[0-9;]*m/g, '');
    } finally {
      output.restore();
    }
  }

  it('lists every folder, showing names it can read and saying why the others are not shown', async () => {
    folders = [
      folderRecord('folder_plain', { t: 'plain', v: { name: 'Standing roles', workspace } }),
      folderRecord('folder_sealed', sealDisplay({ name: 'Successors', workspace }, secret), 'folder_plain'),
      folderRecord('folder_foreign_key', sealDisplay({ name: 'Unreadable', workspace }, otherAccountSecret)),
      folderRecord('folder_no_display', null),
      folderRecord('folder_no_name', { t: 'plain', v: { workspace } }),
    ];

    const parsed = await runJson(['folders', '--json']);

    const base = { sortKey: 'a0', createdAt: 10, updatedAt: 20 };
    const listedWorkspace = { serverId: 'server_1', machineId: 'machine_1', rootPath: '/repo' };
    expect(parsed).toEqual({
      v: 1,
      ok: true,
      kind: 'session_folders',
      data: {
        folders: [
          { ...base, folderId: 'folder_plain', parentFolderId: null, workspace: listedWorkspace, nameShown: true, name: 'Standing roles', nameNotShownReason: null },
          { ...base, folderId: 'folder_sealed', parentFolderId: 'folder_plain', workspace: listedWorkspace, nameShown: true, name: 'Successors', nameNotShownReason: null },
          { ...base, folderId: 'folder_foreign_key', parentFolderId: null, workspace: null, nameShown: false, name: null, nameNotShownReason: 'display_not_decryptable' },
          { ...base, folderId: 'folder_no_display', parentFolderId: null, workspace: null, nameShown: false, name: null, nameNotShownReason: 'no_display' },
          { ...base, folderId: 'folder_no_name', parentFolderId: null, workspace: listedWorkspace, nameShown: false, name: null, nameNotShownReason: 'display_has_no_name' },
        ],
      },
    });
    expect(process.exitCode).toBe(0);

    const [snapshot, ...rest] = organizationRequests();
    expect(rest).toEqual([]);
    expect(snapshot?.method).toBe('GET');
    expect(snapshot?.search.get('includeFolders')).toBe('true');
    expect(snapshot?.search.get('includeTags')).toBe('false');
    expect(snapshot?.search.get('includeLabels')).toBe('false');
    expect(snapshot?.search.has('assignmentSessionIds')).toBe(false);
  });

  it('reports an empty folder list', async () => {
    const parsed = await runJson(['folders', '--json']);

    expect(parsed).toEqual({ v: 1, ok: true, kind: 'session_folders', data: { folders: [] } });
    expect(await runText(['folders'])).toContain('No folders.');
  });

  it('prints one line per folder in human output', async () => {
    folders = [
      folderRecord('folder_plain', { t: 'plain', v: { name: 'Standing roles', workspace } }),
      folderRecord('folder_foreign_key', sealDisplay({ name: 'Unreadable' }, otherAccountSecret), 'folder_plain'),
    ];

    const text = await runText(['folders']);

    expect(text).toContain('folder_plain Standing roles machine_1:/repo');
    expect(text).toContain('folder_foreign_key (name not shown: display_not_decryptable) parent folder_plain');
    expect(text).not.toContain('Unreadable');
  });

  it('reports the folder of the session named by --session from the same snapshot read', async () => {
    folders = [folderRecord('folder_plain', { t: 'plain', v: { name: 'Standing roles', workspace } })];
    assignedFolderId = 'folder_plain';

    const parsed = await runJson(['folders', '--session', 'FoldersTag', '--json']);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.session).toEqual({ sessionId, folderId: 'folder_plain' });
    expect(parsed.data.folders.map((folder: { folderId: string }) => folder.folderId)).toEqual(['folder_plain']);
    const [snapshot, ...rest] = organizationRequests();
    expect(rest).toEqual([]);
    expect(snapshot?.search.get('assignmentSessionIds')).toBe(sessionId);
    expect(snapshot?.search.get('includeFolders')).toBe('true');

    expect(await runText(['folders', '--session', sessionId])).toContain(`${sessionId} is in folder folder_plain`);
  });

  it('reports folderId null for a session in no folder', async () => {
    const parsed = await runJson(['folders', '--session', sessionId, '--json']);

    expect(parsed.data.session).toEqual({ sessionId, folderId: null });
    expect(await runText(['folders', '--session', sessionId])).toContain(`${sessionId} is in no folder`);
  });

  it('fails with session_not_found for an unknown --session and reads no snapshot', async () => {
    sessionRecord = null;

    const parsed = await runJson(['folders', '--session', sessionId, '--json']);

    expect(parsed).toEqual({ v: 1, ok: false, kind: 'session_folders', error: { code: 'session_not_found' } });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(organizationRequests()).toEqual([]);
  });

  it('fails with unsupported when the server does not serve the organization snapshot', async () => {
    snapshotReply = { status: 404, body: { error: 'Not Found' } };

    const parsed = await runJson(['folders', '--json']);

    expect(parsed).toEqual({
      v: 1,
      ok: false,
      kind: 'session_folders',
      error: {
        code: 'unsupported',
        message: 'The server does not serve the session organization snapshot (it predates session folders).',
        details: { serverError: 'Not Found' },
      },
    });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('fails as an unexpected error when the server answers the snapshot with a server error', async () => {
    snapshotReply = { status: 500, body: { error: 'Internal Server Error' } };

    const parsed = await runJson(['folders', '--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('session_folders');
    expect(parsed.error.code).toBe('unknown_error');
    expect(parsed.error.message).toBe('Unexpected status from GET /v2/session-organization: 500');
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(process.exitCode).toBe(2);
  });

  it.each([
    [['folders', 'extra', '--json']],
    [['folders', '--session', '--json']],
    [['folders', '--json', '--session']],
  ])('rejects %j as invalid_arguments without reading credentials', async (argv) => {
    const { handleSessionCommand } = await import('./index');
    const readCredentialsFn = vi.fn(async () => credentials);
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([...argv], { readCredentialsFn });
      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_folders');
      expect(parsed.error.code).toBe('invalid_arguments');
      expect(parsed.error.message).toContain('happier session folders [--session <session-id-or-prefix-or-tag>]');
      expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    } finally {
      output.restore();
    }
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
});
