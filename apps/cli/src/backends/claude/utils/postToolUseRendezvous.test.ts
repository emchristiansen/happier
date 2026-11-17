import { describe, expect, it } from 'vitest';
import { createPostToolUseRendezvous } from './postToolUseRendezvous';

describe('PostToolUse response rendezvous', () => {
    it('accepts a single message only for the captured pending response', async () => {
        const broker = createPostToolUseRendezvous();
        expect(broker.current()).toBeUndefined();
        const response = broker.wait(new AbortController().signal);
        const pending = broker.current()!;
        expect(pending.offer('first')).toBe(true);
        expect(pending.offer('second')).toBe(false);
        await expect(response).resolves.toBe('first');
        expect(broker.current()).toBeUndefined();
    });

    it('retires an aborted response and never redirects a captured offer to a later hook', async () => {
        const broker = createPostToolUseRendezvous();
        const controller = new AbortController();
        const abandoned = broker.wait(controller.signal);
        const old = broker.current()!;
        controller.abort();
        await expect(abandoned).resolves.toBeUndefined();
        const laterController = new AbortController();
        const later = broker.wait(laterController.signal);
        expect(old.offer('stale')).toBe(false);
        expect(broker.current()!.offer('new')).toBe(true);
        await expect(later).resolves.toBe('new');
    });

    it('rejects already-aborted waits and overlapping hook responses', async () => {
        const broker = createPostToolUseRendezvous();
        const aborted = new AbortController();
        aborted.abort();
        await expect(broker.wait(aborted.signal)).resolves.toBeUndefined();
        expect(broker.current()).toBeUndefined();
        const controller = new AbortController();
        const first = broker.wait(controller.signal);
        await expect(broker.wait(new AbortController().signal)).resolves.toBeUndefined();
        expect(broker.current()?.offer('first survives')).toBe(true);
        await expect(first).resolves.toBe('first survives');
        expect(broker.current()).toBeUndefined();
    });
});
