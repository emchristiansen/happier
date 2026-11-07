import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch } from './client';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

afterEach(() => {
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch runtime fetch override', () => {
    it.each(['/v1/account/profile', '/v2/sessions?cursor=next', '/v2/sessions/session-1', '/v1/sessions/session-1/turns'])('advertises supported service readers on authenticated %s without adding a CORS header', async (path) => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://api.example.test', generation: 1 }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn(async () => null) } }));
        const client = await import('./client');
        const requests: Array<{ url: URL; headers: Headers }> = [];
        client.setRuntimeFetch(async (input, init) => {
            requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
            return new Response(null, { status: 200 });
        });
        await client.serverFetch(path, { headers: { Authorization: 'Bearer test-token' } }, { includeAuth: false, retry: 'none' });
        expect(JSON.parse(requests[0].url.searchParams.get('happierConnectedServices') ?? 'null')).toEqual(ConnectedServiceIdSchema.options);
        expect(requests[0].url.pathname).toBe(new URL(path, 'https://api.example.test').pathname);
        expect(requests[0].url.searchParams.get('cursor')).toBe(path.includes('cursor=') ? 'next' : null);
        expect([...requests[0].headers.keys()]).toEqual(['authorization']);
        requests.length = 0;
        await client.serverFetch(path, undefined, { includeAuth: false, retry: 'none' });
        expect(requests[0].url.searchParams.has('happierConnectedServices')).toBe(false);
    });
    it('uses the configured runtime fetch implementation instead of global fetch', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));

        const globalFetchMock = vi.fn(async () => {
            throw new Error('global fetch should not be called');
        });
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);

        const client = await import('./client');
        expect((client as unknown as { setRuntimeFetch?: unknown }).setRuntimeFetch).toBeTypeOf('function');

        const overrideFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            new Response(null, { status: 200, headers: new Headers() })
        ));
        (client as unknown as {
            setRuntimeFetch: (next: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => void;
        }).setRuntimeFetch(overrideFetch);

        const resp = await (client as unknown as { serverFetch: typeof import('./client').serverFetch }).serverFetch(
            '/v1/health',
            undefined,
            { retry: 'none' },
        );
        expect(resp.status).toBe(200);
        expect(overrideFetch).toHaveBeenCalledTimes(1);
        const requestInit = overrideFetch.mock.calls[0]?.[1];
        const headers = new Headers(requestInit?.headers);
        expect(headers.has('x-happier-session-sync-protocol')).toBe(false);
        expect(headers.has('x-happier-client-kind')).toBe(false);
        expect(globalFetchMock).not.toHaveBeenCalled();
    });
});
