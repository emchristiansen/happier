import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostToolUseSteeringBroker } from './postToolUseSteeringBroker';

describe('PostToolUse steering broker', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('lets a hook response take a waiting offer without the hook ever waiting', async () => {
        const broker = createPostToolUseSteeringBroker();
        expect(broker.take()).toBeUndefined();
        const outcome = broker.offer({ message: 'steer me', waitMs: 1_000 });
        const taken = broker.take();
        expect(taken?.additionalContext).toBe('steer me');
        expect(broker.take()).toBeUndefined();
        taken!.settle(true);
        await expect(outcome).resolves.toBe('written_to_hook_response');
    });

    it('retires an offer at its caller deadline and never hands it to a later hook', async () => {
        const broker = createPostToolUseSteeringBroker();
        const outcome = broker.offer({ message: 'too late', waitMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(outcome).resolves.toBe('no_tool_boundary');
        expect(broker.take()).toBeUndefined();
    });

    it('withdraws an untaken offer when its caller aborts', async () => {
        const broker = createPostToolUseSteeringBroker();
        const controller = new AbortController();
        const outcome = broker.offer({ message: 'cancelled', waitMs: 60_000, signal: controller.signal });
        controller.abort();
        await expect(outcome).resolves.toBe('no_tool_boundary');
        expect(broker.take()).toBeUndefined();
        const aborted = new AbortController();
        aborted.abort();
        await expect(broker.offer({ message: 'never', waitMs: 1_000, signal: aborted.signal })).resolves.toBe('no_tool_boundary');
        expect(broker.take()).toBeUndefined();
    });

    it('reports a response that closed before it was written as lost, and keeps no copy for a later hook', async () => {
        const broker = createPostToolUseSteeringBroker();
        const outcome = broker.offer({ message: 'lost', waitMs: 1_000 });
        const taken = broker.take()!;
        taken.settle(false);
        taken.settle(true);
        await expect(outcome).resolves.toBe('hook_response_lost');
        expect(broker.take()).toBeUndefined();
    });

    it('keeps a taken offer bound to its response after the caller deadline or abort', async () => {
        const broker = createPostToolUseSteeringBroker();
        const controller = new AbortController();
        const outcome = broker.offer({ message: 'bound', waitMs: 1_000, signal: controller.signal });
        const taken = broker.take()!;
        controller.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        taken.settle(true);
        await expect(outcome).resolves.toBe('written_to_hook_response');
    });

    it('delivers every live offer through one boundary so an uncertain earlier message cannot strand later ones', async () => {
        const broker = createPostToolUseSteeringBroker();
        const first = broker.offer({ message: 'first', waitMs: 1_000 });
        const lostTaken = broker.take()!;
        lostTaken.settle(false);
        await expect(first).resolves.toBe('hook_response_lost');

        // The caller retries the uncertain message while a later message is also waiting.
        const retry = broker.offer({ message: 'first', waitMs: 1_000 });
        const second = broker.offer({ message: 'second', waitMs: 1_000 });
        const taken = broker.take()!;
        expect(taken.additionalContext).toBe('first\n\nsecond');
        taken.settle(true);
        await expect(retry).resolves.toBe('written_to_hook_response');
        await expect(second).resolves.toBe('written_to_hook_response');
    });
});
