import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const origin = 'https://relay.example.invalid';
const scratch = join(tmpdir(), 'account-settings-retry-fixture');
let sessionSocket: ApiSessionSocketStub;
let userSocket: ApiSessionSocketStub;
let readSettings: () => Promise<unknown>;
const settingsRequests = vi.fn();
let activeSettingsRequests = 0;
let maxActiveSettingsRequests = 0;

// These are the actual HTTP/socket system boundaries. All internal session/settings owners run.
vi.mock('axios', async () => {
  const { createOfflineAxios } = await import('@/testkit/http/offlineAxios');
  return { default: createOfflineAxios(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v2/account/settings') {
      settingsRequests();
      activeSettingsRequests += 1;
      maxActiveSettingsRequests = Math.max(maxActiveSettingsRequests, activeSettingsRequests);
      try { return await readSettings(); }
      finally { activeSettingsRequests -= 1; }
    }
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'retry-account' } };
    if (path === '/health') return { status: 200, data: {} };
    if (path === '/v1/features') return { status: 200, data: features };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [], hasMore: false } };
    throw new Error(`Unconfigured offline settings GET: ${url}`);
  }) };
});

vi.mock('socket.io-client', () => ({
  io: (url: string, options: { auth: { clientType: string } }) => {
    if (url !== origin) throw new Error(`Offline socket refused origin: ${url}`);
    if (options.auth.clientType === 'user-scoped') return userSocket;
    if (options.auth.clientType === 'session-scoped') return sessionSocket;
    throw new Error('Unconfigured offline socket client type');
  },
}));

const features = {
  features: { sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: false } } },
  capabilities: {},
};
let clientModule: typeof import('./sessionClient');
let createPlainSessionFixture: typeof import('@/testkit/backends/sessionFixtures')['createPlainSessionFixture'];
let snapshots: typeof import('@/settings/accountSettings/activeAccountSettingsSnapshot');
let logger: typeof import('@/ui/logger')['logger'];
const clients: import('./sessionClient').ApiSessionClient[] = [];

function settings(version = 1) {
  return {
    status: 200,
    data: { version, content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } } },
  };
}

function createClient() {
  sessionSocket = createApiSessionSocketStub({ id: 'settings-session', connected: true });
  userSocket = createApiSessionSocketStub({ id: 'settings-user', connected: false });
  const originalFixture = createPlainSessionFixture({ id: 'settings-retry-session' });
  const fixture = { ...originalFixture, metadata: {
    ...originalFixture.metadata,
    path: scratch,
    homeDir: scratch,
    happyHomeDir: scratch,
    happyLibDir: scratch,
    happyToolsDir: scratch,
  } };
  const client = new clientModule.ApiSessionClient('synthetic-settings-token', fixture);
  clients.push(client);
  client.onUserMessage(() => {});
  return client;
}

describe('ApiSessionClient account settings retry', () => {
  beforeAll(async () => {
    vi.stubEnv('HAPPIER_SERVER_URL', origin);
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', origin);
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', origin);
    vi.stubEnv('HAPPIER_WEBAPP_URL', origin);
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', '0');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== origin || url.pathname !== '/v1/features') {
        throw new Error(`Unconfigured offline fetch: ${url.href}`);
      }
      return new Response(JSON.stringify(features), { status: 200 });
    }));
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    clientModule = await import('./sessionClient');
    ({ createPlainSessionFixture } = await import('@/testkit/backends/sessionFixtures'));
    snapshots = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    ({ logger } = await import('@/ui/logger'));
    const { writeCredentialsLegacy } = await import('@/persistence');
    await writeCredentialsLegacy({ token: 'synthetic-settings-token', secret: new Uint8Array(32).fill(9) });
  }, 120_000);

  beforeEach(() => {
    settingsRequests.mockClear();
    activeSettingsRequests = 0;
    maxActiveSettingsRequests = 0;
    snapshots.resetActiveAccountSettingsSnapshotForTests();
    readSettings = async () => settings();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('recovers a failed settings read on the same connection without another event', async () => {
    const failed = createDeferred<void>();
    readSettings = async () => {
      if (settingsRequests.mock.calls.length === 1) {
        failed.resolve();
        throw new Error('synthetic offline transport failure');
      }
      return settings(4);
    };
    const client = await createClient();
    const abort = new AbortController();
    let observed: boolean | null = null;
    const wait = client.waitForPendingEligibilityUpdate(abort.signal).then((value) => { observed = value; return value; });
    try {
      await failed.promise;
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(2));
      await expect(wait).resolves.toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
      expect(observed).toBe(true);
    } finally {
      abort.abort();
      await wait;
    }
  });

  it('recovers settings convergence after its live source disconnects before applying', async () => {
    const client = createClient();
    await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
    const owner = client as unknown as {
      accountSettingsSyncBarrier: Promise<boolean> | null;
      accountSettingsSyncBarrierState: string | null;
    };
    userSocket.trigger('update', {
      id: 'settings-source-disconnect', seq: 1, createdAt: Date.now(),
      body: { t: 'update-account', id: 'retry-account', settingsV2: settings(2).data },
    });
    userSocket.connected = false;
    const failedBarrier = owner.accountSettingsSyncBarrier;
    await expect(failedBarrier).resolves.toBe(false);
    expect(owner.accountSettingsSyncBarrierState).toBe('failed');
    expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(1);

    readSettings = async () => ({
      status: 200,
      data: { version: 3, content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } } },
    });
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      await expect(wait).resolves.toBe(true);
      expect(owner.accountSettingsSyncBarrier).toBeNull();
      expect(owner.accountSettingsSyncBarrierState).toBeNull();
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(3);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settings.sessionPendingQueueDeliveryTiming)
        .toBe('after_foreground_ready');
      expect(maxActiveSettingsRequests).toBe(1);
    } finally {
      abort.abort();
      await wait;
    }
  });

  it('shares recovery across waiters and keeps it alive when one waiter aborts', async () => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise : Promise.resolve(settings(5));
    };
    const client = await createClient();
    const aborted = new AbortController();
    const retained = new AbortController();
    const firstWait = client.waitForPendingEligibilityUpdate(aborted.signal);
    const secondWait = client.waitForPendingEligibilityUpdate(retained.signal);
    try {
      await requested.promise;
      aborted.abort();
      await expect(firstWait).resolves.toBe(false);
      firstRead.reject(new Error('synthetic shared settings read failure'));
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(2));
      await expect(secondWait).resolves.toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
    } finally {
      aborted.abort();
      retained.abort();
      await Promise.all([firstWait, secondWait]);
    }
  });

  it('retains server retry guidance across a genuine pending wake', async () => {
    const failed = createDeferred<void>();
    readSettings = async () => {
      if (settingsRequests.mock.calls.length === 1) {
        failed.resolve();
        return { status: 503, headers: { 'retry-after': '120' }, data: {} };
      }
      return settings(6);
    };
    const client = await createClient();
    const abort = new AbortController();
    const firstWait = client.waitForPendingEligibilityUpdate(abort.signal);
    let secondWait: Promise<boolean> | undefined;
    try {
      await failed.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      sessionSocket.trigger('update', {
        id: 'genuine-pending-event', seq: 1, createdAt: Date.now(),
        body: { t: 'pending-changed', sid: 'settings-retry-session', pendingVersion: 1, pendingCount: 1 },
      });
      await expect(firstWait).resolves.toBe(true);
      secondWait = client.waitForPendingEligibilityUpdate(abort.signal);
      await vi.advanceTimersByTimeAsync(118_999);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(secondWait).resolves.toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(6);
    } finally {
      abort.abort();
      await Promise.all([firstWait, secondWait]);
    }
  });

  it('waits for a replaced in-flight read and honors its server guidance after reconnect', async () => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise : Promise.resolve(settings(7));
    };
    const client = await createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      await requested.promise;
      userSocket.trigger('connect');
      await vi.advanceTimersByTimeAsync(0);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      firstRead.resolve({ status: 503, headers: { 'retry-after': '120' }, data: {} });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expect(wait).resolves.toBe(true);
      expect(settingsRequests).toHaveBeenCalledTimes(2);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    } finally {
      abort.abort();
      firstRead.resolve(settings(0));
      await wait;
    }
  });

  it('routes a settings hint through the shared flight and retains its minimum version', async () => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise
        : Promise.resolve(settings(settingsRequests.mock.calls.length === 2 ? 8 : 9));
    };
    const client = await createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      await requested.promise;
      userSocket.trigger('update', {
        id: 'settings-hint-during-read', seq: 1, createdAt: Date.now(),
        body: { t: 'account-settings-changed', settingsVersion: 9 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      firstRead.resolve({ status: 503, headers: { 'retry-after': '120' }, data: {} });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(3));
      await expect(wait).resolves.toBe(true);
      expect(settingsRequests).toHaveBeenCalledTimes(3);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
    } finally {
      abort.abort();
      firstRead.resolve(settings(0));
      await wait;
    }
  });

  it.each([401, 403])('stops retries after terminal authentication HTTP %s', async (status) => {
    const failed = createDeferred<void>();
    readSettings = async () => {
      failed.resolve();
      return { status, headers: {}, data: {} };
    };
    const client = await createClient();
    const abort = new AbortController();
    let observed: boolean | null = null;
    const wait = client.waitForPendingEligibilityUpdate(abort.signal).then((value) => { observed = value; return value; });
    try {
      await failed.promise;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
      expect(observed).toBeNull();
    } finally {
      abort.abort();
      await wait;
    }
  });

  it.each(['disconnected', 'concurrent_success', 'concurrent_retry'] as const)(
    'retains one changes refresh through recovery and user reconnect: %s', async (scenario) => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise : Promise.resolve(settings(9));
    };
    const client = createClient();
    userSocket.connected = false;
    const owner = client as unknown as { refreshAccountSettingsFromChangesHint(version: number | null): Promise<void> };
    const refreshed = owner.refreshAccountSettingsFromChangesHint(5).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const abort = new AbortController();
    let wait: Promise<boolean> | undefined;
    let waitCompleted = false;
    try {
      await requested.promise;
      if (scenario !== 'disconnected') {
        wait = client.waitForPendingEligibilityUpdate(abort.signal).then((value) => {
          waitCompleted = true;
          return value;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(userSocket.connected).toBe(true);
        expect(waitCompleted).toBe(false);
        expect(settingsRequests).toHaveBeenCalledTimes(1);
      }
      firstRead.resolve(scenario === 'concurrent_success'
        ? settings(9)
        : { status: 503, headers: { 'retry-after': '120' }, data: {} });
      await vi.advanceTimersByTimeAsync(0);
      if (scenario !== 'concurrent_success') {
        await vi.advanceTimersByTimeAsync(119_999);
        expect(settingsRequests).toHaveBeenCalledTimes(1);
        expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
        expect(waitCompleted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(2));
      }
      await expect(refreshed).resolves.toEqual({ status: 'fulfilled' });
      if (wait) {
        await expect(wait).resolves.toBe(true);
        const epochs = client as unknown as {
          userSocketSettingsConvergedEpoch: number;
          userSocketSettingsConnectionEpoch: number;
        };
        expect(epochs.userSocketSettingsConvergedEpoch).toBe(epochs.userSocketSettingsConnectionEpoch);
      } else {
        expect(userSocket.connected).toBe(false);
      }
      expect(settingsRequests).toHaveBeenCalledTimes(scenario === 'concurrent_success' ? 1 : 2);
      expect(maxActiveSettingsRequests).toBe(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
    } finally {
      abort.abort();
      firstRead.resolve(settings(9));
      await Promise.all([refreshed, wait]);
    }
  });

  it.each([null, 5])('retains observed minimum nine across a later changes minimum %s', async (minimum) => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise : Promise.resolve(settings(8));
    };
    const client = createClient();
    userSocket.connected = false;
    const owner = client as unknown as { refreshAccountSettingsFromChangesHint(version: number | null): Promise<void> };
    const high = owner.refreshAccountSettingsFromChangesHint(9).then(() => 'fulfilled', () => 'rejected');
    await requested.promise;
    firstRead.resolve({ status: 503, headers: { 'retry-after': '1' }, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    // Advance wall time without running the retained timer: the later caller must join it.
    vi.setSystemTime(Date.now() + 1_000);
    let lowCompleted = false;
    const low = owner.refreshAccountSettingsFromChangesHint(minimum).then(
      () => { lowCompleted = true; return 'fulfilled'; },
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(settingsRequests.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
    expect(lowCompleted).toBe(false);
    readSettings = async () => settings(9);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(Promise.all([high, low])).resolves.toEqual(['fulfilled', 'fulfilled']);
    expect(maxActiveSettingsRequests).toBe(1);
    expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
  });

  it('retains late guidance across deadline observation at 1801s and a genuine event at 1810s', async () => {
    vi.setSystemTime(0);
    const firstRead = createDeferred<unknown>();
    const lateRead = createDeferred<unknown>();
    const firstRequested = createDeferred<void>();
    const lateRequested = createDeferred<void>();
    readSettings = () => {
      if (settingsRequests.mock.calls.length === 1) { firstRequested.resolve(); return firstRead.promise; }
      if (settingsRequests.mock.calls.length === 2) { lateRequested.resolve(); return lateRead.promise; }
      return Promise.resolve(settings(9));
    };
    const client = createClient();
    userSocket.connected = false;
    const owner = client as unknown as { refreshAccountSettingsFromChangesHint(version: number | null): Promise<void> };
    const root = owner.refreshAccountSettingsFromChangesHint(null).then(() => 'fulfilled', () => 'rejected');
    await firstRequested.promise;
    firstRead.resolve({ status: 503, headers: { 'retry-after': '1790' }, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    // This joins the retained owner; on the old source it creates that owner after the first rejection.
    const retained = owner.refreshAccountSettingsFromChangesHint(null).then(() => 'fulfilled', () => 'rejected');
    await vi.advanceTimersByTimeAsync(1_790_000);
    await lateRequested.promise;
    expect(Date.now()).toBe(1_790_000);
    await vi.advanceTimersByTimeAsync(11_000);
    const observer = owner.refreshAccountSettingsFromChangesHint(null).then(() => 'fulfilled', () => 'rejected');
    await vi.advanceTimersByTimeAsync(2_000);
    lateRead.resolve({ status: 503, headers: { 'retry-after': '120' }, data: {} });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([root, retained, observer]);
    expect(Date.now()).toBe(1_803_000);
    expect(maxActiveSettingsRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(7_000);
    sessionSocket.trigger('update', {
      id: 'late-guidance-fresh-event', seq: 1, createdAt: Date.now(),
      body: { t: 'pending-changed', sid: 'settings-retry-session', pendingVersion: 1, pendingCount: 1 },
    });
    const resumed = owner.refreshAccountSettingsFromChangesHint(null).then(() => 'fulfilled', () => 'rejected');
    await vi.advanceTimersByTimeAsync(0);
    // The failed barrier must remain until guidance permits a new request. This also
    // detects premature admission before the real credential-file await has settled.
    expect((client as unknown as { accountSettingsSyncBarrierState: string | null }).accountSettingsSyncBarrierState).toBe('failed');
    await vi.advanceTimersByTimeAsync(112_999);
    expect(Date.now()).toBe(1_922_999);
    expect(settingsRequests).toHaveBeenCalledTimes(2);
    expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(resumed).resolves.toBe('fulfilled');
    expect(settingsRequests).toHaveBeenCalledTimes(3);
    expect(maxActiveSettingsRequests).toBe(1);
    expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
  });

  it.each(['changes', 'live-hint', 'cancelled-changes'] as const)('recovers a %s minimum raised at attempt completion through the same owner', async (source) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstRead = createDeferred<unknown>();
    const secondRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    const secondRequested = createDeferred<void>();
    const inspected = createDeferred<void>();
    readSettings = () => {
      if (settingsRequests.mock.calls.length === 1) { requested.resolve(); return firstRead.promise; }
      secondRequested.resolve();
      return secondRead.promise;
    };
    const client = createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    const owner = client as unknown as {
      refreshAccountSettingsFromChangesHint(version: number): Promise<void>;
      accountSettingsSyncBarrier: Promise<boolean> | null;
      accountSettingsSyncBarrierState: string | null;
      accountSettingsRetryEpisode: { state: import('./pendingInputRetryEpisode').PendingInputRetryState };
    };
    let refreshed: Promise<string> | undefined;
    let higherCompleted = false;
    let stranded = false;
    const unsubscribe = snapshots.subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next.settingsVersion !== 5) return;
      const barrier = owner.accountSettingsSyncBarrier;
      let barrierResult: boolean | null = null;
      void barrier?.then((value) => { barrierResult = value; });
      void (async () => {
        // Controlled snapshot reactions exercise the callback/owner contract. The exact
        // production changes-fetch scheduling interval is not established by this fixture.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        if (source !== 'live-hint') refreshed = owner.refreshAccountSettingsFromChangesHint(9).then(
          () => { higherCompleted = true; return 'fulfilled'; }, () => 'rejected',
        );
        else userSocket.trigger('update', {
          id: 'completion-boundary-live-hint', seq: 1, createdAt: Date.now(),
          body: { t: 'account-settings-changed', settingsVersion: 9 },
        });
        // Bound the counterexample independently of timers or the episode deadline.
        for (let reaction = 0; reaction < 16; reaction += 1) await Promise.resolve();
        stranded = owner.accountSettingsSyncBarrier === barrier
          && owner.accountSettingsSyncBarrierState === 'applying' && barrierResult === true;
        if (stranded) {
          const closing = client.close();
          abort.abort();
          await closing;
        }
        inspected.resolve();
      })();
    });
    try {
      await requested.promise;
      firstRead.resolve(settings(5));
      await inspected.promise;
      expect(stranded).toBe(false);
      expect(owner.accountSettingsSyncBarrierState).toBe('failed');
      expect(owner.accountSettingsRetryEpisode.state).toMatchObject({
        status: 'retrying', failedAttempts: 1, retryAtMs: Date.now() + 275,
      });
      expect(higherCompleted).toBe(false);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
      if (source === 'cancelled-changes') {
        await client.close();
        await expect(refreshed).resolves.toBe('rejected');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(settingsRequests).toHaveBeenCalledTimes(1);
        expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
        return;
      }
      await vi.advanceTimersByTimeAsync(274);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await secondRequested.promise;
      expect(higherCompleted).toBe(false);
      expect(owner.accountSettingsSyncBarrierState).toBe('applying');
      secondRead.resolve(settings(9));
      if (refreshed) await expect(refreshed).resolves.toBe('fulfilled');
      await expect(wait).resolves.toBe(true);
      await vi.waitFor(() => expect(owner.accountSettingsSyncBarrierState).toBeNull());
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
      expect(settingsRequests).toHaveBeenCalledTimes(2);
      expect(maxActiveSettingsRequests).toBe(1);
    } finally {
      unsubscribe();
      abort.abort();
      secondRead.resolve(settings(9));
      await client.close();
      await Promise.all([wait, refreshed]);
    }
  });

  it('keeps a changes minimum joining after loop return pending until version nine applies', async () => {
    const firstRead = createDeferred<unknown>();
    const secondRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    const secondRequested = createDeferred<void>();
    const inspected = createDeferred<void>();
    readSettings = () => {
      if (settingsRequests.mock.calls.length === 1) { requested.resolve(); return firstRead.promise; }
      secondRequested.resolve();
      return secondRead.promise;
    };
    const client = createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    const owner = client as unknown as {
      refreshAccountSettingsFromChangesHint(version: number): Promise<void>;
      accountSettingsSyncBarrier: Promise<boolean> | null;
      userSocketSettingsConvergenceInFlight: Promise<void> | null;
    };
    let refreshed: Promise<unknown> | undefined;
    let higherCompleted = false;
    let joinedCurrentOwner = false;
    try {
      await requested.promise;
      const current = owner.userSocketSettingsConvergenceInFlight;
      void owner.accountSettingsSyncBarrier?.then(() => {
        // Controlled barrier reactions queue the join after the loop continuation and
        // before tracked.finally. This is not a full changes-fetch scheduling trace.
        queueMicrotask(() => {
          joinedCurrentOwner = owner.userSocketSettingsConvergenceInFlight === current;
          refreshed = owner.refreshAccountSettingsFromChangesHint(9).then(() => { higherCompleted = true; }, () => {});
          void (async () => {
            for (let reaction = 0; reaction < 16; reaction += 1) await Promise.resolve();
            inspected.resolve();
          })();
        });
      });
      firstRead.resolve(settings(5));
      await inspected.promise;
      expect(joinedCurrentOwner).toBe(true);
      expect(higherCompleted).toBe(false);
      await secondRequested.promise;
      expect(higherCompleted).toBe(false);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
      secondRead.resolve(settings(9));
      await refreshed;
      expect(higherCompleted).toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
      expect(settingsRequests).toHaveBeenCalledTimes(2);
      expect(maxActiveSettingsRequests).toBe(1);
    } finally {
      abort.abort();
      secondRead.resolve(settings(9));
      await client.close();
      await Promise.all([wait, refreshed]);
    }
  });

  it('does not let an old successful completion fail or clear a newer envelope barrier', async () => {
    const firstRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    const inspected = createDeferred<void>();
    readSettings = () => { requested.resolve(); return firstRead.promise; };
    const client = createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    const owner = client as unknown as {
      accountSettingsSyncBarrier: Promise<boolean> | null;
      accountSettingsSyncBarrierState: string | null;
      accountSettingsRetryEpisode: { state: import('./pendingInputRetryEpisode').PendingInputRetryState };
    };
    let newerBarrier: Promise<boolean> | null = null;
    const unsubscribe = snapshots.subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next.settingsVersion !== 5) return;
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        userSocket.trigger('update', {
          id: 'newer-completion-barrier', seq: 1, createdAt: Date.now(),
          body: { t: 'update-account', id: 'retry-account', settingsV2: settings(9).data },
        });
        newerBarrier = owner.accountSettingsSyncBarrier;
        for (let reaction = 0; reaction < 16; reaction += 1) await Promise.resolve();
        inspected.resolve();
      })();
    });
    try {
      await requested.promise;
      firstRead.resolve(settings(5));
      await inspected.promise;
      expect(newerBarrier).not.toBeNull();
      expect(owner.accountSettingsSyncBarrier).toBe(newerBarrier);
      expect(owner.accountSettingsSyncBarrierState).toBe('applying');
      expect(owner.accountSettingsRetryEpisode.state).toMatchObject({ status: 'retrying', failedAttempts: 0 });
      await newerBarrier;
      await expect(wait).resolves.toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
      expect(owner.accountSettingsSyncBarrierState).toBeNull();
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      expect(maxActiveSettingsRequests).toBe(1);
    } finally {
      unsubscribe();
      abort.abort();
      await client.close();
      await wait;
    }
  });

  it('keeps joined higher-version changes refresh pending until its minimum actually applies', async () => {
    const firstRead = createDeferred<unknown>();
    const secondRead = createDeferred<unknown>();
    const requested = createDeferred<void>();
    readSettings = () => {
      requested.resolve();
      return settingsRequests.mock.calls.length === 1 ? firstRead.promise : secondRead.promise;
    };
    const client = await createClient();
    const abort = new AbortController();
    let observed: boolean | null = null;
    const wait = client.waitForPendingEligibilityUpdate(abort.signal).then((value) => { observed = value; return value; });
    const owner = client as unknown as { refreshAccountSettingsFromChangesHint(version: number): Promise<void> };
    let refreshed: Promise<void> | undefined;
    try {
      await requested.promise;
      refreshed = owner.refreshAccountSettingsFromChangesHint(9);
      firstRead.resolve(settings(8));
      await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(2));
      expect(observed).toBeNull();
      secondRead.resolve(settings(9));
      await refreshed;
      await expect(wait).resolves.toBe(true);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(9);
    } finally {
      abort.abort();
      firstRead.resolve(settings(8));
      secondRead.resolve(settings(9));
      await Promise.all([wait, refreshed]);
    }
  });

  it.each(['envelope', 'hint'] as const)('does not wake an already converged waiter when a live %s narrows eligibility', async (source) => {
    readSettings = async () => ({
      status: 200,
      data: { version: 1, content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } } },
    });
    const client = await createClient();
    await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
    readSettings = async () => settings(2);
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      userSocket.trigger('update', {
        id: 'narrow-settings-event', seq: 1, createdAt: Date.now(),
        body: source === 'hint'
          ? { t: 'account-settings-changed', settingsVersion: 2 }
          : { t: 'update-account', id: 'retry-account', settingsV2: settings(2).data },
      });
      await vi.waitFor(() => expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(2));
      abort.abort();
      await expect(wait).resolves.toBe(false);
    } finally {
      abort.abort();
      await wait;
    }
  });

  it('exposes typed exhaustion when server guidance cannot fit the absolute window', async () => {
    const failed = createDeferred<void>();
    readSettings = async () => {
      failed.resolve();
      return { status: 503, headers: { 'retry-after': '1800' }, data: {} };
    };
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const client = await createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      await failed.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(diagnostic).toHaveBeenCalledWith('[pendingInput] retry episode exhausted', expect.objectContaining({
        operation: 'account_settings', status: 'exhausted', reason: 'deadline', failedAttempts: 1,
      }));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(settingsRequests).toHaveBeenCalledTimes(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()).toBeNull();
    } finally {
      abort.abort();
      await wait;
    }
  });

  it.each(['user', 'session'] as const)('exhausts twelve actual failures without timer renewal and re-arms on a genuine %s reconnect', async (source) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const diagnostic = vi.spyOn(logger, 'infoFile');
    readSettings = async () => { throw new Error('synthetic repeated settings failure'); };
    const client = await createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await vi.waitFor(() => expect(settingsRequests).toHaveBeenCalledTimes(attempt + 1));
        await vi.advanceTimersByTimeAsync(Math.ceil(250 * 2 ** attempt * 1.1));
      }
      expect(diagnostic).toHaveBeenCalledWith('[pendingInput] retry episode exhausted', expect.objectContaining({
        operation: 'account_settings', status: 'exhausted', reason: 'attempt_limit', failedAttempts: 12,
      }));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(settingsRequests).toHaveBeenCalledTimes(12);
      readSettings = async () => settings(8);
      if (source === 'user') userSocket.trigger('connect');
      else {
        sessionSocket.connected = false;
        sessionSocket.trigger('disconnect', 'transport close');
        await vi.waitFor(() => expect(userSocket.connected).toBe(false));
        sessionSocket.connected = true;
        sessionSocket.trigger('connect');
      }
      await expect(wait).resolves.toBe(true);
      if (snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion !== 8) {
        // Session reconnect publishes a verdict-free eligibility wake before its settings
        // request settles. Re-arm the actual input wait against that fresh connection.
        const rearmed = client.waitForPendingEligibilityUpdate(abort.signal);
        await vi.waitFor(() => expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(8));
        await expect(rearmed).resolves.toBe(true);
      }
      expect(settingsRequests.mock.calls.length).toBeGreaterThanOrEqual(13);
      expect(maxActiveSettingsRequests).toBe(1);
      expect(snapshots.getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(8);
    } finally {
      abort.abort();
      await wait;
    }
  });

  it('stops a scheduled retry when the final waiter aborts', async () => {
    const failed = createDeferred<void>();
    readSettings = async () => { failed.resolve(); throw new Error('synthetic cancelled settings read'); };
    const client = await createClient();
    const abort = new AbortController();
    const wait = client.waitForPendingEligibilityUpdate(abort.signal);
    await failed.promise;
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(wait).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(settingsRequests).toHaveBeenCalledTimes(1);
  });
});
