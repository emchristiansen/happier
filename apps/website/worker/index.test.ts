import { afterEach, describe, expect, it, vi } from 'vitest';

import website from './index';
import docs from '../../docs/worker/index';

// The external fetch boundary is replaced before either public handler runs.
// Request, URL and Response remain the platform's actual implementations.
function installFetchBoundary() {
    const upstream = vi.fn(async (_request: Request, _init?: RequestInit) =>
        new Response('upstream', {
            status: 201,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-credentials': 'true',
            },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    expect(globalThis.fetch).toBe(upstream);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    const assets = vi.fn(async (_request: Request) => new Response('asset'));
    return { upstream, assets };
}

afterEach(() => vi.unstubAllGlobals());

describe.each([['website', website], ['docs', docs]] as const)('%s ingest destination', (_site, worker) => {
    it.each([
        {
            path: '/ingest/e/?x=1',
            target: 'https://eu.i.posthog.com/e/?x=1',
            method: 'POST',
            cached: false,
        },
        {
            path: '/ingest/static/chunk.js?v=1',
            target: 'https://eu-assets.i.posthog.com/static/chunk.js?v=1',
            method: 'GET',
            cached: true,
        },
        {
            path: '/ingest//example.invalid/collect?x=1',
            target: 'https://eu.i.posthog.com//example.invalid/collect?x=1',
            method: 'POST',
            cached: false,
        },
    ])('keeps $path on its selected origin', async ({ path, target, method, cached }) => {
        const { upstream, assets } = installFetchBoundary();
        const request = new Request(`https://site.invalid${path}`, {
            method,
            headers: { 'x-fixture': 'preserved' },
            ...(method === 'POST' ? { body: 'fixture-body' } : {}),
        });

        const response = await worker.fetch(request, { ASSETS: { fetch: assets } });

        expect(upstream).toHaveBeenCalledTimes(1);
        const [outbound, options] = upstream.mock.calls[0];
        expect(outbound.url).toBe(target);
        expect(outbound.headers.get('host')).toBe(new URL(target).host);
        expect(outbound.headers.get('x-fixture')).toBe('preserved');
        expect(outbound.method).toBe(method);
        expect(await outbound.text()).toBe(method === 'POST' ? 'fixture-body' : '');
        expect(options).toEqual({ cf: cached ? { cacheTtl: 3600, cacheEverything: true } : undefined });
        expect(assets).not.toHaveBeenCalled();
        expect(response.status).toBe(201);
        expect(await response.text()).toBe('upstream');
        expect(response.headers.has('access-control-allow-origin')).toBe(false);
        expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    });

    it('leaves non-ingest requests with the asset layer', async () => {
        const { upstream, assets } = installFetchBoundary();
        const request = new Request('https://site.invalid/guide');

        const response = await worker.fetch(request, { ASSETS: { fetch: assets } });

        expect(await response.text()).toBe('asset');
        expect(assets).toHaveBeenCalledWith(request);
        expect(upstream).not.toHaveBeenCalled();
    });
});
