import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sharedManagedServer', async (importOriginal) => ({
    ...await importOriginal<typeof import('./sharedManagedServer')>(),
    ensureSharedManagedOpenCodeServerBaseUrl: vi.fn(),
    readSharedManagedOpenCodeServerStateBestEffort: vi.fn(async () => null),
    readSharedManagedOpenCodeServerStateByBaseUrlBestEffort: vi.fn(async () => null),
}));

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';

import { createOpenCodeServerRuntimeClient } from './client';

describe('createOpenCodeServerRuntimeClient sessionPromptAsync exact submission', () => {
    const originalFetch = globalThis.fetch;
    const originalServerUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (typeof originalServerUrl === 'string') {
            process.env.HAPPIER_OPENCODE_SERVER_URL = originalServerUrl;
        } else {
            delete process.env.HAPPIER_OPENCODE_SERVER_URL;
        }
    });

    it('does not replay prompt_async after an ambiguous managed-server fetch failure', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        // Persistent mock: the client reads managed-server state at construction (identity baseline)
        // and again on the transport-failure retry path; a single once-mock leaves the retry undefined.
        readMock.mockResolvedValue({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        const fetchUrls: string[] = [];
        let promptAttempts = 0;
        globalThis.fetch = vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            fetchUrls.push(url);

            if (url.includes('127.0.0.1:9999/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.includes('127.0.0.1:10000/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.includes('/prompt_async')) {
                promptAttempts += 1;
                if (promptAttempts === 1) {
                    throw new TypeError('fetch failed');
                }
                return new Response(null, { status: 204 });
            }

            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.sessionPromptAsync({
            sessionId: 'ses_1',
            parts: [{ type: 'text', text: 'hello' }],
        })).rejects.toThrow('fetch failed');

        const promptUrls = fetchUrls.filter((url) => url.includes('/prompt_async'));
        expect(promptUrls).toEqual([
            expect.stringContaining('127.0.0.1:9999/session/ses_1/prompt_async'),
        ]);
    });

    it('does not replay session summarization after an ambiguous managed-server fetch failure', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        readMock.mockResolvedValue({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        let summarizeAttempts = 0;
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            if (url.includes('/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.includes('/summarize')) {
                summarizeAttempts += 1;
                if (summarizeAttempts === 1) throw new TypeError('fetch failed');
                return new Response(null, { status: 204 });
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });

        await expect(client.sessionSummarize({
            sessionId: 'ses_1',
            model: { providerID: 'openai', modelID: 'gpt-5' },
        })).rejects.toThrow('fetch failed');
        expect(summarizeAttempts).toBe(1);
    });

    it('logs one bounded payload-free diagnostic when retrying a managed read request', async () => {
        const { ensureSharedManagedOpenCodeServerBaseUrl, readSharedManagedOpenCodeServerStateBestEffort } = await import('./sharedManagedServer');
        const ensureMock = ensureSharedManagedOpenCodeServerBaseUrl as unknown as ReturnType<typeof vi.fn>;
        const readMock = readSharedManagedOpenCodeServerStateBestEffort as unknown as ReturnType<typeof vi.fn>;
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const secret = 'must-not-appear-in-provider-request-log';

        ensureMock.mockResolvedValueOnce('http://127.0.0.1:9999');
        readMock.mockResolvedValue({
            baseUrl: 'http://127.0.0.1:10000',
            pid: process.pid,
            startedAtMs: Date.now(),
        });

        let messageAttempts = 0;
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            if (url.includes('/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.includes('/message')) {
                messageAttempts += 1;
                if (messageAttempts === 1) {
                    throw new TypeError(`fetch failed: Authorization: Bearer ${secret}`);
                }
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
        });
        await expect(client.sessionMessagesList({ sessionId: 'ses_1' })).resolves.toEqual([]);

        const retryLogs = debugSpy.mock.calls.filter(
            ([message]) => message === '[OpenCodeServer] Retrying managed HTTP request after transient transport failure',
        );
        expect(retryLogs).toEqual([[
            '[OpenCodeServer] Retrying managed HTTP request after transient transport failure',
            {
                operation: 'session_messages_list',
                method: 'GET',
                failedAttempt: 1,
                nextAttempt: 2,
                failureKind: 'fetch_failed',
            },
        ]]);
        expect(JSON.stringify(retryLogs)).not.toContain(secret);
    });

    it('does not include provider response bodies in HTTP errors', async () => {
        const secret = 'Bearer must-not-appear-in-opencode-http-error';
        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');
            if (url.includes('/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.includes('/prompt_async')) {
                return new Response(`request rejected; Authorization: ${secret}`, {
                    status: 400,
                    statusText: 'Bad Request',
                });
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp/private-workspace',
            messageBuffer: new MessageBuffer(),
            baseUrlOverride: 'http://127.0.0.1:9999',
        });

        const outcome = await client.sessionPromptAsync({
            sessionId: 'ses_1',
            parts: [{ type: 'text', text: 'private prompt body' }],
        }).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('Expected OpenCode request to fail');
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toContain('400 Bad Request');
        expect((outcome.error as Error).message).not.toContain(secret);
        expect((outcome.error as Error).message).not.toContain('/tmp/private-workspace');
    });

    it('sends OpenCode prompt variants as top-level prompt_async fields', async () => {
        const promptBodies: unknown[] = [];
        globalThis.fetch = vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : String((input as Request)?.url ?? '');

            if (url.includes('/global/health')) {
                return new Response(JSON.stringify({ healthy: true, version: '1.2.15' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.includes('/prompt_async')) {
                promptBodies.push(JSON.parse(String(init?.body ?? '{}')));
                return new Response(null, { status: 204 });
            }

            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const client = await createOpenCodeServerRuntimeClient({
            directory: '/tmp',
            messageBuffer: new MessageBuffer(),
            baseUrlOverride: 'http://127.0.0.1:9999',
        });

        await expect((client.sessionPromptAsync as unknown as (opts: {
            sessionId: string;
            parts: unknown[];
            variant?: string;
            config?: Record<string, unknown>;
        }) => Promise<void>)({
            sessionId: 'ses_1',
            parts: [{ type: 'text', text: 'hello' }],
            variant: 'high',
            config: { telemetry: true },
        })).resolves.toBeUndefined();

        expect(promptBodies).toEqual([
            expect.objectContaining({
                variant: 'high',
                config: { telemetry: true },
            }),
        ]);
        expect(promptBodies[0]).not.toMatchObject({
            config: expect.objectContaining({ variant: expect.anything() }),
        });
    });
});
