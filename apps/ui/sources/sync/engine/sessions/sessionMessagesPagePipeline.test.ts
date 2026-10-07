import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';

function buildEncryptedApiMessage(params: {
    id: string;
    seq: number;
    updatedAt?: number;
    sidechainId?: string | null;
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: ApiMessage['transcriptObservationProvenance'];
}): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: params.sidechainId ?? null,
        content: {
            t: 'encrypted',
            c: `cipher-${params.id}`,
        },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt ?? 2_000 + params.seq,
        ...(params.sourceCreatedAt !== undefined ? { sourceCreatedAt: params.sourceCreatedAt } : {}),
        ...(params.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
        ...(params.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: params.transcriptObservationProvenance }
            : {}),
    };
}

function buildTextContent(message: ApiMessage, text = `hello-${message.id}`) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
        },
    };
}

function buildLifecycleContent(message: ApiMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'kimi',
                data: { type: 'turn_aborted', id: `task-${message.seq}` },
            },
        },
    };
}

describe('runSessionMessagesPagePipeline', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it.each(['rejected', 'unresolved'] as const)('does not certify or consume a %s encrypted page and retries the same rows', async (failure) => {
        const message = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const received = new Map<string, Map<string, number>>();
        const applied: NormalizedMessage[] = [];
        let materializedSeq = 100;
        let appliedIdsAtCommit: string[] = [];
        let failDecryption = true;
        const params: Parameters<typeof runSessionMessagesPagePipeline>[0] = {
            sessionId: 's1',
            purpose: 'newer',
            page: { direction: 'newer', requestPath: '/v1/sessions/s1/messages?afterSeq=100', scope: 'main' },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({
                decryptMessages: async (messages) => {
                    if (failDecryption) {
                        if (failure === 'rejected') throw new Error('Decryption unavailable');
                        return messages.map(() => null);
                    }
                    return messages.map((row) => buildTextContent(row));
                },
            }),
            request: async () => new Response(JSON.stringify({ messages: [message], nextAfterSeq: null })),
            sessionReceivedMessages: received,
            applyMessages: (_sessionId, messages) => { applied.push(...messages); },
            onMessagesPage: (page) => {
                appliedIdsAtCommit = applied.map((row) => row.id);
                materializedSeq = page.messages[0].seq;
            },
            log: { log: () => {} },
        };

        await expect(runSessionMessagesPagePipeline(params)).rejects.toThrow();
        expect(materializedSeq).toBe(100);
        expect(received.get('s1')?.has('m101') ?? false).toBe(false);
        expect(applied).toEqual([]);

        failDecryption = false;
        await runSessionMessagesPagePipeline(params);
        expect(materializedSeq).toBe(101);
        expect(appliedIdsAtCommit).toEqual(['m101']);
        expect(received.get('s1')?.get('m101')).toBe(message.updatedAt);
        expect(applied.map((row) => row.id)).toEqual(['m101']);
    });

    it('preserves older-page decrypt order, sidechain metadata, and pre-apply normalized callback semantics', async () => {
        const newest = buildEncryptedApiMessage({ id: 'm100', seq: 100 });
        const oldest = buildEncryptedApiMessage({ id: 'm99', seq: 99 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [newest, oldest],
                hasMore: true,
                nextBeforeSeq: 98,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const callOrder: string[] = [];
        const onNormalizedMessages = vi.fn((messages: NormalizedMessage[]) => {
            callOrder.push(`normalized:${messages.map((message) => message.id).join(',')}`);
        });
        applyMessages.mockImplementation((_sessionId, messages) => {
            callOrder.push(`apply:${messages.map((message) => message.id).join(',')}`);
        });

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'older',
            page: {
                direction: 'older',
                requestPath: '/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1',
                scope: 'sidechain',
                sidechainId: 'tool_task_1',
                beforeSeq: 101,
                limit: 2,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onNormalizedMessages,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledWith('/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1');
        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['m99', 'm100']);
        expect(callOrder).toEqual(['normalized:m99,m100', 'apply:m99,m100']);
        expect(applyMessages.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ id: 'm99', seq: 99, isSidechain: true, sidechainId: 'tool_task_1' }),
            expect.objectContaining({ id: 'm100', seq: 100, isSidechain: true, sidechainId: 'tool_task_1' }),
        ]);
        expect(result).toMatchObject({
            applied: 2,
            appliedMessageIds: ['m99', 'm100'],
            appliedSeqs: [99, 100],
            rawSeqs: [100, 99],
            page: {
                hasMore: true,
                nextBeforeSeq: 98,
            },
        });
    });

    it('repairs only selected identities without applying or consuming neighboring page rows', async () => {
        const selected = buildEncryptedApiMessage({ id: 'selected', seq: 15 });
        const neighbor = buildEncryptedApiMessage({ id: 'neighbor', seq: 9000 });
        const received = new Map<string, Map<string, number>>();
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: { direction: 'newer', requestPath: '/v1/sessions/s1/messages?afterSeq=14', scope: 'all' },
            lifecyclePolicy: 'suppress',
            messageIds: new Set(['selected']),
            getSessionEncryption: () => ({ decryptMessages: async (messages) => messages.map((row) => buildTextContent(row)) }),
            request: async () => new Response(JSON.stringify({ messages: [selected, neighbor], nextAfterSeq: null })),
            sessionReceivedMessages: received,
            applyMessages: () => {},
            log: { log: () => {} },
        });
        expect(result.appliedMessageIds).toEqual(['selected']);
        expect([...received.get('s1')!.keys()]).toEqual(['selected']);
    });

    it('preserves authenticated transcript-observation metadata on normalized page messages', async () => {
        const recoveredHistory = buildEncryptedApiMessage({
            id: 'history-1',
            seq: 42,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [recoveredHistory], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                sidechainId: null,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({
                decryptMessages: async (messages: ApiMessage[]) => messages.map((message) => buildTextContent(message)),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            log: { log: () => {} },
        });

        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'history-1',
            seq: 42,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
    });

    it('uses an explicit target-window purpose and lifecycle policy instead of treating newer-side target pages as live-tail newer pages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const lifecycle = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [lifecycle],
                nextAfterSeq: 101,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildLifecycleContent(message)),
        );
        const onTaskLifecycleEvent = vi.fn();
        const applyMessages = vi.fn();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'target-window',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(result).toMatchObject({
            applied: 0,
            appliedMessageIds: [],
            rawSeqs: [101],
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.targetWindow).toBe(1);
        expect(requestEvent?.fields.newer ?? 0).toBe(0);
    });

    it('does not emit live lifecycle effects for explicitly recovered history on an emitting page', async () => {
        const recoveredLifecycle = buildEncryptedApiMessage({
            id: 'history-lifecycle',
            seq: 101,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [recoveredLifecycle], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();
        const onTaskLifecycleEvent = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: () => ({
                decryptMessages: async (messages: ApiMessage[]) => messages.map((message) => buildLifecycleContent(message)),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
    });
});
