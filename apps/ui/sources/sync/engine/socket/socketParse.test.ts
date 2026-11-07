import { describe, expect, it, vi } from 'vitest';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';

describe('socketParse', () => {
    it('parses a full update container (new-message)', () => {
        const res = parseUpdateContainer({
            id: 'u1',
            seq: 123,
            createdAt: 1000,
            body: {
                t: 'new-message',
                sid: 's1',
                message: {
                    id: 'm1',
                    seq: 1,
                    content: { t: 'encrypted', c: 'abc' },
                    localId: null,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('new-message');
        expect((res!.body as any).sid).toBe('s1');
    });

    it('returns null for a non-container non-sharing update body', () => {
        const res = parseUpdateContainer({
            t: 'new-message',
            sid: 's1',
            message: { id: 'm1' },
        });
        expect(res).toBeNull();
    });

    it('accepts legacy sharing update bodies without a container', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            sessionId: 's1',
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-shared');
        expect((res!.body as any).sessionId).toBe('s1');
        expect(res!.seq).toBe(0);
    });

    it('accepts legacy sharing update body nested under body', () => {
        const res = parseUpdateContainer({
            body: {
                t: 'session-share-updated',
                sessionId: 's1',
                shareId: 'sh1',
            },
        });

        expect(res).not.toBeNull();
        expect(res!.body.t).toBe('session-share-updated');
        expect((res!.body as any).sessionId).toBe('s1');
        expect((res!.body as any).shareId).toBe('sh1');
        expect(res!.seq).toBe(0);
    });

    it('returns null for malformed legacy sharing payloads', () => {
        const res = parseUpdateContainer({
            t: 'session-shared',
            // missing sessionId
        });

        expect(res).toBeNull();
    });

    it('parses ephemeral activity updates', () => {
        const res = parseEphemeralUpdate({
            type: 'activity',
            id: 's1',
            active: true,
            activeAt: 1000,
            thinking: true,
        });

        expect(res).not.toBeNull();
        expect(res!.type).toBe('activity');
        expect((res as any).id).toBe('s1');
    });

    it('parses transcript stream segment ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'message', message: 'Hello' },
                        },
                        meta: {
                            happierStreamSegmentV1: {
                                v: 1,
                                segmentKind: 'assistant',
                                segmentLocalId: 'segment-1',
                                segmentState: 'streaming',
                                startedAtMs: 1_000,
                                updatedAtMs: 1_010,
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.localId).toBe('segment-1');
    });

    it('preserves transcript stream segment messageRole for downstream normalization', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'event-segment-1',
                messageRole: 'event',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'assistant',
                                message: {
                                    role: 'assistant',
                                    content: [{ type: 'text', text: 'transport status' }],
                                },
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.messageRole).toBe('event');
    });

    it('parses transcript stream segment snapshots carrying a live-stream tick', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                messageRole: 'agent',
                tick: 25,
                content: { t: 'encrypted', c: 'cipher' },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(res?.type).toBe('transcript-stream-segment');
        expect((res as any)?.message?.tick).toBe(25);
    });

    it('parses transcript stream segment delta ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment-delta',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                messageRole: 'agent',
                tick: 2,
                baseLength: 5,
                content: { t: 'encrypted', c: 'cipher-of-delta' },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('transcript-stream-segment-delta');
        expect((res as any)?.message?.tick).toBe(2);
        expect((res as any)?.message?.baseLength).toBe(5);
    });

    it('rejects transcript stream segment deltas without chaining fields', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'transcript-stream-segment-delta',
            sessionId: 's1',
            message: {
                localId: 'segment-1',
                content: { t: 'encrypted', c: 'cipher' },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(res).toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('parses direct-session transcript delta ephemerals', () => {
        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1_000,
                    raw: { role: 'user', content: { type: 'text', text: 'Hello direct' } },
                },
            ],
            fromCursor: 'tail-cursor-0',
            nextCursor: 'tail-cursor-1',
            truncated: false,
            truncationReason: 'page_limit',
        });

        expect(res).not.toBeNull();
        expect(res?.type).toBe('direct-session-transcript-delta');
        expect((res as any)?.fromCursor).toBe('tail-cursor-0');
        expect((res as any)?.nextCursor).toBe('tail-cursor-1');
        expect((res as any)?.truncationReason).toBe('page_limit');
    });

    it('rejects non-truncated direct-session cursor advancement without fromCursor', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [],
            nextCursor: 'tail-cursor-1',
            truncated: false,
        });

        expect(res).toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('rejects unknown direct-session transcript truncation reasons in the compatibility parser', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [],
            fromCursor: 'tail-cursor-0',
            nextCursor: 'tail-cursor-1',
            truncated: true,
            truncationReason: 'cursor_maybe_changed',
        });

        expect(res).toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('rejects unanchored page-limit cursor advancement in the compatibility parser', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            items: [],
            nextCursor: 'tail-cursor-1',
            truncated: true,
            truncationReason: 'page_limit',
        });

        expect(res).toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('returns null for invalid ephemeral payloads', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = parseEphemeralUpdate({
            type: 'activity',
            active: true,
            // missing required id
        });

        expect(res).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
    });
});
