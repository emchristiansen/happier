import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { isAuthenticationError } from './client/httpStatusError';
import type { ApiSessionClient } from './session/sessionClient';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

type PendingRow = {
  localId?: unknown;
  status?: unknown;
  deliveryState?: unknown;
};
type AuthStatus = 401 | 403;
type SupervisedClientInternals = Readonly<{
  currentConnectionState: ManagedConnectionState;
  sessionConnectionSupervisor: ManagedConnectionSupervisor & Required<Pick<ManagedConnectionSupervisor, 'captureProbeReportScope' | 'reportProbeResult'>>;
}>;

async function expectAuthenticationRejection(promise: Promise<unknown>, status: AuthStatus): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({ response: { status } });
  expect(isAuthenticationError(caught)).toBe(true);
}

function supervisedInternals(client: ApiSessionClient): SupervisedClientInternals {
  return client as unknown as SupervisedClientInternals;
}

async function expectSessionAuthFailed(client: ApiSessionClient): Promise<void> {
  await vi.waitFor(() => {
    expect(supervisedInternals(client).currentConnectionState.phase).toBe('auth_failed');
  });
}

describe('ApiSessionClient pending queue V2 helpers', () => {
  const envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let server: Server | null = null;
  let serverUrl = '';
  let pendingRows: PendingRow[] = [];
  let pendingListStatus: number = 200;
  let pendingListRequestCount = 0;
  let discardRequestCount = 0;
  const discardStatusesByLocalId = new Map<string, number>();
  const discardedLocalIds: string[] = [];

  async function createClient() {
    const { reloadConfiguration } = await import('@/configuration');
    const { ApiSessionClient } = await import('./session/sessionClient');

    const sessionSocket = createApiSessionSocketStub();
    const userSocket = createApiSessionSocketStub();
    bindApiSessionSocketPairMock(mockIo, {
      sessionSocket,
      userSocket,
      fallbackSocket: sessionSocket,
    });

    reloadConfiguration();
    const session = createMockSession({
      metadata: { path: '/tmp', host: 'localhost' },
    });
    return new ApiSessionClient('test-token', session);
  }

  beforeEach(async () => {
    pendingRows = [];
    pendingListStatus = 200;
    pendingListRequestCount = 0;
    discardRequestCount = 0;
    discardStatusesByLocalId.clear();
    discardedLocalIds.length = 0;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/v2/sessions/test-session-id/pending') {
        pendingListRequestCount += 1;
        if (pendingListStatus !== 200) {
          res.statusCode = pendingListStatus;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'auth failed' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ pending: pendingRows }));
        return;
      }

      const discard = url.pathname.match(/^\/v2\/sessions\/test-session-id\/pending\/([^/]+)\/discard$/);
      if (req.method === 'POST' && discard) {
        discardRequestCount += 1;
        const localId = decodeURIComponent(discard[1] ?? '');
        const status = discardStatusesByLocalId.get(localId) ?? 200;
        if (status !== 200) {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'auth failed' }));
          return;
        }
        discardedLocalIds.push(localId);
        pendingRows = pendingRows.filter((row) => row.localId !== localId);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve pending queue test server address');
    }

    serverUrl = `http://127.0.0.1:${address.port}`;
    envScope.patch({
      HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('lists pending localIds from /v2/sessions/:id/pending', async () => {
    pendingRows = [
      { localId: 'a', status: 'queued', deliveryState: null },
      { localId: 'b', status: 'queued', deliveryState: null },
    ];
    const client = await createClient();

    await expect(client.listPendingMessageQueueV2LocalIds()).resolves.toEqual(['a', 'b']);
  });

  it('rejects a malformed successful pending projection instead of treating it as absence', async () => {
    pendingRows = [{ localId: 'a' }, { localId: 123 }];
    const client = await createClient();

    await expect(client.listPendingMessageQueueV2LocalIds()).rejects.toThrow(
      'Invalid pending queue delivery status projection',
    );
  });

  it('peeks pending count via list when local pending state is already known non-empty', async () => {
    pendingRows = [{ localId: 'a', status: 'queued', deliveryState: null }];
    const client = await createClient();
    (client as any).pendingQueueState = {
      known: true,
      pendingCount: 1,
      pendingVersion: 1,
    };

    await expect(client.peekPendingMessageQueueV2Count({ reconcileWhenEmpty: 'skip' })).resolves.toBe(1);
  });

  it('reports authentication failures from pending list calls to the session supervisor', async () => {
    pendingListStatus = 401;
    const client = await createClient();
    const reportProbeResult = vi.spyOn(supervisedInternals(client).sessionConnectionSupervisor, 'reportProbeResult');

    await expectAuthenticationRejection(client.listPendingMessageQueueV2LocalIds(), 401);
    expect(reportProbeResult).toHaveBeenCalledWith(expect.objectContaining({
      status: 'auth_failed',
      statusCode: 401,
    }), expect.any(Object));
    await expectSessionAuthFailed(client);
  });

  it('fails pending list calls before HTTP when the session supervisor is auth_failed', async () => {
    const client = await createClient();
    const supervisor = supervisedInternals(client).sessionConnectionSupervisor;
    supervisor.reportProbeResult({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    }, supervisor.captureProbeReportScope());

    await expectSessionAuthFailed(client);
    await expectAuthenticationRejection(client.listPendingMessageQueueV2LocalIds(), 401);
    expect(pendingListRequestCount).toBe(0);
  });

  it('rejects non-auth pending list failures instead of treating them as an empty queue', async () => {
    pendingListStatus = 500;
    const client = await createClient();

    await expect(client.listPendingMessageQueueV2LocalIds()).rejects.toThrow();
    expect(supervisedInternals(client).currentConnectionState.phase).not.toBe('auth_failed');
  });

  it('discards all pending messages via /discard endpoint', async () => {
    pendingRows = [
      { localId: 'a', status: 'queued', deliveryState: null },
      { localId: 'b', status: 'queued', deliveryState: null },
    ];
    const client = await createClient();

    await expect(client.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(2);
    expect(discardedLocalIds).toEqual(['a', 'b']);
  });

  it('reports authentication failures from pending discard calls to the session supervisor', async () => {
    pendingRows = [{ localId: 'a', status: 'queued', deliveryState: null }];
    discardStatusesByLocalId.set('a', 403);
    const client = await createClient();
    const reportProbeResult = vi.spyOn(supervisedInternals(client).sessionConnectionSupervisor, 'reportProbeResult');

    await expectAuthenticationRejection(client.discardPendingMessageQueueV2All({ reason: 'manual' }), 403);
    expect(reportProbeResult).toHaveBeenCalledWith(expect.objectContaining({
      status: 'auth_failed',
      statusCode: 403,
    }), expect.any(Object));
    await expectSessionAuthFailed(client);
  });

  it('fails pending discard calls before HTTP when the session supervisor is auth_failed', async () => {
    pendingRows = [{ localId: 'a', status: 'queued', deliveryState: null }];
    const client = await createClient();
    const supervisor = supervisedInternals(client).sessionConnectionSupervisor;
    supervisor.reportProbeResult({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    }, supervisor.captureProbeReportScope());

    await expectSessionAuthFailed(client);
    await expectAuthenticationRejection(client.discardPendingMessageQueueV2All({ reason: 'manual' }), 401);
    expect(pendingListRequestCount).toBe(0);
    expect(discardRequestCount).toBe(0);
  });

  it('rejects non-auth pending discard failures instead of treating partial discard as success', async () => {
    pendingRows = [
      { localId: 'a', status: 'queued', deliveryState: null },
      { localId: 'b', status: 'queued', deliveryState: null },
    ];
    discardStatusesByLocalId.set('a', 500);
    const client = await createClient();

    await expect(client.discardPendingMessageQueueV2All({ reason: 'manual' })).rejects.toThrow();
    expect(discardedLocalIds).toEqual([]);
    expect(supervisedInternals(client).currentConnectionState.phase).not.toBe('auth_failed');
  });
});
