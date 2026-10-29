import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createEnvKeyScope } from '@/testkit/env/envScope';

function createLegacyCredentials() {
  return {
    token: 'token-1',
    encryption: {
      type: 'legacy' as const,
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('sessionControl.sessionsHttp authentication status handling', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_ENCRYPTION_REQUIREMENT']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_ENCRYPTION_REQUIREMENT']);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
  });

  async function prepareReplayCreationHttp(
    storagePolicy: 'optional' | 'plaintext_only' | 'required_e2ee',
    requirement: 'follow_account' | 'require_e2ee' = 'follow_account',
  ) {
    envScope.patch({
      HAPPIER_SERVER_URL: 'https://replay.example.test',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_ENCRYPTION_REQUIREMENT: requirement,
    });
    vi.resetModules();
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://replay.example.test/v1/features');
      return new Response(JSON.stringify({
        features: {},
        capabilities: { encryption: { storagePolicy, allowAccountOptOut: true, defaultAccountMode: 'e2ee' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(url).toBe('https://replay.example.test/v1/account/encryption');
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data: unknown) => {
      expect(String(url)).toMatch(/^https:\/\/replay\.example\.test\/v1\/sessions(?:\?|$)/);
      // The HTTP boundary echoes the real serializer's payload into a canonical session fixture.
      const body = data as { metadata: string; agentState: string | null; dataEncryptionKey: string | null; encryptionMode?: 'e2ee' | 'plain' };
      return {
        status: 200,
        data: {
          resolution: 'created',
          session: createSessionRecordFixture({
            id: 'replay-child', metadata: body.metadata, agentState: body.agentState,
            dataEncryptionKey: body.dataEncryptionKey, encryptionMode: body.encryptionMode,
          }),
        },
      };
    });
    return { post, getOrCreateSessionByTag: (await import('./sessionsHttp')).getOrCreateSessionByTag };
  }

  it.each(['optional', 'plaintext_only'] as const)('creates a token-only plain replay row through the real %s policy selector', async (policy) => {
    const { post, getOrCreateSessionByTag } = await prepareReplayCreationHttp(policy);
    const metadata = { path: '/repo', replaySeedV1: { v: 1, seedText: 'prior conversation', sourceSessionId: 'parent', sourceCutoffSeqInclusive: 7, createdAtMs: 1 } };
    const agentState = { controlledByUser: true };
    const created = await getOrCreateSessionByTag({ credentials: { token: 'token-only', encryption: null }, tag: 'replay:parent:7', metadata, agentState });
    expect(created).toMatchObject({ created: true, session: { id: 'replay-child', encryptionMode: 'plain', dataEncryptionKey: null } });
    expect(JSON.parse(created.session.metadata!)).toMatchObject(metadata);
    expect(JSON.parse(created.session.agentState!)).toEqual(agentState);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(['legacy', 'dataKey'] as const)('preserves %s encrypted replay row payloads when E2EE is selected', async (variant) => {
    const { post, getOrCreateSessionByTag } = await prepareReplayCreationHttp('required_e2ee');
    const credentials: Credentials = variant === 'legacy' ? createLegacyCredentials() : {
      token: 'keyed', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(3), machineKey: new Uint8Array(32).fill(7) },
    };
    const metadata = { path: '/repo' };
    const agentState = { controlledByUser: true };
    const created = await getOrCreateSessionByTag({ credentials, tag: 'replay:encrypted', metadata, agentState });
    expect(created.session.encryptionMode).toBe('e2ee');
    expect(created.session.metadata).not.toBe(JSON.stringify(metadata));
    expect(created.session.agentState).not.toBe(JSON.stringify(agentState));
    if (credentials.encryption?.type === 'legacy') {
      expect(decrypt(credentials.encryption.secret, 'legacy', decodeBase64(created.session.metadata!))).toEqual(metadata);
      expect(decrypt(credentials.encryption.secret, 'legacy', decodeBase64(created.session.agentState!))).toEqual(agentState);
      expect(created.session.dataEncryptionKey).toBeNull();
    } else {
      expect(decodeBase64(created.session.dataEncryptionKey!)[0]).toBe(0);
      expect(decodeBase64(created.session.dataEncryptionKey!).length).toBeGreaterThan(1);
    }
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses token-only encrypted replay creation before posting a row', async () => {
    const { post, getOrCreateSessionByTag } = await prepareReplayCreationHttp('required_e2ee');
    await expect(getOrCreateSessionByTag({ credentials: { token: 'token-only', encryption: null }, tag: 'replay:key-required', metadata: { path: '/repo' }, agentState: null }))
      .rejects.toMatchObject({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses token-only plain replay creation when the real client policy requires E2EE', async () => {
    const { post, getOrCreateSessionByTag } = await prepareReplayCreationHttp('optional', 'require_e2ee');
    await expect(getOrCreateSessionByTag({ credentials: { token: 'token-only', encryption: null }, tag: 'replay:client-policy', metadata: { path: '/repo' }, agentState: null }))
      .rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
    expect(post).not.toHaveBeenCalled();
  });

  it('throws a stable auth status error for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(fetchSessionById({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('throws a stable auth status error for fetchSessionsPage', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionsPage } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 403, data: {} } as never);

    await expect(fetchSessionsPage({ token: 'token-1', limit: 10 })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
      code: 'not_authenticated',
    });
  });

  it('preserves retryable non-auth http statuses for fetchSessionByIdCompat', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionByIdCompat } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 503, data: {} } as never);

    await expect(fetchSessionByIdCompat({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 503 },
    });
  });

  it('preserves retryable non-auth http statuses for fetchSessionById', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { fetchSessionById } = await import('./sessionsHttp');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 503, data: {} } as never);

    await expect(fetchSessionById({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 503 },
    });
  });

  it('throws a stable auth status error for commitSessionStoredMessage without losing session-not-found semantics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitSessionStoredMessage } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(
      commitSessionStoredMessage({
        token: 'token-1',
        sessionId: 'sess-1',
        content: { t: 'plain', v: { type: 'user', text: 'hi' } },
        localId: 'local-1',
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });

    vi.restoreAllMocks();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 404, data: {} } as never);

    await expect(
      commitSessionStoredMessage({
        token: 'token-1',
        sessionId: 'sess-1',
        content: { t: 'plain', v: { type: 'user', text: 'hi' } },
        localId: 'local-2',
      }),
    ).rejects.toMatchObject({
      message: 'Session not found',
      code: 'session_not_found',
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('throws a stable auth status error for getOrCreateSessionByTag', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.doMock('@/api/session/resolveSessionCreateEncryptionMode', () => ({
      resolveSessionCreateEncryptionMode: vi.fn(async () => ({
        desiredSessionEncryptionMode: 'plain',
        serverSupportsFeatureSnapshot: true,
      })),
    }));
    vi.resetModules();
    const { getOrCreateSessionByTag } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    await expect(
      getOrCreateSessionByTag({
        credentials: createLegacyCredentials(),
        tag: 'tag-1',
        metadata: { title: 'hello' },
        agentState: null,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('keeps archive domain errors distinct while normalizing auth failures', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { archiveSession } = await import('./sessionsHttp');

    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as never);

    const authError = await archiveSession({ token: 'token-1', sessionId: 'sess-1' }).catch((error) => error);
    expect(authError).toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });

    vi.restoreAllMocks();
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 409, data: {} } as never);

    await expect(archiveSession({ token: 'token-1', sessionId: 'sess-1' })).rejects.toMatchObject({
      message: 'Cannot archive an active session',
      code: 'session_active',
    });
  });
});
