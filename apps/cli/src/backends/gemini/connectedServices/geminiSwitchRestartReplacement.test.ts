import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountSettingsParse,
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/startDaemon';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import {
  switchSessionConnectedServiceAuth,
  type SwitchSessionConnectedServiceAuthInput,
} from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { readBuiltInCatalogAgentIdFromBackendTarget } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import { createConnectedServiceRestartReplacementHarness } from '@/daemon/testkit/connectedServiceRestartReplacement.testkit';

// Genuine server transport boundary, kept offline.
const mockFetchSessionByIdCompat = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mockFetchSessionByIdCompat,
}));

const happierSessionId = '00000000-0000-4000-8000-00000000c4c4';
const nativeSessionId = '00000000-0000-4000-8000-00000000a12c';
const runnerPid = 424243;

const previousBindings: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: { gemini: { source: 'connected', selection: 'profile', profileId: 'g1' } },
};
const nextBindings: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: { gemini: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'g1' } },
};

describe('Gemini connected-service switch restart replacement', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  async function runGroupAdoption() {
    const root = await mkdtemp(join(tmpdir(), 'happier-gemini-switch-replacement-'));
    temporaryDirectories.push(root);
    const projectDir = join(root, 'project');
    const sessionMetadata = {
      path: projectDir,
      host: 'workstation',
      homeDir: join(root, 'home'),
      happyHomeDir: join(root, 'happier-home'),
      happyLibDir: join(root, 'happier-lib'),
      happyToolsDir: join(root, 'happier-tools'),
      flavor: 'gemini',
      geminiSessionId: nativeSessionId,
      connectedServices: previousBindings,
      connectedServiceMaterializationIdentityV1: { v: 1 as const, id: 'csm_gemini_profile', createdAtMs: 1 },
    };
    // A daemon-started runner whose descriptor lost its launch target: an earlier hot apply left
    // the partial `{ directory: '' }` shape with no backendTarget.
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: happierSessionId,
      pid: runnerPid,
      spawnOptions: { directory: '' },
      happySessionMetadataFromLocalWebhook: sessionMetadata,
    };
    const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true });
    const api = {
      readConnectedServiceCredentialHealth: async ({ profileId }: Readonly<{ profileId: string }>) => (profileId === 'g1'
        ? { kind: 'found' as const, status: 'connected' as const, health: null }
        : { kind: 'not_found' as const }),
      getConnectedServiceAuthGroup: async () => ({
        v: 1 as const,
        serviceId: 'gemini' as const,
        groupId: 'pool',
        displayName: 'Pool',
        policy,
        activeProfileId: 'g1',
        generation: 3,
        runtimeStateRevision: 0,
        state: { v: 1 as const },
        members: [{
          v: 1 as const, serviceId: 'gemini' as const, groupId: 'pool', profileId: 'g1',
          priority: 100, enabled: true, state: {}, createdAt: 1, updatedAt: 1,
        }],
        createdAt: 1,
        updatedAt: 1,
      }),
    };
    const daemon = createConnectedServiceRestartReplacementHarness({
      tracked,
      sessionId: happierSessionId,
      target: { serviceId: 'gemini', profileId: 'g1', groupId: 'pool', generation: 3 },
    });
    // Server boundary: the session-metadata write.
    const persistSessionBindings = vi.fn(async () => {});

    const result = await switchSessionConnectedServiceAuth({
      core: createConnectedServiceSessionAuthSwitchCore({ locks: new ConnectedServiceSessionAuthSwitchLockRegistry() }),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'this gate exercises the restart replacement, not later provider activity',
      },
      getChildren: () => [tracked],
      api,
      // The daemon's switch continuity composition (startDaemon).
      resolveContinuity: async (continuityInput) => {
        const context = resolveTrackedConnectedServiceSwitchContinuityContext({
          agentId: continuityInput.agentId,
          baseDir: join(root, 'server'),
          tracked: continuityInput.tracked,
          persistedSessionMetadata: sessionMetadata,
          connectedServiceMaterializationIdentityV1: continuityInput.connectedServiceMaterializationIdentityV1,
          vendorResumeId: continuityInput.vendorResumeId,
          runtimeAuthSelection: continuityInput.runtimeAuthSelection,
        });
        return await resolveSessionConnectedServiceSwitchContinuity({
          sessionId: continuityInput.sessionId,
          agentId: continuityInput.agentId,
          serviceId: continuityInput.serviceId,
          previousBinding: continuityInput.previous,
          nextBinding: continuityInput.next,
          fromBindingsRaw: continuityInput.previousBindings,
          toBindings: continuityInput.normalizedBindings,
          accountSettings: accountSettingsParse({}),
          connectedServiceMaterializationIdentityV1: context.connectedServiceMaterializationIdentityV1,
          vendorResumeId: context.vendorResumeId,
          targetMaterializedRoot: context.targetMaterializedRoot,
          targetMaterializedEnv: context.targetMaterializedEnv,
          cwd: context.cwd,
          candidatePersistedSessionFile: context.candidatePersistedSessionFile,
        });
      },
      restartSession: daemon.restartSession,
      hotApply: async () => { throw new Error('a Gemini profile-to-group adoption must not hot-apply'); },
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: happierSessionId,
        agentId: 'gemini',
        bindings: nextBindings,
        expectedGroupGenerationByServiceId: { gemini: 3 },
      },
    } satisfies SwitchSessionConnectedServiceAuthInput);
    return { result, daemon, persistSessionBindings, tracked, projectDir };
  }

  it('relaunches the same Gemini session under its own backend from a partial descriptor', async () => {
    const { result, daemon, persistSessionBindings, projectDir } = await runGroupAdoption();

    expect(result.ok ? null : { errorCode: result.errorCode, diagnostics: result.diagnostics }).toBeNull();
    expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
    expect(persistSessionBindings).toHaveBeenCalledOnce();
    expect(daemon.runnerSignals()).toEqual([[runnerPid, 'SIGTERM']]);
    await vi.waitFor(() => expect(daemon.spawnSession).toHaveBeenCalledOnce());
    expect(daemon.onRespawnTerminal).not.toHaveBeenCalled();
    const replacement = daemon.spawnSession.mock.calls[0]?.[0];
    expect(replacement).toMatchObject({
      existingSessionId: happierSessionId,
      resume: nativeSessionId,
      directory: projectDir,
      backendTarget: { kind: 'builtInAgent', agentId: 'gemini' },
      connectedServices: nextBindings,
    });
    // The daemon's spawn path selects the provider from this target.
    expect(readBuiltInCatalogAgentIdFromBackendTarget(replacement?.backendTarget)).toBe('gemini');
    expect(readConnectedServiceChildSelectionsFromEnv(replacement?.environmentVariables ?? {})).toMatchObject([{
      kind: 'group', serviceId: 'gemini', groupId: 'pool', activeProfileId: 'g1', generation: 3,
    }]);
  });
});
