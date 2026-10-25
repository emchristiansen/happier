import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ManagedConnectionState, ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { isAuthenticationError } from './client/httpStatusError';
import type { ApiSessionClient } from './session/sessionClient';
import { discardQueuedAndPendingForLocalSwitch } from '@/agent/localControl/discardQueuedAndPendingForLocalSwitch';
import { startLocalPendingQueueRemoteSwitchWatcher } from '@/agent/localControl/pendingQueue/startLocalPendingQueueRemoteSwitchWatcher';
import { requestSwitchToLocal } from '@/backends/codex/localControl/requestSwitchToLocal';
import { runCodexLocalModePass } from '@/backends/codex/runtime/localModePass';

const { mockIo, mockConfirmDiscard } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  mockConfirmDiscard: vi.fn(async (_params: { serverCount: number }) => false),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('@/agent/localControl/confirmDiscardBeforeSwitchToLocal', () => ({
  confirmDiscardQueuedMessagesForSwitchToLocal: mockConfirmDiscard,
}));

type PendingRow = {
  localId?: unknown;
  status?: unknown;
  deliveryState?: unknown;
  [field: string]: unknown;
};
type AuthStatus = 401 | 403;
type SupervisedClientInternals = Readonly<{
  currentConnectionState: ManagedConnectionState;
  sessionConnectionSupervisor: ManagedConnectionSupervisor & Required<Pick<ManagedConnectionSupervisor, 'reportProbeResult'>>;
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
    mockConfirmDiscard.mockClear();
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

    await expect(client.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'skip' })).resolves.toBe(1);
  });

  it('reports authentication failures from pending list calls to the session supervisor', async () => {
    pendingListStatus = 401;
    const client = await createClient();
    const reportProbeResult = vi.spyOn(supervisedInternals(client).sessionConnectionSupervisor, 'reportProbeResult');

    await expectAuthenticationRejection(client.listPendingMessageQueueV2LocalIds(), 401);
    expect(reportProbeResult).toHaveBeenCalledWith(expect.objectContaining({
      status: 'auth_failed',
      statusCode: 401,
    }));
    await expectSessionAuthFailed(client);
  });

  it('fails pending list calls before HTTP when the session supervisor is auth_failed', async () => {
    const client = await createClient();
    supervisedInternals(client).sessionConnectionSupervisor.reportProbeResult({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    });

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
    }));
    await expectSessionAuthFailed(client);
  });

  it('fails pending discard calls before HTTP when the session supervisor is auth_failed', async () => {
    pendingRows = [{ localId: 'a', status: 'queued', deliveryState: null }];
    const client = await createClient();
    supervisedInternals(client).sessionConnectionSupervisor.reportProbeResult({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'expired token',
    });

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

  describe('action counts on a queue holding rows the runner cannot act on', () => {
    // Rows in the exact shape the server's `toPendingJson` sends.
    function serverRow(localId: string, fields: Readonly<Record<string, unknown>>): PendingRow {
      return {
        localId,
        messageRole: 'user',
        content: { t: 'encrypted', c: `cipher-${localId}` },
        requestedAction: { v: 1, kind: 'send_now' },
        status: 'queued',
        position: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        discardedAt: null,
        discardedReason: null,
        authorAccountId: 'account-1',
        ...fields,
      };
    }
    // Enqueued by the app with `deliveryMode: 'external_handoff'`: custody is outside this runner.
    const handoffRow = serverRow('handoff', {
      deliveryState: 'external_handoff',
      deliveryStatus: { status: 'external_handoff' },
    });
    // A requested action the server cannot parse: typed blocked over persisted queued fields.
    const malformedActionRow = serverRow('malformed-action', {
      requestedAction: undefined,
      requestedActionMalformed: true,
      deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
    });
    const queuedRow = serverRow('queued', { deliveryStatus: { status: 'queued' } });

    const blockedRow = serverRow('blocked', {
      deliveryState: 'blocked',
      deliveryBlockedReason: 'runtime_disposed_before_delivery',
      deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
    });
    const deliveringRow = serverRow('delivering', {
      deliveryState: 'delivering',
      deliveryStatus: { status: 'delivering', detail: 'awaiting_acceptance' },
    });

    // Rows the parser newly lets through; the base parser rejected the whole snapshot on them.
    const newlyParsedNotActionable = [
      ['an external-handoff row', [handoffRow]],
      ['a malformed-action row', [malformedActionRow]],
    ] as const;
    // Row kinds the base parser already read and counted; their decisions must not change.
    // A malformed action the server already persisted as blocked: raw and typed status agree, so the
    // base parser read it.
    const persistedBlockedMalformedActionRow = serverRow('persisted-blocked-malformed-action', {
      requestedAction: undefined,
      requestedActionMalformed: true,
      deliveryState: 'blocked',
      deliveryBlockedReason: 'unsupported_action',
      deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
    });
    const countedBeforeHandoffParsing = [
      ['a blocked row', [blockedRow]],
      ['a delivering row', [deliveringRow]],
      ['a malformed-action row already persisted as blocked', [persistedBlockedMalformedActionRow]],
    ] as const;

    function markPendingKnownNonEmpty(client: ApiSessionClient): void {
      (client as any).pendingQueueState = {
        known: true,
        pendingCount: pendingRows.length,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      };
    }

    function emptyLocalQueue() {
      return { queue: [], size: () => 0, reset: () => {} };
    }

    /**
     * Runs the local-mode remote-switch watcher through one pending wake with the read the Claude
     * (`claudeLocalLauncher.ts`) and Codex (`codexLocalLauncher.ts`) local launchers pass it.
     */
    async function didWatcherRequestRemoteSwitchAfterWake(client: ApiSessionClient): Promise<boolean> {
      const requestRemoteSwitch = vi.fn(async () => true);
      let markInspected!: () => void;
      const inspected = new Promise<void>((resolve) => {
        markInspected = resolve;
      });
      let waits = 0;
      const watcher = startLocalPendingQueueRemoteSwitchWatcher({
        peekPendingCount: () => client.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'skip', reason: 'passive-wait' }),
        requestRemoteSwitch: async () => {
          const switched = await requestRemoteSwitch();
          markInspected();
          return switched;
        },
        waitForPendingQueueUpdate: (signal) => {
          waits += 1;
          if (waits === 1) return Promise.resolve(true);
          markInspected();
          return new Promise<boolean>((resolve) => {
            signal?.addEventListener('abort', () => resolve(false), { once: true });
          });
        },
      });
      await inspected;
      watcher.stop();
      return requestRemoteSwitch.mock.calls.length > 0;
    }

    it.each(newlyParsedNotActionable)('keeps local mode on a pending wake when the queue holds only %s', async (_case, rows) => {
      pendingRows = [...rows];
      const client = await createClient();
      markPendingKnownNonEmpty(client);

      await expect(didWatcherRequestRemoteSwitchAfterWake(client)).resolves.toBe(false);
      expect(pendingListRequestCount).toBe(1);
    });

    it('switches to remote on a pending wake when actionable work sits beside a handed-off row', async () => {
      pendingRows = [handoffRow, malformedActionRow, queuedRow];
      const client = await createClient();
      markPendingKnownNonEmpty(client);

      await expect(didWatcherRequestRemoteSwitchAfterWake(client)).resolves.toBe(true);
      // The complete inventory read still reports every row for its observational callers.
      await expect(client.listPendingMessageQueueV2LocalIds()).resolves.toEqual(['handoff', 'malformed-action', 'queued']);
    });

    describe('rows counted before this change', () => {
      it.each(countedBeforeHandoffParsing)('switches to remote on a pending wake for %s', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        await expect(didWatcherRequestRemoteSwitchAfterWake(client)).resolves.toBe(true);
      });

      it.each(countedBeforeHandoffParsing)('asks to discard %s at the Claude local-entry gate', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        await expect(discardQueuedAndPendingForLocalSwitch({
          queue: emptyLocalQueue(),
          getServerPendingCount: () => client.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'force', reason: 'manual-check' }),
          discardServerPending: () => client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
          markQueuedAsDiscarded: async () => 0,
          sendStatusMessage: () => {},
          formatError: String,
        })).resolves.toBe('cancelled');
        expect(mockConfirmDiscard).toHaveBeenCalledWith(expect.objectContaining({ serverCount: 1 }));
      });

      it.each(countedBeforeHandoffParsing)('asks to discard %s before the Codex explicit switch to local', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        markPendingKnownNonEmpty(client);
        const requestSwitch = vi.fn(async () => {});

        await expect(requestSwitchToLocal({
          queue: emptyLocalQueue(),
          session: client,
          resolveLocalSwitchAvailability: async () => ({ ok: true }),
          requestSwitch,
          formatSwitchDeniedMessage: String,
          formatError: String,
        })).resolves.toBe(false);
        expect(requestSwitch).not.toHaveBeenCalled();
        expect(mockConfirmDiscard).toHaveBeenCalledWith(expect.objectContaining({ serverCount: 1 }));
      });

      it.each(countedBeforeHandoffParsing)('gates the Codex local-mode pass on %s', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        const launchLocal = vi.fn(async () => ({ type: 'exit' as const, code: 0 }));
        const discardController = vi.fn(async (args: { getServerPendingCount: () => Promise<number> }) => {
          await args.getServerPendingCount();
          return 'cancelled' as const;
        });

        await expect(runCodexLocalModePass({
          session: client,
          messageQueue: emptyLocalQueue() as any,
          workspaceDir: '/workspace',
          api: {},
          permissionMode: 'default',
          resumeId: null,
          formatError: String,
          launchLocal,
          discardController: discardController as any,
        })).resolves.toEqual({ type: 'remote', resumeId: null });
        expect(launchLocal).not.toHaveBeenCalled();
        await expect(discardController.mock.calls[0]![0].getServerPendingCount()).resolves.toBe(1);
      });
    });

    it('discards the rows the base read on switch to local, leaving handed-off and raw-queued malformed-action rows', async () => {
      pendingRows = [queuedRow, handoffRow, malformedActionRow, blockedRow, persistedBlockedMalformedActionRow];
      const client = await createClient();

      await expect(client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' })).resolves.toBe(3);
      expect(discardedLocalIds).toEqual(['queued', 'blocked', 'persisted-blocked-malformed-action']);
    });

    it('discards exactly the rows a confirmed switch-to-local prompt counted', async () => {
      pendingRows = [queuedRow, malformedActionRow];
      const client = await createClient();
      markPendingKnownNonEmpty(client);
      mockConfirmDiscard.mockResolvedValueOnce(true);

      await expect(discardQueuedAndPendingForLocalSwitch({
        queue: emptyLocalQueue(),
        getServerPendingCount: () => client.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'force', reason: 'manual-check' }),
        discardServerPending: () => client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
        markQueuedAsDiscarded: async () => 0,
        sendStatusMessage: () => {},
        formatError: String,
      })).resolves.toBe('proceed');
      expect(mockConfirmDiscard).toHaveBeenCalledWith(expect.objectContaining({ serverCount: 1 }));
      expect(discardedLocalIds).toEqual(['queued']);
    });

    it('still switches for locally materialized input not yet observed when only a handed-off row remains', async () => {
      pendingRows = [handoffRow];
      const client = await createClient();
      markPendingKnownNonEmpty(client);
      (client as any).pendingQueueMaterializedLocalIds.add('materialized-in-flight');

      await expect(didWatcherRequestRemoteSwitchAfterWake(client)).resolves.toBe(true);
    });

    describe('Claude local-entry discard gate', () => {
      async function runGate(client: ApiSessionClient) {
        return await discardQueuedAndPendingForLocalSwitch({
          queue: emptyLocalQueue(),
          getServerPendingCount: () => client.peekActionablePendingMessageQueueV2Count({ reconcileWhenEmpty: 'force', reason: 'manual-check' }),
          discardServerPending: () => client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
          markQueuedAsDiscarded: async () => 0,
          sendStatusMessage: () => {},
          formatError: String,
        });
      }

      it.each(newlyParsedNotActionable)('enters local mode without confirmation when the queue holds only %s', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        await expect(runGate(client)).resolves.toBe('proceed');
        expect(mockConfirmDiscard).not.toHaveBeenCalled();
        expect(discardRequestCount).toBe(0);
      });

      it('asks to discard only the actionable rows beside a handed-off row', async () => {
        pendingRows = [handoffRow, queuedRow];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        await expect(runGate(client)).resolves.toBe('cancelled');
        expect(mockConfirmDiscard).toHaveBeenCalledWith(expect.objectContaining({ serverCount: 1 }));
        expect(discardRequestCount).toBe(0);
      });
    });

    describe('Codex explicit switch to local', () => {
      async function runSwitch(client: ApiSessionClient) {
        const requestSwitch = vi.fn(async () => {});
        const switched = await requestSwitchToLocal({
          queue: emptyLocalQueue(),
          session: client,
          resolveLocalSwitchAvailability: async () => ({ ok: true }),
          requestSwitch,
          formatSwitchDeniedMessage: String,
          formatError: String,
        });
        return { switched, requestSwitch };
      }

      it.each(newlyParsedNotActionable)('switches without confirmation when the queue holds only %s', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        const { switched, requestSwitch } = await runSwitch(client);
        expect(switched).toBe(true);
        expect(requestSwitch).toHaveBeenCalledTimes(1);
        expect(mockConfirmDiscard).not.toHaveBeenCalled();
        expect(discardRequestCount).toBe(0);
      });

      it('asks to discard only the actionable rows beside a handed-off row', async () => {
        pendingRows = [handoffRow, queuedRow];
        const client = await createClient();
        markPendingKnownNonEmpty(client);

        const { switched, requestSwitch } = await runSwitch(client);
        expect(switched).toBe(false);
        expect(requestSwitch).not.toHaveBeenCalled();
        expect(mockConfirmDiscard).toHaveBeenCalledWith(expect.objectContaining({ serverCount: 1 }));
      });
    });

    describe('Codex local-mode pass (reads the queue directly)', () => {
      async function runPass(client: ApiSessionClient) {
        const launchLocal = vi.fn(async () => ({ type: 'exit' as const, code: 0 }));
        const discardController = vi.fn(async (args: { getServerPendingCount: () => Promise<number> }) => {
          await args.getServerPendingCount();
          return 'cancelled' as const;
        });
        const result = await runCodexLocalModePass({
          session: client,
          messageQueue: emptyLocalQueue() as any,
          workspaceDir: '/workspace',
          api: {},
          permissionMode: 'default',
          resumeId: null,
          formatError: String,
          launchLocal,
          discardController: discardController as any,
        });
        return { result, launchLocal, discardController };
      }

      it.each(newlyParsedNotActionable)('launches local mode without the discard gate when the queue holds only %s', async (_case, rows) => {
        pendingRows = [...rows];
        const client = await createClient();

        const { result, launchLocal, discardController } = await runPass(client);
        expect(result).toEqual({ type: 'exit' });
        expect(launchLocal).toHaveBeenCalledTimes(1);
        expect(discardController).not.toHaveBeenCalled();
      });

      it('gates local launch on the actionable rows beside a handed-off row', async () => {
        pendingRows = [handoffRow, queuedRow];
        const client = await createClient();

        const { result, launchLocal, discardController } = await runPass(client);
        expect(result).toEqual({ type: 'remote', resumeId: null });
        expect(launchLocal).not.toHaveBeenCalled();
        expect(discardController).toHaveBeenCalledTimes(1);
        await expect(discardController.mock.calls[0]![0].getServerPendingCount()).resolves.toBe(1);
      });
    });
  });
});
