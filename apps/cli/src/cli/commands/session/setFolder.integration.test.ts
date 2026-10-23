import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { SessionControlEnvelopeErrorSchema } from '@happier-dev/protocol';

type RecordedRequest = Readonly<{ method: string; pathname: string; search: URLSearchParams; body: unknown }>;

type PutReply = Readonly<{ status: number; body: unknown }> | 'echo';

describe('happier session set-folder (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let previousExitCode: typeof process.exitCode;

  const sessionId = 'cmvlsetfolder000000000001';
  const secret = new Uint8Array(32).fill(7);
  const credentials = {
    token: 'token_test',
    encryption: { type: 'legacy' as const, secret },
  };

  const requests: RecordedRequest[] = [];
  let putReply: PutReply = 'echo';
  let storedFolderId: string | null = null;
  let readbackOverride: string | null | undefined;
  let sessionRecord: Record<string, unknown> | null = null;

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : null;
  }

  function folderAssignmentRequests(): RecordedRequest[] {
    return requests.filter((request) => request.pathname.startsWith('/v2/session-organization'));
  }

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-set-folder-');
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    requests.length = 0;
    putReply = 'echo';
    storedFolderId = null;
    readbackOverride = undefined;

    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64(
      encryptLegacy({ path: '/repo', host: 'host1', tag: 'FolderTag' }, secret),
      'base64',
    );
    sessionRecord = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      metadata: metadataCiphertext,
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
      void (async () => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const body = await readBody(req);
        requests.push({ method: req.method ?? '', pathname: url.pathname, search: url.searchParams, body });

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
        if (req.method === 'PUT' && url.pathname.startsWith('/v2/session-organization/folder-assignments/')) {
          const targetSessionId = decodeURIComponent(url.pathname.slice('/v2/session-organization/folder-assignments/'.length));
          if (putReply !== 'echo') {
            sendJson(res, putReply.status, putReply.body);
            return;
          }
          const folderId = (body as { folderId: string | null }).folderId;
          storedFolderId = folderId;
          sendJson(res, 200, { sessionId: targetSessionId, folderId });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/v2/session-organization') {
          const readbackFolderId = readbackOverride === undefined ? storedFolderId : readbackOverride;
          const scopedSessionIds = (url.searchParams.get('assignmentSessionIds') ?? '').split(',');
          sendJson(res, 200, {
            snapshot: {
              schemaVersion: 1,
              version: 3,
              pins: [],
              folders: [],
              folderAssignments: readbackFolderId !== null && scopedSessionIds.includes(sessionId)
                ? [{ sessionId, folderId: readbackFolderId }]
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
      })();
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

  it('moves the session into the folder through the folder-assignments PUT and reports the readback', async () => {
    const parsed = await runJson(['set-folder', sessionId, 'folder_standing_roles', '--json']);

    expect(parsed).toEqual({
      v: 1,
      ok: true,
      kind: 'session_set_folder',
      data: { sessionId, folderId: 'folder_standing_roles', readback: { folderId: 'folder_standing_roles' } },
    });
    expect(process.exitCode).toBe(0);

    const [put, readback, ...rest] = folderAssignmentRequests();
    expect(rest).toEqual([]);
    expect(put).toMatchObject({
      method: 'PUT',
      pathname: `/v2/session-organization/folder-assignments/${sessionId}`,
      body: { folderId: 'folder_standing_roles' },
    });
    expect(readback?.method).toBe('GET');
    expect(readback?.pathname).toBe('/v2/session-organization');
    expect(readback?.search.get('assignmentSessionIds')).toBe(sessionId);
    expect(readback?.search.get('includeFolders')).toBe('false');
    expect(readback?.search.get('includeTags')).toBe('false');
    expect(readback?.search.get('includeLabels')).toBe('false');
  });

  it('removes the session from every folder with --none and reads back no folder', async () => {
    storedFolderId = 'folder_previous';

    const parsed = await runJson(['set-folder', sessionId, '--none', '--json']);

    expect(parsed).toEqual({
      v: 1,
      ok: true,
      kind: 'session_set_folder',
      data: { sessionId, folderId: null, readback: { folderId: null } },
    });
    expect(folderAssignmentRequests()[0]).toMatchObject({ method: 'PUT', body: { folderId: null } });
  });

  it('resolves the session by tag before writing the assignment', async () => {
    const parsed = await runJson(['set-folder', 'FolderTag', 'folder_standing_roles', '--json']);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.sessionId).toBe(sessionId);
    expect(folderAssignmentRequests()[0]?.pathname).toBe(`/v2/session-organization/folder-assignments/${sessionId}`);
  });

  it('prints the read-back folder in human output', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleText();
    try {
      await handleSessionCommand(['set-folder', sessionId, 'folder_standing_roles'], { readCredentialsFn: async () => credentials });
      expect(output.text()).toContain(`${sessionId} is in folder folder_standing_roles (read back from the server)`);
    } finally {
      output.restore();
    }
  });

  it('fails with session_not_found for an unknown session and writes nothing', async () => {
    sessionRecord = null;

    const parsed = await runJson(['set-folder', sessionId, 'folder_standing_roles', '--json']);

    expect(parsed).toEqual({
      v: 1,
      ok: false,
      kind: 'session_set_folder',
      error: { code: 'session_not_found' },
    });
    expect(process.exitCode).toBe(1);
    expect(folderAssignmentRequests()).toEqual([]);
  });

  it('fails with session_not_found when the server refuses the session on the assignment route', async () => {
    putReply = { status: 404, body: { error: 'Session not found' } };

    const parsed = await runJson(['set-folder', sessionId, 'folder_standing_roles', '--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({ code: 'session_not_found', details: { serverError: 'Session not found' } });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(folderAssignmentRequests().map((request) => request.method)).toEqual(['PUT']);
  });

  it('fails with folder_not_found when the server rejects the folder as an invalid assignment', async () => {
    putReply = { status: 400, body: { error: 'invalid-session-folder-assignment' } };

    const parsed = await runJson(['set-folder', sessionId, 'folder_missing', '--json']);

    expect(parsed).toEqual({
      v: 1,
      ok: false,
      kind: 'session_set_folder',
      error: {
        code: 'folder_not_found',
        message: `Folder folder_missing is not an active folder of this account; session ${sessionId} was not moved.`,
        details: { sessionId, folderId: 'folder_missing', serverError: 'invalid-session-folder-assignment' },
      },
    });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(folderAssignmentRequests().map((request) => request.method)).toEqual(['PUT']);
  });

  it('fails with unsupported when the server does not serve the folders feature', async () => {
    putReply = { status: 404, body: { error: 'not_found' } };

    const parsed = await runJson(['set-folder', sessionId, 'folder_standing_roles', '--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('unsupported');
    expect(parsed.error.details).toEqual({ serverError: 'not_found' });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
  });

  it('fails with readback_mismatch when the server reports a different folder after the write', async () => {
    readbackOverride = 'folder_other';

    const parsed = await runJson(['set-folder', sessionId, 'folder_standing_roles', '--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({
      code: 'readback_mismatch',
      message: `Session ${sessionId} was asked to move to folder folder_standing_roles, but the server reports folder folder_other.`,
      details: {
        sessionId,
        requestedFolderId: 'folder_standing_roles',
        assignedFolderId: 'folder_standing_roles',
        readbackFolderId: 'folder_other',
      },
    });
    expect(SessionControlEnvelopeErrorSchema.safeParse(parsed).success).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['set-folder', sessionId, '--json']],
    [['set-folder', sessionId, 'folder_standing_roles', '--none', '--json']],
    [['set-folder', sessionId, 'folder_a', 'folder_b', '--json']],
  ])('rejects %j as invalid_arguments without reading credentials', async (argv) => {
    const { handleSessionCommand } = await import('./index');
    const readCredentialsFn = vi.fn(async () => credentials);
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([...argv], { readCredentialsFn });
      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_set_folder');
      expect(parsed.error.code).toBe('invalid_arguments');
      expect(parsed.error.message).toContain('happier session set-folder <session-id-or-prefix-or-tag> (<folder-id> | --none)');
    } finally {
      output.restore();
    }
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
