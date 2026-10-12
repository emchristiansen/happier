import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSharedManagedOpenCodeServerStateBestEffort } from './sharedManagedServer';

vi.mock('./openCodeSse', () => ({
  subscribeSseJson: vi.fn(),
}));

vi.mock('./sharedManagedServer', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sharedManagedServer')>(),
  ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
  readSharedManagedOpenCodeServerStateBestEffort: vi.fn(async () => null),
  readSharedManagedOpenCodeServerStateByBaseUrlBestEffort: vi.fn(async () => null),
}));

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function createResponse(params: { ok: boolean; status: number; statusText: string; body: unknown }): FakeResponse {
  return {
    ok: params.ok,
    status: params.status,
    statusText: params.statusText,
    json: async () => params.body,
    text: async () => JSON.stringify(params.body),
  };
}

function createOkJsonResponse(body: unknown): FakeResponse {
  return createResponse({ ok: true, status: 200, statusText: 'OK', body });
}

describe('createOpenCodeServerRuntimeClient.subscribeGlobalEvents', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(readSharedManagedOpenCodeServerStateBestEffort).mockResolvedValue(null);

    for (const key of [
      'HAPPIER_OPENCODE_SERVER_URL',
      'HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS',
      'HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS',
    ] as const) {
      prevEnv[key] = process.env[key];
    }

    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses the instance event stream and accepts only post-boundary events as live', async () => {
    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        params.onMessage({ type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'stale' } } }, { id: 'evt_before_boundary_1' });
        params.onMessage({ type: 'server.connected', properties: {} }, { id: 'evt_boundary_1' });
        params.onMessage({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }, { id: 'evt_live_1' });
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        params.onMessage({ type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'stale' } } }, { id: 'evt_before_boundary_2' });
        params.onMessage({ type: 'server.connected', properties: {} }, { id: 'evt_boundary_2' });
        params.onMessage({ type: 'session.idle', properties: { sessionID: 'ses_1' } }, { id: 'evt_live_2' });
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        const close = vi.fn(() => resolveDone());
        return { close, done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(String(firstParams?.url ?? '')).toContain('/event?directory=%2Ftmp');
    expect(String(firstParams?.url ?? '')).not.toContain('/global/event');
    expect(firstParams?.headers?.['Last-Event-ID']).toBeUndefined();
    expect(onEvent.mock.calls).toEqual([
      [expect.objectContaining({ payload: expect.objectContaining({ type: 'server.connected' }) }), expect.objectContaining({ provenance: 'connection-boundary' })],
      [expect.objectContaining({ directory: '/tmp', payload: expect.objectContaining({ type: 'session.status' }) }), expect.objectContaining({ provenance: 'accepted-live' })],
    ]);

    // Simulate an SSE disconnect.
    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    // OpenCode's instance event endpoint does not define Last-Event-ID replay semantics.
    expect(secondParams?.headers?.['Last-Event-ID']).toBeUndefined();

    await expect.poll(() => onEvent.mock.calls.length).toBe(4);
    expect(onEvent.mock.calls.slice(2)).toEqual([
      [expect.objectContaining({ payload: expect.objectContaining({ type: 'server.connected' }) }), expect.objectContaining({ provenance: 'connection-boundary' })],
      [expect.objectContaining({ directory: '/tmp', payload: expect.objectContaining({ type: 'session.idle' }) }), expect.objectContaining({ provenance: 'accepted-live' })],
    ]);

    controller.abort();
    await client.dispose();
  });

  it.each([
    {
      initialGeneration: 'v1',
      replacementGeneration: 'v2',
      disconnect: 'error',
      initialEventPath: '/event?directory=%2Ftmp',
      replacementEventPath: '/api/event',
      replacementSessionPath: '/api/session?directory=%2Ftmp&order=asc',
      replacementBoundary: { type: 'server.connected', data: {} },
      // Released wire frame from the real v2.0.15 binary (`/api/event`): streamed parts are
      // identified by (assistantMessageID, ordinal), not the preview `textID`.
      replacementEvent: {
        type: 'session.text.delta',
        data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: 'v2' },
      },
      expectedEventType: 'message.part.delta',
    },
    {
      initialGeneration: 'v2',
      replacementGeneration: 'v1',
      disconnect: 'eof',
      initialEventPath: '/api/event',
      replacementEventPath: '/event?directory=%2Ftmp',
      replacementSessionPath: '/session?directory=%2Ftmp',
      replacementBoundary: { type: 'server.connected', properties: {} },
      replacementEvent: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      expectedEventType: 'session.status',
    },
  ] as const)(
    're-probes an external same-URL server after reconnect changes $initialGeneration to $replacementGeneration',
    async ({
      initialGeneration,
      replacementGeneration,
      disconnect,
      initialEventPath,
      replacementEventPath,
      replacementSessionPath,
      replacementBoundary,
      replacementEvent,
      expectedEventType,
    }) => {
      let activeGeneration: 'v1' | 'v2' = initialGeneration;
      const requestedPaths: string[] = [];
      const fetchSpy = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requestedPaths.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/api/health') {
          return createResponse({
            ok: activeGeneration === 'v2',
            status: activeGeneration === 'v2' ? 200 : 404,
            statusText: activeGeneration === 'v2' ? 'OK' : 'Not Found',
            body: activeGeneration === 'v2' ? { healthy: true } : { error: 'not found' },
          }) as any;
        }
        if (url.pathname === '/global/health') {
          return createResponse({
            ok: activeGeneration === 'v1',
            status: activeGeneration === 'v1' ? 200 : 404,
            statusText: activeGeneration === 'v1' ? 'OK' : 'Not Found',
            body: activeGeneration === 'v1' ? { healthy: true, version: 'test' } : { error: 'not found' },
          }) as any;
        }
        if (url.pathname === '/api/session') return createOkJsonResponse({ data: [] }) as any;
        if (url.pathname === '/session') return createOkJsonResponse([]) as any;
        return createOkJsonResponse({}) as any;
      });
      vi.stubGlobal('fetch', fetchSpy as any);

      const { subscribeSseJson } = await import('./openCodeSse');
      const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;
      let settleFirstDone!: () => void;
      const firstDone = new Promise<void>((resolve, reject) => {
        settleFirstDone = disconnect === 'error'
          ? () => reject(new Error('socket hang up'))
          : resolve;
      });
      subscribeMock
        .mockImplementationOnce(async () => ({ close: vi.fn(), done: firstDone }))
        .mockImplementationOnce(async (params: any) => {
          params.onMessage(replacementBoundary);
          params.onMessage(replacementEvent);
          let resolveDone!: () => void;
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
          return { close: vi.fn(() => resolveDone()), done };
        });

      const { createOpenCodeServerRuntimeClient } = await import('./client');
      const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });
      const onEvent = vi.fn();
      const controller = new AbortController();
      await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

      expect(new URL(String(subscribeMock.mock.calls[0]?.[0]?.url)).pathname + new URL(String(subscribeMock.mock.calls[0]?.[0]?.url)).search).toBe(initialEventPath);
      activeGeneration = replacementGeneration;
      settleFirstDone();

      await expect.poll(() => subscribeMock.mock.calls.length).toBe(2);
      const replacementUrl = new URL(String(subscribeMock.mock.calls[1]?.[0]?.url));
      expect(`${replacementUrl.pathname}${replacementUrl.search}`).toBe(replacementEventPath);
      await expect.poll(() => onEvent.mock.calls.some(([event]) => event.payload.type === expectedEventType)).toBe(true);

      await expect(client.sessionList()).resolves.toEqual([]);
      expect(requestedPaths).toContain(replacementSessionPath);

      controller.abort();
      await client.dispose();
    },
  );

  it('reopens the instance event stream and requires a fresh boundary when the directory changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => createOkJsonResponse(
      String(url).includes('/global/health')
        ? { healthy: true, version: 'test' }
        : {},
    )) as any);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;
    let firstClose: ReturnType<typeof vi.fn> | null = null;

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        params.onMessage({ type: 'server.connected', properties: {} });
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        firstClose = vi.fn(resolveDone);
        return { close: firstClose, done };
      })
      .mockImplementationOnce(async (params: any) => {
        params.onMessage({ type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'stale' } } });
        params.onMessage({ type: 'server.connected', properties: {} });
        params.onMessage({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return { close: vi.fn(resolveDone), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp/left', messageBuffer: { push: () => {} } as any });
    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });
    await expect.poll(() => subscribeMock.mock.calls.length).toBe(1);

    expect(client.setDirectoryOverride('/tmp/right')).toBe(true);
    expect(firstClose).toHaveBeenCalledTimes(1);
    await expect.poll(() => subscribeMock.mock.calls.length).toBe(2);
    expect(String(subscribeMock.mock.calls[1]?.[0]?.url ?? '')).toContain('/event?directory=%2Ftmp%2Fright');
    await expect.poll(() => onEvent.mock.calls.length).toBe(3);
    expect(onEvent.mock.calls.map(([event, delivery]) => [event.payload.type, event.directory, delivery.provenance])).toEqual([
      ['server.connected', '/tmp/left', 'connection-boundary'],
      ['server.connected', '/tmp/right', 'connection-boundary'],
      ['session.idle', '/tmp/right', 'accepted-live'],
    ]);
    expect(client.setDirectoryOverride('/tmp/right')).toBe(false);
    expect(subscribeMock).toHaveBeenCalledTimes(2);

    controller.abort();
    await client.dispose();
  });

  it('dispose aborts reconnect sleep promptly (does not block on backoff timers)', async () => {
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5000';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5000';

    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock.mockImplementationOnce(async (params: any) => {
      // Keep a reference to the abort signal so we can ensure it becomes aborted on dispose.
      expect(params.signal?.aborted).toBe(false);
      return { close: vi.fn(), done: firstDone };
    });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    rejectFirstDone(new Error('socket hang up'));
    // Give the reconnect loop a chance to enter its sleep.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await Promise.race([
      client.dispose(),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('dispose timed out')), 50)),
    ]);
  });

  it('refreshes the managed OpenCode server baseUrl when the SSE stream drops (e.g. managed server restarted on a new port)', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock
      // Construction baseline: managed mode reads state once to establish the generation identity.
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1 })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:10000', pid: process.pid, startedAtMs: 2 });

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:10000');

    controller.abort();
    await client.dispose();
  });

  it('does not re-ensure or replace the managed server from SSE reconnect alone', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('127.0.0.1:9999') && urlStr.includes('/global/health')) {
        return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      }
      if (urlStr.includes('127.0.0.1:10000') && urlStr.includes('/global/health')) {
        return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock
      .mockResolvedValueOnce('http://127.0.0.1:9999')
      .mockResolvedValueOnce('http://127.0.0.1:10000');
    readMock
      // Construction baseline read, then a null state on SSE reconnect (no new server observed).
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1 })
      .mockResolvedValueOnce(null);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:9999');
    expect(ensureMock.mock.calls.length).toBe(1);

    controller.abort();
    await client.dispose();
  });

  it('ignores non-loopback managed server state during SSE reconnect refresh', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;

    const fetchSpy = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('127.0.0.1:9999') && urlStr.includes('/global/health')) {
        return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock
      // Construction baseline (loopback), then a non-loopback state on SSE reconnect (must be ignored).
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1 })
      .mockResolvedValueOnce({ baseUrl: 'http://example.com:8080', pid: process.pid, startedAtMs: 2 });

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let firstParams: any = null;
    let secondParams: any = null;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });

    subscribeMock
      .mockImplementationOnce(async (params: any) => {
        firstParams = params;
        return { close: vi.fn(), done: firstDone };
      })
      .mockImplementationOnce(async (params: any) => {
        secondParams = params;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });

    const onEvent = vi.fn();
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

    expect(String(firstParams?.url ?? '')).toContain('127.0.0.1:9999');

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);
    expect(String(secondParams?.url ?? '')).toContain('127.0.0.1:9999');
    expect(String(secondParams?.url ?? '')).not.toContain('example.com:8080');
    expect(ensureMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await client.dispose();
  });
});

describe('createOpenCodeServerRuntimeClient managed-server identity change signal', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(readSharedManagedOpenCodeServerStateBestEffort).mockResolvedValue(null);
    for (const key of [
      'HAPPIER_OPENCODE_SERVER_URL',
      'HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS',
      'HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS',
    ] as const) {
      prevEnv[key] = process.env[key];
    }
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS = '5';
    process.env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS = '5';
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    ['auto', '/event?directory=%2Ftmp'],
    ['v2', '/api/event'],
  ] as const)('keeps the managed %s launch hint coherent across SSE reconnects', async (apiGeneration, expectedEventPath) => {
    const fetchSpy = vi.fn(async (url: any) => {
      if (apiGeneration === 'auto') {
        return String(url).includes('/global/health')
          ? createOkJsonResponse({ healthy: true, version: 'test' }) as any
          : createResponse({ ok: false, status: 404, statusText: 'Not Found', body: {} }) as any;
      }
      return createOkJsonResponse({ healthy: true }) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    const managedState = {
      baseUrl: 'http://127.0.0.1:9999',
      pid: process.pid,
      startedAtMs: 1,
      ownerToken: 'gen-A',
      apiGeneration,
    };
    ensureMock.mockResolvedValueOnce(managedState.baseUrl);
    readMock.mockResolvedValue(managedState);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;
    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock
      .mockImplementationOnce(async () => ({ close: vi.fn(), done: firstDone }))
      .mockImplementationOnce(async (params: any) => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });
    const probesAfterConstruction = fetchSpy.mock.calls.length;
    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent: vi.fn() });
    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => subscribeMock.mock.calls.length).toBe(2);
    expect(subscribeMock.mock.calls.map(([params]) => {
      const url = new URL(String(params.url));
      return `${url.pathname}${url.search}`;
    })).toEqual([expectedEventPath, expectedEventPath]);
    expect(fetchSpy).toHaveBeenCalledTimes(probesAfterConstruction);

    controller.abort();
    await client.dispose();
  });

  it('emits a sse_reconnect_state_refresh change when reconnect observes a new managed-server generation', async () => {
    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1, ownerToken: 'gen-A' })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:10000', pid: process.pid, startedAtMs: 2, ownerToken: 'gen-B' });

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock
      .mockImplementationOnce(async () => ({ close: vi.fn(), done: firstDone }))
      .mockImplementationOnce(async (params: any) => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const changes: Array<{ reason: string; previous: unknown; current: unknown }> = [];
    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
      onManagedServerIdentityChanged: (change) => changes.push(change as any),
    });

    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent: vi.fn() });

    rejectFirstDone(new Error('socket hang up'));

    await expect.poll(() => changes.length).toBeGreaterThan(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.reason).toBe('sse_reconnect_state_refresh');
    expect((changes[0]?.previous as any)?.generationKey).toBeTruthy();
    expect((changes[0]?.current as any)?.generationKey).toBeTruthy();
    expect((changes[0]?.previous as any)?.generationKey).not.toBe((changes[0]?.current as any)?.generationKey);
    // SSE reconnect must never ensure a server.
    expect(ensureMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await client.dispose();
  });

  it('does not emit a generation change when SSE reconnect finds no new managed-server state', async () => {
    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
    readMock
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1, ownerToken: 'gen-A' })
      .mockResolvedValueOnce(null);

    const { subscribeSseJson } = await import('./openCodeSse');
    const subscribeMock = subscribeSseJson as unknown as ReturnType<typeof vi.fn>;

    let rejectFirstDone!: (error: unknown) => void;
    const firstDone = new Promise<void>((_resolve, reject) => {
      rejectFirstDone = reject;
    });
    subscribeMock
      .mockImplementationOnce(async () => ({ close: vi.fn(), done: firstDone }))
      .mockImplementationOnce(async (params: any) => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        params.signal?.addEventListener?.('abort', () => resolveDone(), { once: true });
        return { close: vi.fn(() => resolveDone()), done };
      });

    const changes: unknown[] = [];
    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
      onManagedServerIdentityChanged: (change) => changes.push(change),
    });

    const controller = new AbortController();
    await client.subscribeGlobalEvents({ signal: controller.signal, onEvent: vi.fn() });

    rejectFirstDone(new Error('socket hang up'));
    await expect.poll(() => subscribeMock.mock.calls.length).toBeGreaterThan(1);

    expect(changes).toHaveLength(0);
    expect(ensureMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await client.dispose();
  });

  it('never emits managed-server identity changes in explicit server URL mode', async () => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    const fetchSpy = vi.fn(async (url: any) => {
      if (String(url).includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { readSharedManagedOpenCodeServerStateByBaseUrlBestEffort } = await import('./sharedManagedServer');
    const readMock = readSharedManagedOpenCodeServerStateByBaseUrlBestEffort as unknown as ReturnType<typeof vi.fn>;

    const changes: unknown[] = [];
    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
      onManagedServerIdentityChanged: (change) => changes.push(change),
    });

    // Explicit URL mode does not adopt managed lifecycle identity. A loopback URL does perform one
    // state read so an exact managed endpoint can consume its retained credential safely.
    expect(client.getManagedServerIdentity()).toBeNull();
    expect(readMock).toHaveBeenCalledWith('http://127.0.0.1:9999');
    expect(changes).toHaveLength(0);

    await client.dispose();
  });

  it('emits exactly one http_retry_ensure change when a transport retry repoints to a new managed server', async () => {
    let messageCalls = 0;
    const fetchSpy = vi.fn(async (url: any) => {
      const s = String(url);
      if (s.includes('/global/health')) return createOkJsonResponse({ healthy: true, version: 'test' }) as any;
      if (s.includes('/message')) {
        messageCalls += 1;
        if (messageCalls === 1) {
          throw new Error('fetch failed');
        }
        return createOkJsonResponse([]) as any;
      }
      return createOkJsonResponse({}) as any;
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
    const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
    const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
    ensureMock
      .mockResolvedValueOnce('http://127.0.0.1:9999')
      .mockResolvedValueOnce('http://127.0.0.1:10000');
    readMock
      // Construction baseline.
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: process.pid, startedAtMs: 1, ownerToken: 'gen-A' })
      // Retry path top-read: previous server pid is dead so ensure repoints.
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9999', pid: 99_999_999, startedAtMs: 1, ownerToken: 'gen-A' })
      // Post-ensure read: new generation.
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:10000', pid: process.pid, startedAtMs: 2, ownerToken: 'gen-B' });

    const { subscribeSseJson } = await import('./openCodeSse');
    (subscribeSseJson as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ close: vi.fn(), done: new Promise<void>(() => {}) }));

    const changes: Array<{ reason: string }> = [];
    const { createOpenCodeServerRuntimeClient } = await import('./client');
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      messageBuffer: { push: () => {} } as any,
      onManagedServerIdentityChanged: (change) => changes.push(change as any),
    });

    const result = await client.sessionMessagesList({ sessionId: 'ses_1' });
    expect(Array.isArray(result)).toBe(true);
    expect(messageCalls).toBe(2);
    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.reason).toBe('http_retry_ensure');
    expect(client.getManagedServerIdentity()?.baseUrl).toBe('http://127.0.0.1:10000');

    await client.dispose();
  });
});
