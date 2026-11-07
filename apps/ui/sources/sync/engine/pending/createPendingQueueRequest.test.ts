import { describe, expect, it, vi } from 'vitest';

import { createPendingQueueRequest } from './createPendingQueueRequest';

describe('createPendingQueueRequest', () => {
    it('bounds idempotent pending writes at the owning outbox boundary', async () => {
        vi.useFakeTimers();
        try {
            const request = createPendingQueueRequest({
                writeTimeoutMs: 50,
                request: async (_path, init) => await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                }),
            });

            const pending = request('/v2/sessions/s1/pending', { method: 'POST' });
            const assertion = expect(pending).rejects.toMatchObject({
                name: 'ServerFetchWriteTimeoutError',
                retryable: true,
            });
            await vi.advanceTimersByTimeAsync(50);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not impose the write deadline on pending-list reads', async () => {
        const response = new Response('ok');
        const base = vi.fn(async (_path: string, _init?: RequestInit) => response);
        const request = createPendingQueueRequest({ request: base, writeTimeoutMs: 50 });

        await expect(request('/v2/sessions/s1/pending', { method: 'GET' })).resolves.toBe(response);
        expect(base.mock.calls[0]?.[1]?.signal).toBeUndefined();
    });
});
