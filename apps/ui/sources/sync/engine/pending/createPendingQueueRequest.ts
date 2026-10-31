import { ServerFetchWriteTimeoutError } from '@/sync/http/client';

export type PendingQueueRequest = (path: string, init?: RequestInit) => Promise<Response>;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createPendingQueueRequest(params: Readonly<{
    request: PendingQueueRequest;
    writeTimeoutMs: number;
}>): PendingQueueRequest {
    return async (path, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        const timeoutMs = Math.max(0, Math.trunc(params.writeTimeoutMs));
        if (!MUTATING_METHODS.has(method) || timeoutMs === 0) {
            return await params.request(path, init);
        }

        const controller = new AbortController();
        const upstreamSignal = init?.signal;
        const abortFromUpstream = () => controller.abort(
            (upstreamSignal as (AbortSignal & { reason?: unknown }) | undefined)?.reason,
        );
        if (upstreamSignal?.aborted) abortFromUpstream();
        else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort('pending-outbox-write-timeout');
        }, timeoutMs);

        try {
            return await params.request(path, { ...init, signal: controller.signal });
        } catch (error) {
            if (didTimeout) throw new ServerFetchWriteTimeoutError();
            throw error;
        } finally {
            clearTimeout(timer);
            upstreamSignal?.removeEventListener('abort', abortFromUpstream);
        }
    };
}
