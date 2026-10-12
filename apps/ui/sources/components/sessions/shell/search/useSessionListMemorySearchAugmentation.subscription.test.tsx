import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useSessionListMemorySearchAugmentation } from './useSessionListMemorySearchAugmentation';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', generation: 1 }),
}));

function makeMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'memory-machine',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'memory-machine',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/tmp/happier',
            homeDir: '/tmp',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...overrides,
    };
}

afterEach(() => {
    standardCleanup();
});

describe('useSessionListMemorySearchAugmentation storage demand', () => {
    it('does not rerender for machine updates while the list surface is inactive', async () => {
        const previousState = storage.getState();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const machine = makeMachine();
        const subscribeSpy = vi.spyOn(storage, 'subscribe');

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: { [machine.id]: machine },
                machineListByServerId: serverId ? { [serverId]: [machine] } : {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListMemorySearchAugmentation({
                    searchQuery: 'vector',
                    getCandidateSessionKeys: () => new Set([`${serverId}:session-1`]),
                    enabled: false,
                });
            }, { flushOptions: { cycles: 1, turns: 4 } });
            const settledRenderCount = renderCount;

            expect(subscribeSpy).not.toHaveBeenCalled();

            await act(async () => {
                const updatedMachine = makeMachine({ updatedAt: 2, activeAt: 2 });
                storage.setState((state) => ({
                    ...state,
                    machines: { [updatedMachine.id]: updatedMachine },
                    machineListByServerId: serverId ? { [serverId]: [updatedMachine] } : {},
                }));
            });

            expect(renderCount).toBe(settledRenderCount);
            expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
            await hook.unmount();
        } finally {
            subscribeSpy.mockRestore();
            storage.setState(previousState);
        }
    });
});
