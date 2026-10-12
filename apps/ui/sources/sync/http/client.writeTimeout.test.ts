import { afterEach, describe, expect, it, vi } from 'vitest';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS;
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
});

function installDefaultActiveServerMocks() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function installTokenStorageMock() {
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
            invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
        },
    }));
}

describe('serverFetch write timeout', () => {
    it('aborts a mutating request that never responds and rejects with a retryable ServerFetchWriteTimeoutError', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';

        installDefaultActiveServerMocks();
        installTokenStorageMock();

        const writeGate = createDeferred<void>();
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v2/sessions/s1/pending')) {
                // Simulate a server that accepts the connection but never responds until aborted.
                await new Promise<void>((_resolve, reject) => {
                    if (init?.signal) {
                        init.signal.addEventListener('abort', () => {
                            const error = new Error('Aborted');
                            (error as Error).name = 'AbortError';
                            reject(error);
                        }, { once: true });
                    }
                    void writeGate.promise;
                });
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { serverFetch } = await import('./client');
        const promise = serverFetch(
            '/v2/sessions/s1/pending',
            { method: 'POST', body: '{}' },
            { timeoutMs: 50 },
        );
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchWriteTimeoutError',
            retryable: true,
        });

        await vi.advanceTimersByTimeAsync(60);
        await assertion;
    });

    it('classifies the write timeout as a transient connectivity error', async () => {
        const { ServerFetchWriteTimeoutError } = await import('./client');
        const { isTransientConnectivityError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
        expect(isTransientConnectivityError(new ServerFetchWriteTimeoutError())).toBe(true);
    });

    it('does not bound GET reads with the write timeout', async () => {
        installDefaultActiveServerMocks();
        installTokenStorageMock();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            return new Response('body', { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { serverFetch } = await import('./client');
        await expect(serverFetch('/v2/sessions/s1/messages', { method: 'GET' })).resolves.toMatchObject({
            ok: true,
            status: 200,
        });
    });
});
