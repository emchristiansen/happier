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
  let permissionMode = 'default';

  const sessionRecord = async (id: string) => {
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    return {
      id,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 1,
      metadata: encodeBase64(encryptLegacy({ path: '/repo', host: 'host1', permissionMode }, params.secret), 'base64'),
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
    /** Another actor changes the session's permission mode metadata. */
    setPermissionMode(mode: string) {
      permissionMode = mode;
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

  // Mid-bucket (19:03Z), advancing in real time: a whole test stays inside one
  // 10-minute bucket unless it moves the clock itself.
  const midBucketMs = Date.UTC(2026, 9, 23, 19, 3, 0);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: midBucketMs });
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
    vi.useRealTimers();
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

  /**
   * The incident's path: the runner's MCP server registers `action_execute`,
   * which runs `session.message.send` through the CLI action executor harness.
   * `extra` is what the MCP SDK hands the handler; no `_meta` call id here.
   */
  async function mcpActionExecuteSend(message: string, extra: Record<string, unknown>): Promise<any> {
    const { createCliActionExecutorHarness } = await import('@/session/actions/createCliActionExecutorHarness');
    const { createActionToolExecutorBridge } = await import('@/agent/tools/happierTools/createActionToolExecutorBridge');
    const { registerHappierMcpBuiltInTools } = await import('@/mcp/server/registerHappierMcpBuiltInTools');
    const { resolveSessionEncryptionContextFromCredentials } = await import('@/session/transport/encryption/sessionEncryptionContext');
    const creds = await credentials();
    const harness = createCliActionExecutorHarness({
      token: creds.token,
      credentials: creds,
      sessionId: senderSessionId,
      ctx: resolveSessionEncryptionContextFromCredentials(creds),
    });
    const bridge = createActionToolExecutorBridge({
      executor: harness.executor,
      surface: 'session_agent',
      resolveCallerPermissionMode: () => 'default',
    });
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: senderSessionId,
      surface: 'session_agent',
      deps: {
        changeTitle: async () => ({ success: true }),
        startExecutionRun: async () => ({ ok: false as const, errorCode: 'unsupported', error: 'unsupported' }),
        executeActionByToolName: bridge.executeActionByToolName,
      },
    });
    const handler = handlers.get('action_execute');
    if (!handler) throw new Error('Expected action_execute to be registered');
    const result = await handler({ actionId: 'session.message.send', input: { sessionId: targetSessionId, message } }, extra) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? 'null') };
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
    expect(second).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ localId, deduplicated: true }) }));
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

  it('re-sends the first attempt bytes after a lost acknowledgement even when the session metadata changed', async () => {
    relay!.dropNextAcknowledgements(1);
    const first = await sessionSend([targetSessionId, 'CORRECTION CASE 3']);
    relay!.setPermissionMode('read-only');
    const second = await sessionSend([targetSessionId, 'CORRECTION CASE 3']);

    expect(first.error?.code).toBe('timeout');
    expect(second).toEqual(expect.objectContaining({ ok: true }));
    expect(new Set(relay!.postedLocalIds).size).toBe(1);
    // The retry re-sent the identical body, so the relay answered with the existing row
    // instead of refusing a body re-sealed under the new metadata as a conflict.
    expect(second.data.deduplicated).toBe(true);
    expect(relay!.rows.size).toBe(1);
  });

  it('reports an identical send in the same 10-minute bucket as deduplicated, even if meant as a repeat', async () => {
    const first = await sessionSend([targetSessionId, 'READY TO MOVE']);
    const second = await sessionSend([targetSessionId, 'READY TO MOVE']);

    expect(relay!.rows.size).toBe(1);
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(first.data).not.toHaveProperty('deduplicated');
    expect(second.data).toEqual(expect.objectContaining({ localId: first.data.localId, deduplicated: true }));
  });

  it('sends the same text again once the next UTC bucket starts', async () => {
    const first = await sessionSend([targetSessionId, 'READY TO MOVE']);
    vi.setSystemTime(Date.UTC(2026, 9, 23, 19, 10, 0));
    const second = await sessionSend([targetSessionId, 'READY TO MOVE']);

    expect(second.ok).toBe(true);
    expect(second.data.localId).not.toBe(first.data.localId);
    expect(relay!.rows.size).toBe(2);
  });

  it('collapses the incident path: MCP action_execute session.message.send twice with identical input and no call id', async () => {
    relay!.dropNextAcknowledgements(1);

    const first = await mcpActionExecuteSend('CORRECTION CASE tv-g1-paths-present-1', { requestId: 1 });
    const second = await mcpActionExecuteSend('CORRECTION CASE tv-g1-paths-present-1', { requestId: 2 });

    // Row counts first, so a RED run reports the duplicate itself.
    expect(relay!.postedLocalIds).toHaveLength(2);
    expect(relay!.rows.size).toBe(1);
    expect(new Set(relay!.postedLocalIds).size).toBe(1);
    expect(first.isError).toBe(true);
    expect(first.payload).toEqual(expect.objectContaining({
      errorCode: 'timeout',
      details: expect.objectContaining({ pendingCustody: 'unconfirmed' }),
    }));
    expect(second.isError).toBe(false);
    expect(second.payload).toEqual(expect.objectContaining({ ok: true, deduplicated: true }));
  });

  it('prefers the MCP request _meta provider call id over the bucket on the action_execute path', async () => {
    await mcpActionExecuteSend('ACK', { requestId: 1, _meta: { 'claudecode/toolUseId': 'toolu_mcp_a' } });
    await mcpActionExecuteSend('ACK', { requestId: 2, _meta: { 'claudecode/toolUseId': 'toolu_mcp_b' } });

    expect(relay!.rows.size).toBe(2);
    expect([...relay!.rows.keys()].every((localId) => localId.startsWith('session-send-tool-call:'))).toBe(true);
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
