import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { useNewSessionPreflightModelsState } from './useNewSessionPreflightModelsState';

const { machineCapabilitiesInvokeMock } = vi.hoisted(() => ({ machineCapabilitiesInvokeMock: vi.fn() }));
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: machineCapabilitiesInvokeMock }));

it('synchronizes exact-key consumers after refresh without probing unrelated subscribers', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvokeMock.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'shared-machine', targetKey: 'agent:claude', serverId: 'shared-server', cwd: '/repo' })!;
    cache.writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'before', name: 'Before' }], supportsFreeform: false });
    machineCapabilitiesInvokeMock.mockResolvedValue({ supported: true, response: { ok: true, result: {
        availableModels: [{ id: 'after', name: 'After' }], supportsFreeform: false,
    } } });
    const render = (cwd: string, enabled = true) => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, selectedMachineId: 'shared-machine',
        capabilityServerId: 'shared-server', cwd, enabled,
    }));
    const screen = await render('/repo');
    const detail = await render('/repo');
    const other = await render('/other', false);
    expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
    const otherOptions = other.getCurrent().modelOptions;
    await act(async () => { detail.getCurrent().probe.onRefresh?.(); });
    await flushHookEffects();
    expect(screen.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['after']);
    expect(screen.getCurrent().preflightModels).toBe(detail.getCurrent().preflightModels);
    expect(other.getCurrent().modelOptions).toBe(otherOptions);
    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await detail.unmount();
    await other.unmount();
});
