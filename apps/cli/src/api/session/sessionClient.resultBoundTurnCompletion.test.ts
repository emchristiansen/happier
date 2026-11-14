import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

const { notifyDaemonConnectedServiceTurnLifecycleMock } = vi.hoisted(() => ({
    notifyDaemonConnectedServiceTurnLifecycleMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return {
        ...actual,
        notifyDaemonConnectedServiceTurnLifecycle: (...args: unknown[]) => notifyDaemonConnectedServiceTurnLifecycleMock(...args),
    };
});

import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { ApiSessionClient } from './sessionClient';

const CONTRACT = 'claude_sdk_result_bound_v1';
const issue: SessionRuntimeIssueV1 = {
    v: 1, scope: 'primary_session', status: 'failed', provider: 'claude',
    code: 'provider_status_error', source: 'provider_status_error', occurredAt: 1,
};

/**
 * Boundary fixture. Real: ApiSessionClient.prototype.markResultBoundTurnCompletion and the private
 * notifyDaemonConnectedServiceTurnLifecycle, driven by a real SessionTurnLifecycle wired exactly as
 * the constructor wires onTurnLifecycleEvent. Substituted: the constructor (sockets/outbox), the
 * durable turn-mutation writer (resolves immediately), metadata (none) and the daemon HTTP client
 * (mocked at the controlClient export, so the received options are the observable contract).
 */
function createBoundaryClient() {
    const client = Object.create(ApiSessionClient.prototype) as any;
    client.sessionId = 's1';
    client.startedByDaemonProcess = true;
    client.daemonTurnLifecycleNotifyTail = Promise.resolve();
    client.resultBoundTurnCompletion = null;
    client.getMetadataSnapshot = () => null;
    const notifications: Promise<unknown>[] = [];
    let sequence = 0;
    client.sessionTurnLifecycle = createSessionTurnLifecycle({
        sessionId: 's1',
        createId: () => `t${++sequence}`,
        enqueueSessionTurn: async () => {},
        onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
            notifications.push(client.notifyDaemonConnectedServiceTurnLifecycle(event, terminalStatus, turnId));
        },
    });
    return {
        client: client as ApiSessionClient & { sessionTurnLifecycle: ReturnType<typeof createSessionTurnLifecycle> },
        notifyPrivate: (...args: unknown[]) => client.notifyDaemonConnectedServiceTurnLifecycle(...args) as Promise<unknown>,
        settle: async () => { await Promise.all(notifications); },
    };
}

function terminalCalls() {
    return notifyDaemonConnectedServiceTurnLifecycleMock.mock.calls
        .filter(([body]) => body.event === 'assistant_message_end' || body.event === 'turn_cancelled')
        .map(([body, options]) => ({
            turnId: body.turnId as string | undefined,
            event: body.event as string,
            terminalStatus: body.terminalStatus as string | undefined,
            contract: (options as { turnCompletionContract?: string } | undefined)?.turnCompletionContract,
        }));
}

describe('ApiSessionClient result-bound turn completion contract', () => {
    beforeEach(() => {
        notifyDaemonConnectedServiceTurnLifecycleMock.mockReset();
        notifyDaemonConnectedServiceTurnLifecycleMock.mockResolvedValue({});
    });

    it('sends the contract only on the marked turn\'s completed terminal, and only once', async () => {
        const { client, settle } = createBoundaryClient();
        const lifecycle = client.sessionTurnLifecycle;
        const first = await lifecycle.beginTurn({ provider: 'claude' });
        client.markResultBoundTurnCompletion(CONTRACT);
        await lifecycle.completeTurn({ provider: 'claude' });
        const second = await lifecycle.beginTurn({ provider: 'claude' });
        // Mark was consumed by the first terminal; the next completion is unqualified.
        await lifecycle.completeTurn({ provider: 'claude' });
        await settle();
        expect(terminalCalls()).toEqual([
            { turnId: first.turnId, event: 'assistant_message_end', terminalStatus: 'completed', contract: CONTRACT },
            { turnId: second.turnId, event: 'assistant_message_end', terminalStatus: 'completed', contract: undefined },
        ]);
    });

    it('does not send the contract on a failed terminal, and the failure consumes the mark', async () => {
        const { client, settle } = createBoundaryClient();
        const lifecycle = client.sessionTurnLifecycle;
        const first = await lifecycle.beginTurn({ provider: 'claude' });
        client.markResultBoundTurnCompletion(CONTRACT);
        await lifecycle.failTurn({ provider: 'claude', issue });
        const second = await lifecycle.beginTurn({ provider: 'claude' });
        await lifecycle.completeTurn({ provider: 'claude' });
        await settle();
        expect(terminalCalls()).toEqual([
            { turnId: first.turnId, event: 'assistant_message_end', terminalStatus: 'failed', contract: undefined },
            { turnId: second.turnId, event: 'assistant_message_end', terminalStatus: 'completed', contract: undefined },
        ]);
    });

    it('does not send the contract on a cancelled terminal, and cancellation consumes the mark', async () => {
        const { client, settle } = createBoundaryClient();
        const lifecycle = client.sessionTurnLifecycle;
        await lifecycle.beginTurn({ provider: 'claude' });
        client.markResultBoundTurnCompletion(CONTRACT);
        await lifecycle.cancelTurn({ provider: 'claude' });
        const second = await lifecycle.beginTurn({ provider: 'claude' });
        await lifecycle.completeTurn({ provider: 'claude' });
        await settle();
        expect(terminalCalls().map((call) => call.contract)).toEqual([undefined, undefined]);
        expect(terminalCalls().at(-1)?.turnId).toBe(second.turnId);
    });

    it('does not send the contract on a completion of a different turn than the marked one', async () => {
        const { client, notifyPrivate, settle } = createBoundaryClient();
        const lifecycle = client.sessionTurnLifecycle;
        const marked = await lifecycle.beginTurn({ provider: 'claude' });
        client.markResultBoundTurnCompletion(CONTRACT);
        await notifyPrivate('assistant_message_end', 'completed', 'session-turn:other');
        // The foreign terminal consumed the mark: the marked turn's own completion is now unqualified.
        await lifecycle.completeTurn({ provider: 'claude' });
        await settle();
        expect(terminalCalls()).toEqual([
            { turnId: 'session-turn:other', event: 'assistant_message_end', terminalStatus: 'completed', contract: undefined },
            { turnId: marked.turnId, event: 'assistant_message_end', terminalStatus: 'completed', contract: undefined },
        ]);
    });

    it('records no mark when no turn is active', async () => {
        const { client, settle } = createBoundaryClient();
        const lifecycle = client.sessionTurnLifecycle;
        client.markResultBoundTurnCompletion(CONTRACT);
        await lifecycle.beginTurn({ provider: 'claude' });
        await lifecycle.completeTurn({ provider: 'claude' });
        await settle();
        expect(terminalCalls().map((call) => call.contract)).toEqual([undefined]);
    });
});
