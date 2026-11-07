import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { waitForCondition } from '@/testkit/async/waitFor';

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    isDaemonProcess: false,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn().mockResolvedValue(null),
}));

import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';

type ListResponse = Readonly<{
  ok: boolean;
  candidates?: ReadonlyArray<{ remoteSessionId: string; title?: string; updatedAtMs: number }>;
  capabilities?: Readonly<{ deleteCandidate: boolean }>;
  deleted?: boolean;
  nextCursor?: string | null;
  searchIncomplete?: boolean;
  errorCode?: string;
  error?: string;
}>;

/**
 * Fake ACP agent. Records every `session/list` request it receives and terminates on SIGTERM
 * after recording the signal, so disposal of the short-lived listing connection is observable.
 *
 * `negotiateList: false` reproduces an agent whose static catalog declaration promises listing
 * but whose live handshake does not advertise `sessionCapabilities.list`.
 */
function fakeAcpAgentSource(params: Readonly<{
  evidenceDir: string;
  negotiateList: boolean;
  negotiateDelete?: boolean;
  deleteFails?: boolean;
}>): string {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const evidenceDir = ${JSON.stringify(params.evidenceDir)};
const negotiateList = ${JSON.stringify(params.negotiateList)};
const negotiateDelete = ${JSON.stringify(params.negotiateDelete ?? params.negotiateList)};
const deleteFails = ${JSON.stringify(params.deleteFails ?? false)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

const sessionCapabilities = {
  ...(negotiateList ? { list: {} } : {}),
  ...(negotiateDelete ? { delete: {} } : {}),
  resume: {},
  close: {},
  fork: {},
};

process.on('SIGTERM', () => {
  appendFileSync(join(evidenceDir, 'terminated.log'), 'SIGTERM\\n');
  process.exit(0);
});

const decoder = new TextDecoder();
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      ok(request.id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities,
          mcpCapabilities: { http: true, sse: true },
        },
      });
    } else if (request.method === 'session/list') {
      appendFileSync(join(evidenceDir, 'list-requests.jsonl'), JSON.stringify(request.params ?? null) + '\\n');
      if (!negotiateList) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      if (request.params?.cursor === 'page-2') {
        ok(request.id, {
          sessions: [
            { sessionId: 'sess_beta', cwd: '/work/repo', title: 'Beta', updatedAt: '2026-09-02T10:00:00.000Z' },
          ],
        });
        continue;
      }
      ok(request.id, {
        sessions: [
          { sessionId: '  sess_alpha  ', cwd: '/work/repo', title: 'Alpha', updatedAt: '2026-09-01T10:00:00.000Z' },
          { sessionId: '   ', cwd: '/work/repo', title: 'Blank identifier' },
        ],
        nextCursor: 'page-2',
      });
    } else if (request.method === 'session/delete') {
      appendFileSync(join(evidenceDir, 'delete-requests.jsonl'), JSON.stringify(request.params ?? null) + '\\n');
      if (deleteFails) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'provider refused deletion' } });
      } else {
        ok(request.id, {});
      }
    } else {
      ok(request.id, {});
    }
  }
});

appendFileSync(join(evidenceDir, 'started.log'), 'started\\n');
`;
}

function writeFakeAgent(params: Readonly<{
  dir: string;
  fileName: string;
  negotiateList: boolean;
  negotiateDelete?: boolean;
  deleteFails?: boolean;
}>): string {
  const scriptPath = join(params.dir, params.fileName);
  writeFileSync(scriptPath, fakeAcpAgentSource({
    evidenceDir: params.dir,
    negotiateList: params.negotiateList,
    negotiateDelete: params.negotiateDelete,
    deleteFails: params.deleteFails,
  }), 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function countLines(dir: string, fileName: string): number {
  try {
    return readFileSync(join(dir, fileName), 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function readListRequests(dir: string): Array<Record<string, unknown> | null> {
  try {
    return readFileSync(join(dir, 'list-requests.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown> | null);
  } catch {
    return [];
  }
}

function readDeleteRequests(dir: string): Array<Record<string, unknown> | null> {
  try {
    return readFileSync(join(dir, 'delete-requests.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown> | null);
  } catch {
    return [];
  }
}

/**
 * Exercises the real daemon → catalog → shared ACP owner wiring for the generic
 * `acpSessionList` direct-sessions source against a real child process speaking ACP over stdio.
 * Only the provider executable (a genuine system boundary) is substituted.
 */
describe.skipIf(process.platform === 'win32')('registerMachineDirectSessionsRpcHandlers: ACP session/list integration', () => {
  let dir: string;
  let registered: Map<string, (params: unknown) => Promise<unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    dir = mkdtempSync(join(tmpdir(), 'acp-session-list-rpc-'));
    registered = new Map();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler: (method, handler) => {
        registered.set(method, async (params) => handler(params as never));
      },
    };
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists a paginated ACP page as resume-only candidates, preserving opaque session ids byte-exactly', async () => {
    vi.stubEnv('HAPPIER_KIMI_PATH', writeFakeAgent({ dir, fileName: 'fake-kimi.mjs', negotiateList: true }));
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;

    const first = (await handler({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
    })) as ListResponse;

    expect(first.ok).toBe(true);
    // The blank identifier is rejected; the padded identifier is preserved byte-exactly.
    expect(first.candidates?.map((candidate) => candidate.remoteSessionId)).toEqual(['  sess_alpha  ']);
    expect(first.candidates?.[0]?.title).toBe('Alpha');
    expect(first.candidates?.[0]?.updatedAtMs).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(first.capabilities).toEqual({ deleteCandidate: true });
    expect(first.nextCursor).toBe('page-2');

    const second = (await handler({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      cursor: 'page-2',
    })) as ListResponse;

    expect(second.ok).toBe(true);
    expect(second.candidates?.map((candidate) => candidate.remoteSessionId)).toEqual(['sess_beta']);
    expect(second.nextCursor ?? null).toBeNull();

    // cwd and cursor reach the agent unchanged.
    expect(readListRequests(dir)).toEqual([
      { cwd: '/work/repo' },
      { cwd: '/work/repo', cursor: 'page-2' },
    ]);

    // Every agent process the listing round trips started is disposed again.
    await waitForCondition(
      () => countLines(dir, 'started.log') >= 2 && countLines(dir, 'terminated.log') === countLines(dir, 'started.log'),
      { timeoutMs: 5_000, intervalMs: 25, label: 'every listing agent process terminated', debug: () => `started=${countLines(dir, 'started.log')} terminated=${countLines(dir, 'terminated.log')}` },
    );
  }, 30_000);

  it('fails clearly and disposes when the live handshake does not negotiate session listing', async () => {
    vi.stubEnv('HAPPIER_FX_PATH', writeFakeAgent({ dir, fileName: 'fake-fx.mjs', negotiateList: false }));
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;

    const res = (await handler({
      machineId: 'm1',
      providerId: 'fx',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
    })) as ListResponse;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('provider_unavailable');
    expect(res.error).toMatch(/negotiate/i);
    // The failure happens before session/list is dispatched.
    expect(readListRequests(dir)).toEqual([]);
    await waitForCondition(
      () => readFileSync(join(dir, 'terminated.log'), 'utf8').includes('SIGTERM'),
      { timeoutMs: 5_000, intervalMs: 25, label: 'failed listing agent process terminated' },
    );
  }, 30_000);

  it('keeps the ACP listing source unavailable for a provider that does not declare it', async () => {
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;

    const res = (await handler({
      machineId: 'm1',
      providerId: 'claude',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
    })) as ListResponse;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
  });

  it('advertises and dispatches exactly one provider-owned delete after live negotiation', async () => {
    vi.stubEnv('HAPPIER_KIMI_PATH', writeFakeAgent({ dir, fileName: 'fake-kimi.mjs', negotiateList: true }));
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE)!;

    const res = (await handler({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      remoteSessionId: '  sess_alpha  ',
    })) as ListResponse;

    expect(res).toEqual({ ok: true, deleted: true });
    expect(readDeleteRequests(dir)).toEqual([{ sessionId: '  sess_alpha  ' }]);
  });

  it('does not advertise or dispatch delete when the live handshake omits it', async () => {
    vi.stubEnv('HAPPIER_FX_PATH', writeFakeAgent({
      dir,
      fileName: 'fake-fx-no-delete.mjs',
      negotiateList: true,
      negotiateDelete: false,
    }));

    const listed = (await registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!({
      machineId: 'm1',
      providerId: 'fx',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
    })) as ListResponse;
    expect(listed.ok).toBe(true);
    expect(listed.capabilities).toEqual({ deleteCandidate: false });

    const deleted = (await registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE)!({
      machineId: 'm1',
      providerId: 'fx',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      remoteSessionId: 'sess_alpha',
    })) as ListResponse;
    expect(deleted.ok).toBe(false);
    expect(deleted.errorCode).toBe('provider_unavailable');
    expect(deleted.error).toMatch(/negotiate/i);
    expect(readDeleteRequests(dir)).toEqual([]);
  });

  it('surfaces provider delete failures without retrying the destructive request', async () => {
    vi.stubEnv('HAPPIER_KIMI_PATH', writeFakeAgent({
      dir,
      fileName: 'fake-kimi-delete-fails.mjs',
      negotiateList: true,
      deleteFails: true,
    }));

    const res = (await registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE)!({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      remoteSessionId: 'sess_alpha',
    })) as ListResponse;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('internal_error');
    expect(res.error).toMatch(/provider refused deletion/i);
    expect(readDeleteRequests(dir)).toEqual([{ sessionId: 'sess_alpha' }]);
  });

  it('rejects a relative cwd filter instead of resolving it against the daemon working directory', async () => {
    vi.stubEnv('HAPPIER_KIMI_PATH', writeFakeAgent({ dir, fileName: 'fake-kimi.mjs', negotiateList: true }));
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;

    const res = (await handler({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: 'repo' },
    })) as ListResponse;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
    // Rejected before any agent process is launched.
    expect(countLines(dir, 'started.log')).toBe(0);
  });

  it('reports transcript paging and linking as unavailable for ACP listing providers instead of faking them', async () => {
    vi.stubEnv('HAPPIER_KIMI_PATH', writeFakeAgent({ dir, fileName: 'fake-kimi.mjs', negotiateList: true }));
    const { readCredentials } = await import('@/persistence');
    vi.mocked(readCredentials).mockResolvedValueOnce({ token: 'token', secret: new Uint8Array(32) } as never);

    const page = (await registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE)!({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      remoteSessionId: 'sess_alpha',
      direction: 'older',
    })) as ListResponse;
    expect(page.ok).toBe(false);
    expect(page.errorCode).toBe('provider_unavailable');

    const link = (await registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE)!({
      machineId: 'm1',
      providerId: 'kimi',
      source: { kind: 'acpSessionList', cwd: '/work/repo' },
      remoteSessionId: 'sess_alpha',
    })) as ListResponse;
    expect(link.ok).toBe(false);
    expect(link.errorCode).toBe('provider_unavailable');
  });
});
