import { describe, expect, it } from 'vitest';

import { createSessionTurnLifecycle } from './lifecycle';

function createMarkerHarness() {
    const terminalEvents: Array<Readonly<{ terminalStatus?: string; turnId?: string }>> = [];
    const lifecycle = createSessionTurnLifecycle({
        sessionId: 'happier-session',
        enqueueSessionTurn: async () => {},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            if (event === 'assistant_message_end') terminalEvents.push({ terminalStatus, turnId });
            if (event === 'turn_cancelled') terminalEvents.push({ terminalStatus: 'cancelled', turnId });
        },
    });
    const marker = async (type: string, id?: string) => {
        await lifecycle.observeAcpLifecycleMarker({
            provider: 'claude',
            body: (id === undefined ? { type } : { type, id }) as never,
        }).pendingWrite;
    };
    return { lifecycle, terminalEvents, marker };
}

describe('session turn lifecycle: explicit provider turn ids own their terminal markers (SDK-2)', () => {
    it.each(['task_complete', 'turn_cancelled', 'turn_aborted', 'turn_failed'] as const)(
        'a %s for non-adjacent older turn A cannot terminalize identified active turn C',
        async (type) => {
            const { lifecycle, terminalEvents, marker } = createMarkerHarness();
            try {
                await marker('task_started', 'A'); await marker('task_complete', 'A');
                await marker('task_started', 'B'); await marker('task_complete', 'B');
                await marker('task_started', 'C');
                const turnC = lifecycle.getActiveTurnId();
                const terminalsBefore = terminalEvents.length;

                await marker(type, 'A');

                expect(lifecycle.getActiveTurnId()).toBe(turnC);
                expect(terminalEvents).toHaveLength(terminalsBefore);

                await marker('task_complete', 'C');
                expect(lifecycle.hasActiveTurn()).toBe(false);
                expect(terminalEvents.at(-1)).toEqual({ terminalStatus: 'completed', turnId: turnC });
            } finally {
                lifecycle.dispose();
            }
        },
    );

    it('an unbound (id-less) terminal marker still settles the identified active turn', async () => {
        const { lifecycle, terminalEvents, marker } = createMarkerHarness();
        try {
            await marker('task_started', 'C');
            const turnC = lifecycle.getActiveTurnId();
            await marker('turn_aborted');
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(terminalEvents.at(-1)).toEqual({ terminalStatus: 'cancelled', turnId: turnC });
        } finally {
            lifecycle.dispose();
        }
    });

    // Gemini, the Codex app server and the standard ACP abort path mint a fresh id per terminal
    // marker (runGemini.ts, codex appServer runtime.ts, runStandardAcpProvider.ts handleAbort); the
    // standard ACP path opens its turn with an explicit task_started id. Such a marker names no
    // ended turn, so it must still settle the identified active turn.
    it.each(['task_complete', 'turn_aborted', 'turn_failed'] as const)(
        'a %s with a fresh never-ended id still settles the identified active turn',
        async (type) => {
            const { lifecycle, terminalEvents, marker } = createMarkerHarness();
            try {
                await marker('task_started', 'A'); await marker('task_complete', 'A');
                await marker('task_started', 'C');
                const turnC = lifecycle.getActiveTurnId();
                await marker(type, 'fresh-random-marker-id');
                expect(lifecycle.hasActiveTurn()).toBe(false);
                expect(terminalEvents.at(-1)?.turnId).toBe(turnC);
            } finally {
                lifecycle.dispose();
            }
        },
    );

    it('a late terminal for the turn that just ended does not settle the next, unidentified turn', async () => {
        const { lifecycle, terminalEvents, marker } = createMarkerHarness();
        try {
            await marker('task_started', 'A'); await marker('turn_failed', 'A');
            const next = await lifecycle.beginTurn({ provider: 'claude' });
            const terminalsBefore = terminalEvents.length;
            await marker('task_complete', 'A');
            expect(lifecycle.getActiveTurnId()).toBe(next.turnId);
            expect(terminalEvents).toHaveLength(terminalsBefore);
        } finally {
            lifecycle.dispose();
        }
    });

    it('an identified terminal marker still settles a legacy active turn that has no provider id', async () => {
        const { lifecycle, terminalEvents, marker } = createMarkerHarness();
        try {
            const turn = await lifecycle.beginTurn({ provider: 'claude' });
            await marker('turn_failed', 'other-provider-id');
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(terminalEvents.at(-1)).toEqual({ terminalStatus: 'failed', turnId: turn.turnId });
        } finally {
            lifecycle.dispose();
        }
    });
});
