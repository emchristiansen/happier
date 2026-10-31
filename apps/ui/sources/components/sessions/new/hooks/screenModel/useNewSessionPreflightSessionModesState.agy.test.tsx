import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { buildSpawnHappySessionRpcParams } from '@/sync/domains/session/spawn/spawnSessionPayload';
import { resolveAgentNativeSpawnDefinitiveRejection } from '@happier-dev/agents';
import { useNewSessionPreflightSessionModesState } from './useNewSessionPreflightSessionModesState';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
// Machine RPC is the discovery boundary; catalog, cache, options and launch validation stay real.
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: invoke }));
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

describe('Antigravity pre-session modes', () => {
  beforeEach(() => {
    resetDynamicSessionModeProbeCacheForTests();
    invoke.mockReset();
  });

  it('offers negotiated choices and admits the selected non-default mode on the initial spawn wire', async () => {
    invoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      provider: 'agy', source: 'dynamic',
      availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto Edit' }, { id: 'yolo', name: 'YOLO' }],
    } } });
    const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
      backendTarget: { kind: 'builtInAgent', agentId: 'agy' },
      selectedMachineId: 'machine-agy', capabilityServerId: 'server-agy', cwd: '/repo',
    }));
    expect(hook.getCurrent().modeOptions.map((mode) => mode.id)).toEqual(['default', 'auto_edit', 'yolo']);
    const selected = hook.getCurrent().modeOptions.find((mode) => mode.id === 'auto_edit')!;
    const payload = buildSpawnHappySessionRpcParams({
      machineId: 'machine-agy', directory: '/repo', backendTarget: { kind: 'builtInAgent', agentId: 'agy' },
      agentModeId: selected.id, agentModeUpdatedAt: 123,
    });
    expect(payload).toMatchObject({ backendTarget: { kind: 'builtInAgent', agentId: 'agy' }, agentModeId: 'auto_edit' });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ agentId: 'agy', selection: { acpSessionModeId: payload.agentModeId } })).toEqual({ ok: true });
    await hook.unmount();
  });

  it('keeps signed-out discovery unavailable without inventing provider mode choices', async () => {
    invoke.mockResolvedValue({ supported: true, response: { ok: false, error: { code: 'auth-required' } } });
    const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
      backendTarget: { kind: 'builtInAgent', agentId: 'agy' },
      selectedMachineId: 'machine-signed-out', capabilityServerId: 'server-agy', cwd: '/repo',
    }));
    expect(hook.getCurrent().preflightModes).toBeNull();
    expect(hook.getCurrent().modeOptions.map((mode) => mode.id)).not.toContain('auto_edit');
    expect(hook.getCurrent().modeOptions.map((mode) => mode.id)).not.toContain('yolo');
    await hook.unmount();
  });
});
