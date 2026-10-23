import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

// The wake nudge after admission is a best-effort socket RPC; it has no part in
// Pending identity, so it is stubbed rather than served.
vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(async () => ({ ok: true })),
}));

type PendingRow = Readonly<{ localId: string; body: Record<string, unknown> }>;

/**
 * Pending rows as the relay keeps them: one per (session, localId). A re-enqueue
 * with the same localId and the same content and action answers the existing
 * row; different content or action answers 409 (pendingMessageService.ts,
 * enqueuePendingMessage; pendingRoutes.ts maps requested-action-conflict to 409).
 */
function createFakeRelay(params: Readonly<{ secret: Uint8Array; senderSessionId: string; targetSessionId: string }>) {
  const rows = new Map<string, PendingRow>();
  const postedLocalIds: string[] = [];
  let dropAcknowledgements = 0;

  const sessionRecord = async (id: string) => {
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    return {
      id,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 1,
      metadata: encodeBase64(encryptLegacy({ path: '/repo', host: 'host1', permissionMode: 'default' }, params.secret), 'base64'),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
      archivedAt: null,
    };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const sendJson = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/v2/account/settings') {
      sendJson(200, { version: 1, content: { t: 'plain', v: { schemaVersion: 2, actionsSettingsV1: { v: 1, actions: {} } } } });
      return;
    }
    const sessionMatch = /^\/v2\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1] ?? '');
      if (id !== params.senderSessionId && id !== params.targetSessionId) {
        sendJson(404, { error: 'session-not-found' });
        return;
      }
      void sessionRecord(id).then((session) => sendJson(200, { session }));
      return;
    }
    if (req.method === 'POST' && url.pathname === `/v2/sessions/${params.targetSessionId}/pending`) {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        const localId = String(body.localId ?? '');
        postedLocalIds.push(localId);
        const existing = rows.get(localId);
        if (existing) {
          const same = isDeepStrictEqual(existing.body.ciphertext, body.ciphertext)
            && isDeepStrictEqual(existing.body.content, body.content)
            && isDeepStrictEqual(existing.body.requestedAction, body.requestedAction);
          if (!same) {
            sendJson(409, { error: 'requested-action-conflict' });
            return;
          }
        } else {
          rows.set(localId, { localId, body });
        }
        if (dropAcknowledgements > 0) {
          // Committed (or already present), but the client never hears back:
          // what a saturated relay does to a request whose client gave up waiting.
          dropAcknowledgements -= 1;
          req.socket.destroy();
          return;
        }
        sendJson(200, { didWrite: !existing });
      });
      return;
    }
    sendJson(404, { error: 'not-found' });
  });

  return {
    server,
    rows,
    postedLocalIds,
    dropNextAcknowledgements(count: number) {
      dropAcknowledgements = count;
    },
  };
}

describe('session message send idempotency at the relay HTTP boundary (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_ACTIONS_SETTINGS_V1'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let relay: ReturnType<typeof createFakeRelay> | null = null;
  let happyHomeDir = '';

  const secret = new Uint8Array(32).fill(7);
  const senderSessionId = 'sess_send_idem_sender';
  const targetSessionId = 'sess_send_idem_target';
  const credentials = async () => ({ token: 'token_test', encryption: { type: 'legacy' as const, secret } });

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-send-idempotency-');
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    relay = createFakeRelay({ secret, senderSessionId, targetSessionId });
    await new Promise<void>((resolve) => relay!.server.listen(0, '127.0.0.1', () => resolve()));
    const address = relay.server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve fake relay address');
    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    if (relay) {
      await new Promise<void>((resolve, reject) => relay!.server.close((e) => (e ? reject(e) : resolve())));
    }
    relay = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function sessionSend(args: readonly string[]): Promise<any> {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', ...args, '--json'], { readCredentialsFn: credentials });
      return output.json();
    } finally {
      output.restore();
    }
  }

  async function agentToolSend(toolCallId: string, message: string): Promise<any> {
    const { handleToolsCommand } = await import('@/cli/commands/tools');
    const output = captureConsoleJsonOutput();
    try {
      await handleToolsCommand([
        'call',
        '--source', 'happier',
        '--tool', 'action_execute',
        '--args-json', JSON.stringify({ actionId: 'session.message.send', input: { sessionId: targetSessionId, message } }),
        '--session-id', senderSessionId,
        '--session-agent-bridge',
        '--tool-call-id', toolCallId,
        '--json',
      ], { readCredentials: credentials });
      return output.json();
    } finally {
      output.restore();
    }
  }

  it('turns a `session send` resend after a lost acknowledgement into the same relay row', async () => {
    relay!.dropNextAcknowledgements(1);

    const first = await sessionSend([targetSessionId, 'READY TO MOVE']);
    const second = await sessionSend([targetSessionId, 'READY TO MOVE']);

    expect(relay!.postedLocalIds).toHaveLength(2);
    expect(relay!.rows.size).toBe(1);
    const [localId] = [...relay!.rows.keys()];
    expect(first).toEqual(expect.objectContaining({ ok: false, kind: 'session_send' }));
    expect(first.error).toEqual(expect.objectContaining({
      code: 'timeout',
      details: expect.objectContaining({ pendingCustody: 'unconfirmed', sessionId: targetSessionId, localId }),
    }));
    expect(String(first.error.details.message)).toContain('may still have been committed');
    expect(second).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ localId }) }));
  });

  it('keeps one localId across a resend loop that keeps losing acknowledgements', async () => {
    relay!.dropNextAcknowledgements(3);
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      results.push(await sessionSend([targetSessionId, 'status: green']));
    }

    expect(results.map((result) => result.ok)).toEqual([false, false, false, true]);
    expect(relay!.postedLocalIds).toHaveLength(4);
    expect(new Set(relay!.postedLocalIds).size).toBe(1);
    expect(relay!.rows.size).toBe(1);
  });

  it('sends a deliberate repeat of the same text after a successful send as a new message', async () => {
    const first = await sessionSend([targetSessionId, 'READY TO MOVE']);
    const second = await sessionSend([targetSessionId, 'READY TO MOVE']);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(relay!.rows.size).toBe(2);
    expect(first.data.localId).not.toBe(second.data.localId);
  });

  it('uses --local-id verbatim, so a resend with it dedupes', async () => {
    relay!.dropNextAcknowledgements(1);

    const first = await sessionSend([targetSessionId, 'hello', '--local-id', 'caller-key-1']);
    const second = await sessionSend([targetSessionId, 'hello', '--local-id', 'caller-key-1']);

    expect(relay!.postedLocalIds).toEqual(['caller-key-1', 'caller-key-1']);
    expect(relay!.rows.size).toBe(1);
    expect(first.error).toEqual(expect.objectContaining({
      code: 'timeout',
      details: expect.objectContaining({ pendingCustody: 'unconfirmed', localId: 'caller-key-1' }),
    }));
    expect(second).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ localId: 'caller-key-1' }) }));
  });

  it('reports a reused localId with different text as conflict, not as a timeout', async () => {
    await sessionSend([targetSessionId, 'first text', '--local-id', 'caller-key-2']);
    const second = await sessionSend([targetSessionId, 'other text', '--local-id', 'caller-key-2']);

    expect(relay!.rows.size).toBe(1);
    expect(second.error).toEqual(expect.objectContaining({
      code: 'conflict',
      details: expect.objectContaining({ pendingCustody: 'refused', localId: 'caller-key-2' }),
    }));
  });

  it('turns a retry of the same agent tool call into the same relay row', async () => {
    relay!.dropNextAcknowledgements(1);

    await agentToolSend('toolu_same_call', 'CORRECTION CASE 1');
    const retried = await agentToolSend('toolu_same_call', 'CORRECTION CASE 1');

    expect(relay!.rows.size).toBe(1);
    expect(retried.ok).toBe(true);
    const [localId] = [...relay!.rows.keys()];
    expect(localId?.startsWith('session-send-tool-call:')).toBe(true);
  });

  it('derives the same localId for a retry of one tool call even after its first attempt succeeded', async () => {
    await agentToolSend('toolu_answered_call', 'CORRECTION CASE 2');
    await agentToolSend('toolu_answered_call', 'CORRECTION CASE 2');

    expect(relay!.rows.size).toBe(1);
    expect(new Set(relay!.postedLocalIds).size).toBe(1);
  });

  it('sends two distinct successful tool calls with the same text as two messages', async () => {
    await agentToolSend('toolu_call_a', 'READY TO MOVE');
    await agentToolSend('toolu_call_b', 'READY TO MOVE');

    expect(relay!.rows.size).toBe(2);
  });
});
