import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createAdoptedExecutionRunRootCleanup } from '../runsBridge/createAdoptedExecutionRunRootCleanup';
import { createExecutionRunConnectedServicesBridge } from '../runsBridge/materializeConnectedServicesForRun';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { rehydrateLiveExecutionRunRuntimeTargets } from './executionRunTargetRehydration';

const launch = {
  v: 1 as const,
  runKey: 'execution_run:one',
  agentId: 'codex',
  connectedServicesBindings: {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'team' },
    },
  },
  brokerSelectionIdentity: 'broker:team',
  runtimeAccountIdentitySelections: [{
    serviceId: 'openai-codex' as const,
    profileId: 'team',
    groupId: null,
    groupGeneration: null,
    providerAccountId: 'acct-team',
    accountLabel: null,
    source: 'spawn_selection' as const,
  }],
  sessionDirectory: '/workspace',
  materializedRoot: '/managed/materialized/execution_run_one',
};

describe('rehydrateLiveExecutionRunRuntimeTargets', () => {
  it('preserves adopted resumable and unknown legacy homes while cleaning explicitly ephemeral homes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'happier-adopted-run-retention-'));
    try {
      const base = join(sandbox, 'materialized');
      for (const retentionPolicy of ['resumable', 'ephemeral', undefined, 'invalid']) {
        const runId = `run-${retentionPolicy ?? 'legacy'}`;
        const runKey = `execution_run:${runId}`;
        const root = resolveConnectedServiceMaterializedRootDir({ baseDir: base, agentId: 'codex', materializationKey: runKey });
        const historyPath = join(root, 'codex-home', 'sessions', 'rollout.jsonl');
        await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
        await writeFile(historyPath, 'private retained run history\n');
        const registry = new ConnectedServiceRuntimeRegistry();
        const bridge = createExecutionRunConnectedServicesBridge({
          resolveAuthForSpawn: async () => { throw new Error('Passive adoption must not materialize'); },
          runtimeRegistry: registry,
          createAdoptedRootCleanup: (input) => createAdoptedExecutionRunRootCleanup({
            ...input,
            materializationBaseDir: base,
            removeRoot: async (path) => await rm(path, { recursive: true, force: true }),
          }),
        });

        expect(await rehydrateLiveExecutionRunRuntimeTargets({
          markers: [{ runId, happySessionId: 'session-1', pid: 4321, status: 'running', retentionPolicy,
            executionRunConnectedServicesLaunchV1: { ...launch, runKey, materializedRoot: root } }],
          runtimeRegistry: registry,
          proveRunnerLive: async () => true,
          adoptCleanup: bridge.adoptLiveMaterialization,
        })).toEqual({ registeredRunIds: [runId], inactiveRunIds: [] });
        expect(await bridge.release({ runId, materializationKey: runKey, pid: 4321 })).toEqual({ released: true });
        expect(registry.listTargets()).toEqual([]);
        if (retentionPolicy === 'ephemeral') {
          await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(await readFile(historyPath, 'utf8')).toBe('private retained run history\n');
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('passively re-registers only an exact demonstrably-live launch record', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const launchWork = vi.fn();
    const resumeWork = vi.fn();
    const sendWork = vi.fn();
    const drainWork = vi.fn();
    const adoptCleanup = vi.fn(() => true);

    const result = await rehydrateLiveExecutionRunRuntimeTargets({
      markers: [{ runId: 'run-1', happySessionId: 'session-1', pid: 4321, status: 'running', executionRunConnectedServicesLaunchV1: launch }],
      runtimeRegistry: registry,
      proveRunnerLive: async (marker) => marker.pid === 4321 && marker.happySessionId === 'session-1',
      adoptCleanup,
    });

    expect(result).toEqual({ registeredRunIds: ['run-1'], inactiveRunIds: [] });
    expect(registry.listRefreshTargets()).toEqual([
      expect.objectContaining({
        pid: 4321,
        agentId: 'codex',
        sessionId: 'session-1',
        materializationKey: 'execution_run:one',
        brokerSelectionIdentity: 'broker:team',
        connectedServicesBindingsRaw: launch.connectedServicesBindings,
        runtimeAccountIdentitySelections: launch.runtimeAccountIdentitySelections,
      }),
    ]);
    expect(launchWork).not.toHaveBeenCalled();
    expect(resumeWork).not.toHaveBeenCalled();
    expect(sendWork).not.toHaveBeenCalled();
    expect(drainWork).not.toHaveBeenCalled();
    expect(adoptCleanup).toHaveBeenCalledWith({
      runId: 'run-1',
      runKey: 'execution_run:one',
      pid: 4321,
      agentId: 'codex',
      materializedRoot: '/managed/materialized/execution_run_one',
      retentionPolicy: null,
    });
  });

  it('preserves optional exact selection generation and revision and publishes run-key registration', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision,
    }]);
    const registrations: unknown[] = [];
    registry.onTargetRegistration((registration) => registrations.push(registration));

    await rehydrateLiveExecutionRunRuntimeTargets({
      markers: [{
        runId: 'run-1',
        happySessionId: 'session-1',
        pid: 4321,
        status: 'running',
        executionRunConnectedServicesLaunchV1: { ...launch, connectedServiceSelectionsJson },
      }],
      runtimeRegistry: registry,
      proveRunnerLive: async () => true,
      adoptCleanup: () => true,
    });

    expect(registry.listTargets()[0]?.activeBindings).toEqual([expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'team',
      credentialRevision,
    })]);
    expect(registrations).toEqual([expect.objectContaining({
      key: { kind: 'execution_run', runKey: launch.runKey },
      target: registry.listTargets()[0],
    })]);
  });

  it('leaves dead, terminal, malformed, and ambiguous evidence inactive', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const adoptCleanup = vi.fn();
    const markers = [
      { runId: 'dead', happySessionId: 's', pid: 1, status: 'running', executionRunConnectedServicesLaunchV1: launch },
      { runId: 'terminal', happySessionId: 's', pid: 2, status: 'succeeded', executionRunConnectedServicesLaunchV1: launch },
      { runId: 'malformed', happySessionId: 's', pid: 3, status: 'running', executionRunConnectedServicesLaunchV1: { ...launch, runKey: '' } },
      { runId: 'ambiguous-a', happySessionId: 's', pid: 4, status: 'running', executionRunConnectedServicesLaunchV1: launch },
      { runId: 'ambiguous-b', happySessionId: 's', pid: 5, status: 'running', executionRunConnectedServicesLaunchV1: launch },
    ];

    const result = await rehydrateLiveExecutionRunRuntimeTargets({
      markers,
      runtimeRegistry: registry,
      proveRunnerLive: async (marker) => marker.runId !== 'dead',
      adoptCleanup,
    });

    expect(result.registeredRunIds).toEqual([]);
    expect(result.inactiveRunIds).toEqual(['dead', 'terminal', 'malformed', 'ambiguous-a', 'ambiguous-b']);
    expect(registry.listTargets()).toEqual([]);
    expect(adoptCleanup).not.toHaveBeenCalled();
  });

  it('loads the marker snapshot only when passive rehydration begins', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const loadMarkers = vi.fn(async () => [{
      runId: 'terminal-before-rehydration',
      happySessionId: 'session-1',
      pid: 4321,
      status: 'succeeded',
      finishedAtMs: 10,
      executionRunConnectedServicesLaunchV1: launch,
    }]);

    const result = await rehydrateLiveExecutionRunRuntimeTargets({
      markers: loadMarkers,
      runtimeRegistry: registry,
      proveRunnerLive: async () => true,
      adoptCleanup: vi.fn(() => true),
    });

    expect(loadMarkers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      registeredRunIds: [],
      inactiveRunIds: ['terminal-before-rehydration'],
    });
  });
});
