import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getSessionStatus } from '@/session/services/getSessionStatus';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

afterEach(() => vi.restoreAllMocks());

const recovery = {
  v: 1, status: 'waiting', issueFingerprint: 'issue-first', armedAtMs: 101,
  runtimeAuthRecoveryAttemptId: 'attempt-first', resetAtMs: null, nextCheckAtMs: 200,
  attemptCount: 1, maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
} as const;

describe('session status recovery snapshot through authenticated HTTP', () => {
  const secret = new Uint8Array(32).fill(4);
  const credentials = { token: 'status-test', encryption: { type: 'legacy' as const, secret } };

  it.each(['plain', 'e2ee'] as const)('projects canonical %s recovery with the exact session and version', async (mode) => {
    const sessions = [101, 202].map((version, index) => createSessionRecordFixture({
      id: `status_session_${index}`, encryptionMode: mode, metadataVersion: version,
      metadata: mode === 'plain'
        ? JSON.stringify({ sessionUsageLimitRecoveryV1: { ...recovery, issueFingerprint: `issue-${index}` } })
        : encodeBase64(encrypt(secret, 'legacy', { sessionUsageLimitRecoveryV1: { ...recovery, issueFingerprint: `issue-${index}` } }), 'base64'),
    }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const session = sessions.find((candidate) => new URL(String(url)).pathname === `/v2/sessions/${candidate.id}`);
      if (!session) throw new Error('Unexpected status test request');
      return { status: 200, data: { session } };
    });
    for (const [index, session] of sessions.entries()) {
      const result = await getSessionStatus({ credentials, idOrPrefix: session.id, live: false });
      expect(result).toMatchObject({ ok: true, session: { id: session.id }, usageLimitRecovery: {
        state: 'present', metadataVersion: session.metadataVersion,
        recovery: { status: 'waiting', issueFingerprint: `issue-${index}`, armedAtMs: 101, runtimeAuthRecoveryAttemptId: 'attempt-first' },
      } });
      if (!result.ok) throw new Error('Expected status');
      if (result.usageLimitRecovery.state !== 'present') throw new Error('Expected canonical recovery');
      expect(Object.keys(result.usageLimitRecovery.recovery).sort()).toEqual([
        'armedAtMs', 'issueFingerprint', 'runtimeAuthRecoveryAttemptId', 'status',
      ]);
    }
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['absent', '{}', 'plain'],
    ['malformed', JSON.stringify({ sessionUsageLimitRecoveryV1: { ...recovery, armedAtMs: 'invented' } }), 'plain'],
    ['malformed', JSON.stringify({ sessionUsageLimitRecoveryV1: null }), 'plain'],
    ['malformed', JSON.stringify({ sessionUsageLimitRecoveryV1: {
      status: 'waiting', issueFingerprint: 'unqualified', armedAtMs: 4,
    } }), 'plain'],
    ['malformed', '[]', 'plain'],
    ['unreadable', '{broken', 'plain'],
    ['unreadable', 'not-ciphertext', 'e2ee'],
  ] as const)('keeps %s metadata distinct (%s)', async (state, metadata, encryptionMode) => {
    const session = createSessionRecordFixture({ id: 'status_session_bad', metadataVersion: 37, encryptionMode, metadata });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
    expect(await getSessionStatus({ credentials, idOrPrefix: session.id, live: false })).toMatchObject({
      ok: true, session: { id: session.id }, usageLimitRecovery: { state, metadataVersion: 37 },
    });
  });

  it('refuses to bind another session record to the requested session', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({
      id: 'status_session_other', encryptionMode: 'plain', metadata: '{}', metadataVersion: 44,
    }) } });
    expect(await getSessionStatus({ credentials, idOrPrefix: 'status_session_expected', live: false }))
      .toEqual({ ok: false, code: 'unsupported' });
  });

  it('binds prefix resolution to that row and accepts an absent optional attempt id', async () => {
    const { runtimeAuthRecoveryAttemptId: _attempt, ...withoutAttempt } = recovery;
    const sessions = [
      createSessionRecordFixture({ id: 'unrelated_session', encryptionMode: 'plain', metadata: '{}', metadataVersion: 99 }),
      createSessionRecordFixture({ id: 'chosen_session_full', encryptionMode: 'plain',
        metadata: JSON.stringify({ sessionUsageLimitRecoveryV1: withoutAttempt }), metadataVersion: 22 }),
    ];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname;
      expect(['/v2/sessions', '/v2/sessions/archived']).toContain(pathname);
      return { status: 200, data: { sessions: pathname.endsWith('/archived') ? [] : sessions, hasNext: false, nextCursor: null } };
    });
    expect(await getSessionStatus({ credentials, idOrPrefix: 'chosen', live: false })).toMatchObject({
      ok: true, session: { id: 'chosen_session_full' }, usageLimitRecovery: {
        state: 'present', metadataVersion: 22,
        recovery: { status: 'waiting', issueFingerprint: recovery.issueFingerprint, armedAtMs: recovery.armedAtMs },
      },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

describe('happier session status (action executor)', () => {
  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, session: { id: 'sess-1' }, agentState: { provider: 'codex' } },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['status', 'sess-1', '--live', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'session.status.get',
        { sessionId: 'sess-1', live: true },
        { surface: 'cli', defaultSessionId: null },
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_status',
        data: { session: { id: 'sess-1' }, agentState: { provider: 'codex' }, usageLimitRecovery: { state: 'unsupported' } },
      }));
    } finally {
      output.restore();
    }
  });

  it('keeps the recovery identity/version from the action result in CLI JSON', async () => {
    const usageLimitRecovery = { state: 'present', metadataVersion: 19, recovery: {
      status: 'waiting', issueFingerprint: 'issue-first', armedAtMs: 101,
    } };
    execute.mockResolvedValueOnce({ ok: true, result: { ok: true, session: { id: 'sess-2' }, usageLimitRecovery } });
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['status', 'sess-2', '--json'], {
        readCredentialsFn: async () => ({ token: 'test-token', encryption: null }),
      });
      expect(output.json().data).toEqual({ session: { id: 'sess-2' }, usageLimitRecovery });
    } finally { output.restore(); }
  });
});
