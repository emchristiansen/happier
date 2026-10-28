import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createToolCallMessageFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const sessionExecutionRunListSpy = vi.fn();

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: (...args: unknown[]) => sessionExecutionRunListSpy(...args),
}));

import { resolveRunningExecutionRunsFromListResult, useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('resolveRunningExecutionRunsFromListResult', () => {
    it('returns only execution runs with status=running', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            runs: [
                { runId: 'run_1', status: 'running' } as any,
                { runId: 'run_2', status: 'failed' } as any,
                { runId: 'run_3', status: 'completed' } as any,
            ],
        } as any);

        expect(out.map((run) => run.runId)).toEqual(['run_1']);
    });

    it('returns empty array for ok:false responses', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            ok: false,
            error: 'RPC failed',
        } as any);
        expect(out).toEqual([]);
    });
});

describe('useSessionRunningExecutionRuns', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sessionExecutionRunListSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('updates the warm roster when only turn activity or run class changes and preserves idle recipients', async () => {
        const { stubServerFeaturesFetch } = await import('../server/serverFeaturesTestUtils');
        stubServerFeaturesFetch();
        const { useSessionSubagents } = await import('./useSessionSubagents');
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running', runClass: 'long_lived', turnInFlight: true }] })
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running', runClass: 'long_lived', turnInFlight: false }] })
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running', runClass: 'bounded', turnInFlight: false }] });
        const session = createSessionFixture({ id: 'warm-execution-activity' });
        const messages = [createToolCallMessageFixture({ tool: {
            id: 'tool-run', name: 'SubAgentRun', state: 'running',
            input: { runId: 'run_1', runClass: 'long_lived', intent: 'delegate' },
            createdAt: 1, startedAt: 1, completedAt: null, description: null,
        } })];
        const hook = await renderHook(() => useSessionSubagents({
            sessionId: session.id, session, messages,
            directSessionRuntime: { directSessionLink: null, status: null, refreshNow: async () => null },
        }));
        expect(hook.getCurrent().subagents[0]?.isActive).toBe(true);
        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 5_000 });
        expect(hook.getCurrent().subagents[0]).toMatchObject({ status: 'running', isActive: false, capabilities: { canSend: true } });
        expect(hook.getCurrent().participantTargets).toHaveLength(1);
        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 5_000 });
        expect(hook.getCurrent().subagents[0]?.isActive).toBe(true);
        await hook.unmount();
    });

    it('polls while a run is running and stops after it is confirmed finished', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] })
            .mockResolvedValueOnce({ runs: [] })
            .mockResolvedValueOnce({ runs: [] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 5_000 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 1_000 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toEqual([]);

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(3);
    });

    it('keeps the same running run reference when polling returns unchanged runs', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] })
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        const first = hook.getCurrent();

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 5_000 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toBe(first);
    });

    it('does not poll repeatedly when there are no running runs', async () => {
        sessionExecutionRunListSpy.mockResolvedValueOnce({ runs: [] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toEqual([]);

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60_000 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the empty running-runs reference stable after an idle poll', async () => {
        sessionExecutionRunListSpy.mockResolvedValueOnce({ runs: [] });

        let renderCount = 0;
        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) => {
                renderCount += 1;
                return useSessionRunningExecutionRuns({ sessionId, enabled });
            },
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        const initial = hook.getCurrent();

        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toBe(initial);
        expect(renderCount).toBe(1);
    });

    it('clears running runs when disabled', async () => {
        sessionExecutionRunListSpy.mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);

        await hook.rerender({ sessionId: 's1', enabled: false });
        expect(hook.getCurrent()).toEqual([]);
    });

    it('rechecks for running runs when execution-run activity is observed', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [] })
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toEqual([]);

        notifyExecutionRunActivity('s1');
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);
        hook.unmount();
    });

    it('rechecks after activity arrives during an in-flight poll', async () => {
        let resolveFirstPoll: ((value: { runs: readonly any[] }) => void) | null = null;
        sessionExecutionRunListSpy
            .mockImplementationOnce(
                () =>
                    new Promise<{ runs: readonly any[] }>((resolve) => {
                        resolveFirstPoll = resolve;
                    }),
            )
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        notifyExecutionRunActivity('s1');
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(resolveFirstPoll).not.toBeNull();
        resolveFirstPoll!({ runs: [] });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);
    });

    it('clears running runs state immediately when sessionId changes', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] })
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve({ runs: [] }), 100);
                    }),
            );

        const hook = await renderHook(
            ({ sessionId, enabled }: Readonly<{ sessionId: string; enabled: boolean }>) =>
                useSessionRunningExecutionRuns({ sessionId, enabled }),
            {
                initialProps: { sessionId: 's1', enabled: true },
            },
        );
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().map((r: any) => r.runId)).toEqual(['run_1']);

        await hook.rerender({ sessionId: 's2', enabled: true });

        // The old runs should be cleared immediately (synchronously) before the new poll completes
        expect(hook.getCurrent()).toEqual([]);
    });
});
