import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS, DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS, DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS } from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { useNewSessionPreflightModelsState } from './useNewSessionPreflightModelsState';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';

const { machineCapabilitiesInvokeMock } = vi.hoisted(() => ({ machineCapabilitiesInvokeMock: vi.fn() }));
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: machineCapabilitiesInvokeMock }));

describe('model discovery stale-while-revalidate contract', () => {
    async function setup() {
        machineCapabilitiesInvokeMock.mockReset();
        cache.resetDynamicModelProbeCacheForTests();
        const key = (cwd: string) => buildDynamicModelProbeCacheKey({ machineId: 'swr-machine', targetKey: 'agent:claude', serverId: 'swr-server', cwd })!;
        const render = (enabled = true) => renderHook(
            (props: { enabled: boolean; cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, selectedMachineId: 'swr-machine',
                capabilityServerId: 'swr-server', cwd: props.cwd, enabled: props.enabled,
            }), { initialProps: { enabled, cwd: '/repo' } },
        );
        return { cache, key, render };
    }

    it('keeps the last observation and timestamp on failure without copying it to a new cwd cache identity', async () => {
        const { cache, key, render } = await setup();
        const observedAt = Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1;
        const value = { availableModels: [{ id: 'last-good', name: 'Last good' }], supportsFreeform: true };
        cache.writeDynamicModelProbeCacheSuccess(key('/repo'), value, observedAt);
        machineCapabilitiesInvokeMock.mockResolvedValue({ supported: false, reason: 'error' });
        const hook = await render();
        expect(hook.getCurrent().preflightModels).toBe(value);
        expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
        expect(hook.getCurrent().probe.error).toBe(true);
        expect(cache.readDynamicModelProbeCache(key('/repo'))?.updatedAt).toBe(observedAt);
        await hook.rerender({ enabled: true, cwd: '/other' });
        expect(hook.getCurrent().preflightModels).toBeNull();
        expect(cache.readDynamicModelProbeCache(key('/other'))?.kind).toBe('error');
        await hook.unmount();
    });

    it('performs no requests or retry scheduling while disabled and revalidates stale data when enabled', async () => {
        vi.useFakeTimers();
        try {
            const { cache, key, render } = await setup();
            const value = { availableModels: [{ id: 'cached', name: 'Cached' }], supportsFreeform: true };
            cache.writeDynamicModelProbeCacheSuccess(key('/repo'), value, Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1);
            machineCapabilitiesInvokeMock.mockResolvedValue({ supported: false, reason: 'error' });
            const hook = await render(false);
            expect(hook.getCurrent().preflightModels).toBe(value);
            expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS * 2); });
            expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
            await hook.rerender({ enabled: true, cwd: '/repo' });
            expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
            await hook.rerender({ enabled: false, cwd: '/repo' });
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS * 2); });
            expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally { vi.useRealTimers(); }
    });

    it('accepts nonpersistent provider success without an error retry and retains equal row identity', async () => {
        vi.useFakeTimers();
        try {
            const { render } = await setup();
            const observedAt = Date.now() - 1000;
            machineCapabilitiesInvokeMock.mockResolvedValue({ supported: true, response: { ok: true, result: {
                availableModels: [{ id: 'provider-model', name: 'Provider model' }], supportsFreeform: true,
                source: 'dynamic', cacheable: false, observedAt,
            } } });
            const hook = await render();
            const models = hook.getCurrent().preflightModels;
            expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
            expect(hook.getCurrent().probe.error).toBe(false);
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1); });
            expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
            await act(async () => { hook.getCurrent().probe.onRefresh?.(); });
            expect(hook.getCurrent().preflightModels).toBe(models);
            await hook.unmount();
        } finally { vi.useRealTimers(); }
    });
});

it('accepts an authoritative empty discovery as a Default-only catalog', () => {
    expect(parsePreflightModelListFromProbeModelsResult({ availableModels: [], supportsFreeform: false })).toEqual({ availableModels: [], supportsFreeform: false });
});
