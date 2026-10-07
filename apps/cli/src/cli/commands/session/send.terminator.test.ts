import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { reloadConfiguration } from '@/configuration';
import { handleSessionCommand } from './handleSessionCommand';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
// Only relay HTTP and socket transports are substituted; the send owners are real.
vi.mock('socket.io-client', () => ({ io: mockIo }));

it('delivers the caller-selected local id and waits with options after a literal message terminator', async () => {
  const sessionId = 'c123456789012345678901234';
  const selectedLocalId = 'claim-1';
  const app = Fastify();
  let localId = '';
  const user = () => ({ id: 'msg-user', seq: 1, localId, createdAt: 1, updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '-message' } } } });
  app.all('*', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === `/v2/sessions/${sessionId}`) return { session: {
      id: sessionId, seq: 2, createdAt: 1, updatedAt: 2, active: true, activeAt: 1,
      encryptionMode: 'plain', metadata: '{}', metadataVersion: 1,
      agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    } };
    if (path === '/v1/account/encryption/currentness') return {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    };
    if (path === '/v2/account/settings') return { version: 1, content: { t: 'plain', v: {} } };
    if (request.method === 'POST' && path === `/v2/sessions/${sessionId}/pending`) {
      const body = request.body as { localId: string; content: unknown };
      localId = body.localId;
      expect(body.content).toMatchObject({ t: 'plain', v: { content: { type: 'text', text: '-message' } } });
      return { didWrite: true };
    }
    if (path === `/v2/sessions/${sessionId}/messages/by-local-id/${encodeURIComponent(localId)}`) {
      return { message: user() };
    }
    if (path === `/v1/sessions/${sessionId}/messages`) return { messages: [user(), {
      id: 'msg-complete', seq: 2, localId: null, createdAt: 2, updatedAt: 2,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: { type: 'task_complete' } } } },
    }] };
    return reply.code(404).send({ error: 'unexpected_fixture_route', path });
  });
  const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'http://relay.test' });
  vi.stubEnv('HAPPIER_SERVER_URL', 'http://relay.test');
  vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'http://relay.test');
  vi.stubEnv('HAPPIER_SESSION_ID', '');
  bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({ emit: (_event, args) => {
    const acknowledge = args[1];
    if (typeof acknowledge === 'function') acknowledge({ ok: true, result: { ok: true } });
  } }));
  const output = captureConsoleJsonOutput();
  try {
    reloadConfiguration();
    await handleSessionCommand(['send', sessionId, '--local-id', selectedLocalId, '--', '-message', '--json', '--wait'], {
      readCredentialsFn: async () => ({ token: 'fixture_token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }),
    });
    expect(user()).toMatchObject({ localId: selectedLocalId, content: { t: 'plain', v: { content: { text: '-message' } } } });
    expect(output.json()).toMatchObject({ ok: true, kind: 'session_send', data: { sessionId, localId: selectedLocalId, waited: true } });
  } finally {
    output.restore();
    restoreHttp();
    vi.unstubAllEnvs();
    await app.close();
  }
});
