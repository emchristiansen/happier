import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountSettingsParse,
  ConnectedServiceAuthGroupPolicyV1Schema,
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/startDaemon';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createConnectedServiceRestartReplacementHarness } from '@/daemon/testkit/connectedServiceRestartReplacement.testkit';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { createSessionConnectedServiceAuthHotApply } from '@/daemon/connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import {
  switchSessionConnectedServiceAuth,
  type SwitchSessionConnectedServiceAuthInput,
} from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import type { Credentials } from '@/persistence';
import {
  readConnectedServiceStateSharingNativeSourceRecord,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from './materializeClaudeConnectedServiceRuntimeAuthSelection';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { resolveClaudeConnectedServiceSwitchContinuity } from './resolveClaudeConnectedServiceSwitchContinuity';
import { verifyResumeReachableClaude } from './verifyResumeReachableClaude';

// Genuine server transport boundary: the provider materializer may consult persisted session
// metadata when tracked continuity metadata is incomplete. This composition test keeps that
// boundary offline while exercising the real materializer, continuity owner, switch FSM, and
// provider hot-apply adapter.
const mockFetchSessionByIdCompat = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mockFetchSessionByIdCompat,
}));

/**
 * In production every Claude home is produced (and its admitted native source recorded) by a spawn
 * before an account switch rematerializes it; these fixtures skip that production, so they record,
 * for each Claude home they expect materialized, the source their `processEnv` names.
 */
async function seedAdmittedClaudeHomeSource(
  claudeConfigDir: string | null,
  nativeSourceEnv: Readonly<Record<string, string>>,
): Promise<void> {
  if (!claudeConfigDir) throw new Error('fixture: Claude config dir must resolve');
  await writeConnectedServiceStateSharingManifest(claudeConfigDir, {
    v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 0,
    configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
    nativeSourceEnv,
  });
}

const NEW_CREDENTIAL_REVISION = 'csr_bcdefghijklmnopqrstuvw';

function groupBindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'claude-subscription': {
        source: 'connected',
        selection: 'group',
        groupId: 'work',
        profileId,
      },
    },
  };
}

describe('Claude shared-group switch continuity', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    mockFetchSessionByIdCompat.mockClear();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  it.each([false, true])('prepares an inactive account-change target without dry-run writes (dryRun=%s)', async (dryRun) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-inactive-continuity-'));
    temporaryDirectories.push(root);
    const projectDir = join(root, 'project');
    const homeDir = join(root, 'home');
    const activeServerDir = join(root, 'server');
    const vendorResumeId = 'inactive-claude-session';
    const source = join(root, 'old-home', 'projects', 'project', `${vendorResumeId}.jsonl`);
    await mkdir(join(root, 'old-home', 'projects', 'project'), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(source, '{}\n');
    const metadata = { path: projectDir, claudeSessionId: vendorResumeId, claudeTranscriptPath: source };
    const binding = (profileId: string): ConnectedServiceBindingsV1 => ({
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId } },
    });
    const nextBindings = binding('next');
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000, serviceId: 'claude-subscription', profileId: 'next', kind: 'oauth', expiresAt: 2_000,
      oauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE, tokenType: 'Bearer', providerAccountId: 'synthetic', providerEmail: null },
    });
    const credentials = { token: 'synthetic-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies Credentials;
    const api = { getConnectedServiceAuthGroup: async () => null,
      readConnectedServiceCredentialHealth: async ({ profileId }: Readonly<{ profileId: string }>) => (profileId === 'next'
        ? { kind: 'found' as const, status: 'connected' as const, health: null }
        : { kind: 'not_found' as const }) };
    // A dry run must not write the server dir at all, so only the applied switch is seeded.
    if (!dryRun) {
      await seedAdmittedClaudeHomeSource(resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir, serviceId: 'claude-subscription', fallbackProfileId: 'next',
        selection: { kind: 'profile', profileId: 'next' },
      }), { CLAUDE_CONFIG_DIR: join(homeDir, '.claude'), HOME: homeDir });
    }
    const result = await switchSessionConnectedServiceAuth({
      dryRun,
      core: createConnectedServiceSessionAuthSwitchCore({ locks: new ConnectedServiceSessionAuthSwitchLockRegistry() }),
      getChildren: () => [], api,
      resolveInactiveSession: async () => ({ agentId: 'claude', connectedServices: binding('old'),
        connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_inactive', createdAtMs: 0 }, vendorResumeId,
        cwd: projectDir, metadata, candidatePersistedSessionFile: source }),
      materializeRuntimeAuthSelection: async (input) => await materializeClaudeConnectedServiceRuntimeAuthSelection({
        credentials, api: api as unknown as ApiClient, activeServerDir, input,
        baseSelection: { serviceId: 'claude-subscription', binding: nextBindings.bindingsByServiceId['claude-subscription'],
          profileId: 'next', record, credentialRevision: NEW_CREDENTIAL_REVISION },
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude') },
      }),
      resolveContinuity: async (input) => {
        const context = resolveTrackedConnectedServiceSwitchContinuityContext({
          agentId: input.agentId, baseDir: activeServerDir, tracked: input.tracked,
          connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
          vendorResumeId: input.vendorResumeId, cwd: projectDir, runtimeAuthSelection: input.runtimeAuthSelection,
        });
        const reachable = await verifyResumeReachableClaude({ vendorResumeId, processEnv: context.targetMaterializedEnv ?? {}, targetStrict: true });
        return reachable.ok ? { mode: 'restart_rematerialize' } : { mode: 'unsupported', reason: 'provider_session_state_unavailable_for_resume', errorCode: 'provider_session_state_unavailable_for_resume' };
      },
      persistSessionBindings: async () => {}, emitSessionEvent: async () => {},
      restartSession: async () => { throw new Error('inactive session must not restart'); },
      hotApply: async () => { throw new Error('inactive session must not hot-apply'); },
      registerHotApplyTargets: () => { throw new Error('inactive session has no hot-apply target'); },
      request: { sessionId: 'inactive', agentId: 'claude', bindings: nextBindings },
    } satisfies SwitchSessionConnectedServiceAuthInput);
    if (dryRun) {
      expect(result.ok).toBe(false);
      expect(await stat(activeServerDir).catch(() => null)).toBeNull();
    } else {
      expect(result).toMatchObject({ ok: true, action: 'metadata_updated' });
    }
    expect(mockFetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it.each(['leeroy', 'lb_bat'])('hot-applies an exact same-group shared-home rewrite from %s when spawn request env predates materialization', async (previousProfileId) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-project-'));
    temporaryDirectories.push(activeServerDir, homeDir, projectDir);

    const selectedRecord = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'lb_bat',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'lb-bat-selected-access',
        refreshToken: 'lb-bat-selected-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'lb-bat-provider-account',
        providerEmail: 'lb-bat@example.test',
      },
    });
    const groupClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'lb_bat',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'work',
        activeProfileId: 'lb_bat',
        fallbackProfileId: 'leeroy',
        generation: 272,
        record: selectedRecord,
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
      },
    });
    if (!groupClaudeConfigDir) throw new Error('expected deterministic Claude shared group home');
    const admittedSourceEnv = { CLAUDE_CONFIG_DIR: join(homeDir, '.claude'), HOME: homeDir };
    await seedAdmittedClaudeHomeSource(groupClaudeConfigDir, admittedSourceEnv);
    await seedAdmittedClaudeHomeSource(resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir, serviceId: 'claude-subscription', fallbackProfileId: 'lb_bat',
      selection: { kind: 'profile', profileId: 'lb_bat' },
    }), admittedSourceEnv);

    const previousBindings = groupBindings(previousProfileId);
    const nextBindings = groupBindings('lb_bat');
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'claude-session',
      pid: 38562,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        // Real daemon composition stores the request-time env here. Connected Services adds the
        // finalized shared-home env later, so this snapshot is legitimately empty.
        environmentVariables: {},
      },
    };
    const credentials = {
      token: 'account-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    } satisfies Credentials;
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceCredentialPlain: async () => ({
        content: { t: 'plain' as const, v: selectedRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: NEW_CREDENTIAL_REVISION,
      }),
      getConnectedServiceCredentialSealed: async () => null,
      readConnectedServiceCredentialHealth: async ({ profileId }: Readonly<{ profileId: string }>) => (profileId === 'lb_bat'
        ? { kind: 'found' as const, status: 'connected' as const, health: null }
        : { kind: 'not_found' as const }),
      getConnectedServiceAuthGroup: async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'work',
        displayName: 'Work',
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
        activeProfileId: 'lb_bat',
        generation: 272,
        runtimeStateRevision: 0,
        state: { v: 1 as const },
        members: [
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'work',
            profileId: 'leeroy',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'work',
            profileId: 'lb_bat',
            priority: 90,
            enabled: true,
            state: {},
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      }),
    };
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const validateGroupMutationCurrentness = vi.fn(createConnectedServiceGroupMutationCurrentnessValidator({
      api: api as unknown as ApiClient,
      credentials,
    }));

    const result = await switchSessionConnectedServiceAuth({
      core: createConnectedServiceSessionAuthSwitchCore({
        locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
      }),
      switchReason: 'automatic_runtime_failure',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'this gate exercises exact application and continuity, not later provider activity',
      },
      getChildren: () => [tracked],
      api,
      expectedCredentialRevisionByServiceId: {
        'claude-subscription': NEW_CREDENTIAL_REVISION,
      },
      materializeRuntimeAuthSelection: async (input) => {
        const binding = input.normalizedBindings.bindingsByServiceId['claude-subscription'];
        if (!binding || binding.source !== 'connected' || binding.selection !== 'group') {
          throw new Error('expected selected Claude subscription group binding');
        }
        const baseSelection = {
          serviceId: 'claude-subscription' as const,
          binding,
          profileId: 'lb_bat',
          groupId: 'work',
          activeProfileId: 'lb_bat',
          fallbackProfileId: 'leeroy',
          generation: 272,
          credentialRevision: NEW_CREDENTIAL_REVISION,
          record: selectedRecord,
        };
        return await materializeClaudeConnectedServiceRuntimeAuthSelection({
          credentials,
          api: api as unknown as ApiClient,
          activeServerDir,
          input,
          baseSelection,
          processEnv: {
            HOME: homeDir,
            CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
          },
        });
      },
      resolveContinuity: async (input) => {
        const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
          agentId: input.agentId,
          baseDir: activeServerDir,
          tracked: input.tracked,
          connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
          vendorResumeId: input.vendorResumeId,
          runtimeAuthSelection: input.runtimeAuthSelection,
        });
        const continuity = await resolveClaudeConnectedServiceSwitchContinuity({
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          fromBindings: input.previousBindings,
          toBindings: input.normalizedBindings,
          runtimeAuthSelection: input.runtimeAuthSelection,
          connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
          vendorResumeId: continuityContext.vendorResumeId,
          targetMaterializedRoot: continuityContext.targetMaterializedRoot,
          targetMaterializedEnv: continuityContext.targetMaterializedEnv,
          cwd: continuityContext.cwd,
          candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
        });
        if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' };
        throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
      },
      restartSession,
      hotApply: createSessionConnectedServiceAuthHotApply({
        resolveRuntimeAuthAdapter: async () => createClaudeConnectedServiceRuntimeAuthAdapter(),
        validateGroupMutationCurrentness,
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'claude-session',
        agentId: 'claude',
        bindings: nextBindings,
        expectedGroupGenerationByServiceId: {
          'claude-subscription': 272,
        },
      },
    } satisfies SwitchSessionConnectedServiceAuthInput);

    expect(result).toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: {
        'claude-subscription': 'hot_apply',
      },
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).toHaveBeenCalledOnce();
    expect(validateGroupMutationCurrentness).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      groupId: 'work',
      profileId: 'lb_bat',
      generation: 272,
      credentialRevision: NEW_CREDENTIAL_REVISION,
    });

    const registeredSelections = registerHotApplyTargets.mock.calls[0]?.[1]
      ?.runtimeAuthSelectionsByServiceId as ReadonlyMap<string, unknown> | undefined;
    expect(registeredSelections?.get('claude-subscription')).toMatchObject({
      serviceId: 'claude-subscription',
      groupId: 'work',
      activeProfileId: 'lb_bat',
      generation: 272,
      credentialRevision: NEW_CREDENTIAL_REVISION,
      targetMaterializedRoot: groupClaudeConfigDir,
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
      },
      claudeRuntimeAuthSharedGroupSurface: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir: groupClaudeConfigDir,
        runtimeMaterializedRoot: groupClaudeConfigDir,
      },
    });
    const materializedCredentials = JSON.parse(
      await readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'),
    ) as { claudeAiOauth?: { accessToken?: string } };
    expect(materializedCredentials.claudeAiOauth?.accessToken).toBe('lb-bat-selected-access');
    expect(JSON.parse(await readFile(join(groupClaudeConfigDir, '.claude.json'), 'utf8'))).toMatchObject({
      hasCompletedOnboarding: true,
    });
  });
  describe('legacy profile-bound session adopting its account group', () => {
    const vendorResumeId = '00000000-0000-4000-8000-00000000a11c';
    const otherNativeId = '00000000-0000-4000-8000-00000000b22c';
    const happierSessionId = '00000000-0000-4000-8000-00000000c3c3';
    const runnerPid = 424242;

    async function runAdoption(input: Readonly<{
      nativeSessionFileExists: boolean;
      startedBy?: 'daemon' | 'terminal';
      expectedGroupGeneration?: number;
      dryRun?: boolean;
      /** Where the session's own metadata reports its cwd (default: both, same directory). */
      cwdSource?: 'both' | 'persisted_only' | 'persisted_differs_from_webhook';
      /** 'adopt_group': profile -> group change. 'rematerialize_profile': unchanged profile rematerialized. */
      binding?: 'adopt_group' | 'rematerialize_profile';
      switchReason?: 'manual' | 'automatic_runtime_failure';
      spawnOptions?: SpawnSessionOptions;
      /** Session metadata that does not establish the Agent (two vendor resume keys, no flavor). */
      ambiguousAgentMetadata?: boolean;
      /**
       * Native identity inputs. 'stale_descriptor': tracked id a11c, launch descriptor resume b22c.
       * 'persisted_differs': persisted metadata b22c, runner report a11c, no descriptor.
       */
      nativeSource?: 'matched' | 'stale_descriptor' | 'persisted_differs';
      /**
       * The legacy session's own (emc) home as its spawn left it. 'recorded': produced with its admitted
       * native source recorded. 'unrecorded_legacy': produced before sources were recorded.
       */
      memberHomeSource?: 'recorded' | 'unrecorded_legacy';
    }>) {
      const root = await mkdtemp(join(tmpdir(), 'happier-claude-profile-to-group-'));
      temporaryDirectories.push(root);
      const activeServerDir = join(root, 'server');
      const homeDir = join(root, 'home');
      const projectDir = join(root, 'project');
      const persistedProjectDir = join(root, 'persisted-project');
      const sharedProjectsDir = join(homeDir, '.claude', 'projects');
      // The native session the continuity check proves (and the only one in the native store).
      const checkedNativeId = input.nativeSource === 'persisted_differs' ? otherNativeId : vendorResumeId;
      const nativeSessionFile = join(sharedProjectsDir, 'project-slug', `${checkedNativeId}.jsonl`);
      await mkdir(projectDir, { recursive: true });
      await mkdir(persistedProjectDir, { recursive: true });
      await mkdir(join(sharedProjectsDir, 'project-slug'), { recursive: true });
      if (input.nativeSessionFileExists) await writeFile(nativeSessionFile, '{}\n');

      const record = buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: 'emc',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'emc-access',
          refreshToken: 'emc-refresh',
          idToken: null,
          scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
          tokenType: 'Bearer',
          providerAccountId: 'emc-provider-account',
          providerEmail: 'emc@example.test',
        },
      });
      const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true });
      const rematerialize = input.binding === 'rematerialize_profile';
      const targetClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir,
        serviceId: 'claude-subscription',
        fallbackProfileId: 'emc',
        selection: rematerialize
          ? { kind: 'profile', profileId: 'emc' }
          : {
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'failover',
              activeProfileId: 'emc',
              fallbackProfileId: 'other',
              generation: 2,
              record,
              policy,
            },
      });
      if (!targetClaudeConfigDir) throw new Error('expected deterministic Claude target home');
      // The target home's native store is linked to the shared Claude projects store, as the
      // shared state mode materializes it.
      await mkdir(targetClaudeConfigDir, { recursive: true });
      await symlink(sharedProjectsDir, join(targetClaudeConfigDir, 'projects'));

      // In production the session's spawn produced its emc home; these fixtures skip that spawn, so they
      // leave the home as it would have left it. A dry run must not write the server dir at all.
      const memberClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir, serviceId: 'claude-subscription', fallbackProfileId: 'emc',
        selection: { kind: 'profile', profileId: 'emc' },
      });
      if (input.dryRun !== true) {
        if ((input.memberHomeSource ?? 'recorded') === 'recorded') {
          await seedAdmittedClaudeHomeSource(memberClaudeConfigDir, { CLAUDE_CONFIG_DIR: join(homeDir, '.claude'), HOME: homeDir });
        } else {
          if (!memberClaudeConfigDir) throw new Error('fixture: Claude config dir must resolve');
          await writeConnectedServiceStateSharingManifest(memberClaudeConfigDir, {
            v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 0,
            configEntries: [], stateEntries: [], sessionFileMappings: [], diagnostics: [],
          });
        }
      }

      const previousBindings: ConnectedServiceBindingsV1 = {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'emc' } },
      };
      const nextBindings: ConnectedServiceBindingsV1 = rematerialize ? previousBindings : {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'failover', profileId: 'emc' },
        },
      };
      // A runner adopted after a daemon restart from a marker without a respawn descriptor:
      // the daemon knows the session only from its reported metadata, not from spawn options.
      const cwdSource = input.cwdSource ?? 'both';
      const sessionMetadataBase = {
        host: 'workstation',
        homeDir,
        happyHomeDir: join(root, 'happier-home'),
        happyLibDir: join(root, 'happier-lib'),
        happyToolsDir: join(root, 'happier-tools'),
        claudeSessionId: vendorResumeId,
        ...(input.ambiguousAgentMetadata ? { geminiSessionId: 'synthetic-other-native' } : {}),
        connectedServices: previousBindings,
        connectedServiceMaterializationIdentityV1: { v: 1 as const, id: 'csm_legacy_profile', createdAtMs: 1 },
      };
      // persisted_only: the runner's own report carries no usable working directory.
      const webhookMetadata = { ...sessionMetadataBase, path: cwdSource === 'persisted_only' ? '' : projectDir };
      const persistedMetadata = {
        ...sessionMetadataBase,
        path: cwdSource === 'persisted_differs_from_webhook' ? persistedProjectDir : projectDir,
        ...(input.nativeSource === 'persisted_differs' ? { claudeSessionId: otherNativeId } : {}),
      };
      // The directory the continuity check proves is the persisted session cwd.
      const checkedDir = persistedMetadata.path;
      const tracked: TrackedSession = {
        startedBy: input.startedBy ?? 'daemon',
        happySessionId: happierSessionId,
        pid: runnerPid,
        reattachedFromDiskMarker: true,
        happySessionMetadataFromLocalWebhook: webhookMetadata,
        ...(input.spawnOptions ? { spawnOptions: input.spawnOptions } : {}),
        ...(input.ambiguousAgentMetadata ? { vendorResumeId } : {}),
        ...(input.nativeSource === 'stale_descriptor'
          ? {
              vendorResumeId,
              spawnOptions: {
                directory: projectDir,
                resume: otherNativeId,
                backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
              },
            }
          : {}),
      };
      const credentials = {
        token: 'account-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials;
      const api = {
        getAccountEncryptionMode: async () => 'plain' as const,
        getConnectedServiceCredentialPlain: async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision: NEW_CREDENTIAL_REVISION,
        }),
        getConnectedServiceCredentialSealed: async () => null,
        readConnectedServiceCredentialHealth: async ({ profileId }: Readonly<{ profileId: string }>) => (profileId === 'emc'
          ? { kind: 'found' as const, status: 'connected' as const, health: null }
          : { kind: 'not_found' as const }),
        getConnectedServiceAuthGroup: async () => ({
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'failover',
          displayName: 'Failover',
          policy,
          activeProfileId: 'emc',
          generation: 2,
          runtimeStateRevision: 0,
          state: { v: 1 as const },
          members: [
            {
              v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'failover', profileId: 'emc',
              priority: 100, enabled: true, state: {}, createdAt: 1, updatedAt: 1,
            },
            {
              v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'failover', profileId: 'other',
              priority: 90, enabled: true, state: {}, createdAt: 2, updatedAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        }),
      };
      const daemon = createConnectedServiceRestartReplacementHarness({
        tracked,
        sessionId: happierSessionId,
        target: rematerialize
          ? { serviceId: 'claude-subscription', profileId: 'emc', groupId: '', generation: 0 }
          : { serviceId: 'claude-subscription', profileId: 'emc', groupId: 'failover', generation: 2 },
      });
      // Server boundary: the session-metadata write.
      const persistSessionBindings = vi.fn(async () => {});

      const result = await switchSessionConnectedServiceAuth({
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        ...(input.switchReason ? { switchReason: input.switchReason } : {}),
        core: createConnectedServiceSessionAuthSwitchCore({
          locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
        }),
        postSwitchVerificationMode: {
          kind: 'disabled_for_test_only',
          reason: 'this gate exercises continuity selection, not later provider activity',
        },
        getChildren: () => [tracked],
        api,
        materializeRuntimeAuthSelection: async (materializerInput) => {
          const binding = materializerInput.normalizedBindings.bindingsByServiceId['claude-subscription'];
          if (!binding || binding.source !== 'connected') {
            throw new Error('expected a connected Claude subscription binding');
          }
          return await materializeClaudeConnectedServiceRuntimeAuthSelection({
            credentials,
            api: api as unknown as ApiClient,
            activeServerDir,
            input: materializerInput,
            baseSelection: binding.selection === 'group'
              ? {
                  serviceId: 'claude-subscription' as const,
                  binding,
                  profileId: 'emc',
                  groupId: 'failover',
                  activeProfileId: 'emc',
                  fallbackProfileId: 'other',
                  generation: 2,
                  credentialRevision: NEW_CREDENTIAL_REVISION,
                  record,
                }
              : {
                  serviceId: 'claude-subscription' as const,
                  binding,
                  profileId: 'emc',
                  credentialRevision: NEW_CREDENTIAL_REVISION,
                  record,
                },
            processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude') },
          });
        },
        // The daemon's switch continuity composition (startDaemon): tracked context with the
        // persisted session metadata, then the daemon adapter with default account settings.
        resolveContinuity: async (continuityInput) => {
          const context = resolveTrackedConnectedServiceSwitchContinuityContext({
            agentId: continuityInput.agentId,
            baseDir: activeServerDir,
            tracked: continuityInput.tracked,
            persistedSessionMetadata: persistedMetadata,
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
            ...(continuityInput.runtimeAuthSelection === undefined
              ? {}
              : { runtimeAuthSelection: continuityInput.runtimeAuthSelection }),
          });
        },
        restartSession: daemon.restartSession,
        hotApply: async () => { throw new Error('this adoption must not hot-apply'); },
        persistSessionBindings,
        registerHotApplyTargets: vi.fn(),
        emitSessionEvent: vi.fn(),
        request: {
          sessionId: happierSessionId,
          agentId: 'claude',
          bindings: nextBindings,
          ...(rematerialize
            ? { rematerializeServiceId: 'claude-subscription' as const }
            : { expectedGroupGenerationByServiceId: { 'claude-subscription': input.expectedGroupGeneration ?? 2 } }),
        },
      } satisfies SwitchSessionConnectedServiceAuthInput);
      return {
        result, daemon, persistSessionBindings, tracked, projectDir, checkedDir, checkedNativeId, nextBindings,
        memberClaudeConfigDir,
      };
    }

    async function expectSameSessionReplacement(input: Readonly<{
      daemon: ReturnType<typeof createConnectedServiceRestartReplacementHarness>;
      directory: string;
      bindings: ConnectedServiceBindingsV1;
      selection: Readonly<Record<string, unknown>>;
      resume?: string;
    }>) {
      expect(input.daemon.runnerSignals()).toEqual([[runnerPid, 'SIGTERM']]);
      await vi.waitFor(() => expect(input.daemon.spawnSession).toHaveBeenCalledOnce());
      expect(input.daemon.onRespawnTerminal).not.toHaveBeenCalled();
      const replacement = input.daemon.spawnSession.mock.calls[0]?.[0];
      expect(replacement).toMatchObject({
        existingSessionId: happierSessionId,
        resume: input.resume ?? vendorResumeId,
        directory: input.directory,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: input.bindings,
      });
      expect(readConnectedServiceChildSelectionsFromEnv(replacement?.environmentVariables ?? {}))
        .toMatchObject([input.selection]);
    }

    const groupSelection = {
      kind: 'group', serviceId: 'claude-subscription', groupId: 'failover', activeProfileId: 'emc', generation: 2,
    };
    const profileSelection = { kind: 'profile', serviceId: 'claude-subscription', profileId: 'emc' };

    it('relaunches a daemon-reattached session without spawn options as the same session in the group', async () => {
      const { result, daemon, persistSessionBindings, projectDir, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
      });

      expect(result.ok ? null : { errorCode: result.errorCode, diagnostics: result.diagnostics }).toBeNull();
      expect(result).toMatchObject({
        ok: true,
        action: 'restart_requested',
        continuityByServiceId: { 'claude-subscription': 'restart_rematerialize' },
      });
      expect(persistSessionBindings).toHaveBeenCalledOnce();
      await expectSameSessionReplacement({ daemon, directory: projectDir, bindings: nextBindings, selection: groupSelection });
    });

    it.each(['persisted_only', 'persisted_differs_from_webhook'] as const)(
      'relaunches the adopted session in the directory continuity checked (%s)',
      async (cwdSource) => {
        const { result, daemon, checkedDir, nextBindings } = await runAdoption({ nativeSessionFileExists: true, cwdSource });

        expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
        await expectSameSessionReplacement({ daemon, directory: checkedDir, bindings: nextBindings, selection: groupSelection });
      },
    );

    it('relaunches an unchanged rematerialized binding in the directory continuity checked', async () => {
      const { result, daemon, checkedDir, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
        binding: 'rematerialize_profile',
        cwdSource: 'persisted_differs_from_webhook',
      });

      expect(result.ok ? null : { errorCode: result.errorCode, diagnostics: result.diagnostics }).toBeNull();
      expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
      await expectSameSessionReplacement({ daemon, directory: checkedDir, bindings: nextBindings, selection: profileSelection });
    });

    it('leaves the checked directory for the runtime-auth recovery owner restart of a rematerialized binding', async () => {
      const { result, daemon, tracked, checkedDir, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
        binding: 'rematerialize_profile',
        cwdSource: 'persisted_differs_from_webhook',
        switchReason: 'automatic_runtime_failure',
      });

      expect(result).toMatchObject({ ok: true, action: 'metadata_updated' });
      expect(daemon.restartSession).not.toHaveBeenCalled();
      // The runtime-auth recovery owner restarts the same tracked runner through the same daemon
      // restart path (maybeRestartAfterRuntimeGroupSwitch -> restartSession(tracked)).
      await daemon.restartSession(tracked);
      await expectSameSessionReplacement({ daemon, directory: checkedDir, bindings: nextBindings, selection: profileSelection });
    });

    it('preserves the Claude backend for a partial descriptor whose directory is empty', async () => {
      const { result, daemon, checkedDir, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
        spawnOptions: { directory: '' },
      });

      expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
      await expectSameSessionReplacement({ daemon, directory: checkedDir, bindings: nextBindings, selection: groupSelection });
    });

    it('refuses before any persistence or signal when the session backend cannot be established', async () => {
      const { result, daemon, persistSessionBindings, tracked } = await runAdoption({
        nativeSessionFileExists: true,
        spawnOptions: { directory: '' },
        ambiguousAgentMetadata: true,
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'restart_replacement_unavailable',
        diagnostics: { failurePhase: 'continuity', attemptedAction: 'restart_requested' },
      });
      expect(persistSessionBindings).not.toHaveBeenCalled();
      expect(daemon.restartSession).not.toHaveBeenCalled();
      expect(daemon.runnerSignals()).toEqual([]);
      expect(daemon.spawnSession).not.toHaveBeenCalled();
      expect(tracked.spawnOptions).toEqual({ directory: '' });
    });

    it('adopts a session whose home predates source records without reading or recording a source', async () => {
      const { result, daemon, persistSessionBindings, projectDir, nextBindings, memberClaudeConfigDir } = await runAdoption({
        nativeSessionFileExists: true,
        memberHomeSource: 'unrecorded_legacy',
      });

      expect(result.ok ? null : { errorCode: result.errorCode, diagnostics: result.diagnostics }).toBeNull();
      expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
      expect(persistSessionBindings).toHaveBeenCalledOnce();
      await expectSameSessionReplacement({ daemon, directory: projectDir, bindings: nextBindings, selection: groupSelection });
      // Credential-only rematerialization: the legacy home's unknown source is neither read nor replaced.
      if (!memberClaudeConfigDir) throw new Error('fixture: Claude config dir must resolve');
      expect(await readConnectedServiceStateSharingNativeSourceRecord(memberClaudeConfigDir)).toEqual({ kind: 'unrecorded' });
    });

    it.each(['stale_descriptor', 'persisted_differs'] as const)(
      'relaunches the adopted session with the native id continuity checked (%s)',
      async (nativeSource) => {
        const { result, daemon, persistSessionBindings, checkedDir, checkedNativeId, nextBindings } = await runAdoption({
          nativeSessionFileExists: true,
          nativeSource,
        });

        expect(result.ok ? null : { errorCode: result.errorCode, diagnostics: result.diagnostics }).toBeNull();
        expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
        expect(persistSessionBindings).toHaveBeenCalledOnce();
        await expectSameSessionReplacement({
          daemon, directory: checkedDir, bindings: nextBindings, selection: groupSelection, resume: checkedNativeId,
        });
      },
    );

    it('relaunches an unchanged rematerialized binding with the native id continuity checked', async () => {
      const { result, daemon, checkedDir, checkedNativeId, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
        binding: 'rematerialize_profile',
        nativeSource: 'persisted_differs',
      });

      expect(result).toMatchObject({ ok: true, action: 'restart_requested' });
      await expectSameSessionReplacement({
        daemon, directory: checkedDir, bindings: nextBindings, selection: profileSelection, resume: checkedNativeId,
      });
    });

    it('leaves the checked native id for the runtime-auth recovery owner restart of a rematerialized binding', async () => {
      const { result, daemon, tracked, checkedDir, checkedNativeId, nextBindings } = await runAdoption({
        nativeSessionFileExists: true,
        binding: 'rematerialize_profile',
        nativeSource: 'stale_descriptor',
        switchReason: 'automatic_runtime_failure',
      });

      expect(result).toMatchObject({ ok: true, action: 'metadata_updated' });
      expect(daemon.restartSession).not.toHaveBeenCalled();
      // Harness-driven: the runtime-auth recovery owner's restart of the same tracked runner is
      // invoked directly here, not through handleConnectedServiceRuntimeAuthFailureForSession.
      await daemon.restartSession(tracked);
      await expectSameSessionReplacement({
        daemon, directory: checkedDir, bindings: nextBindings, selection: profileSelection, resume: checkedNativeId,
      });
    });

    it('refuses a terminal-started marker session before any persistence or retirement signal', async () => {
      const { result, daemon, persistSessionBindings, tracked } = await runAdoption({
        nativeSessionFileExists: true,
        startedBy: 'terminal',
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'restart_replacement_unavailable',
        diagnostics: { failurePhase: 'continuity', attemptedAction: 'restart_requested' },
      });
      expect(persistSessionBindings).not.toHaveBeenCalled();
      expect(daemon.restartSession).not.toHaveBeenCalled();
      expect(daemon.runnerSignals()).toEqual([]);
      expect(daemon.spawnSession).not.toHaveBeenCalled();
      expect(tracked.spawnOptions).toBeUndefined();
    });

    it('reports the same refusal from a dry-run preflight of a terminal-started marker session', async () => {
      const { result, daemon, persistSessionBindings } = await runAdoption({
        nativeSessionFileExists: true,
        startedBy: 'terminal',
        dryRun: true,
      });

      expect(result).toMatchObject({ ok: false, errorCode: 'restart_replacement_unavailable' });
      expect(persistSessionBindings).not.toHaveBeenCalled();
      expect(daemon.runnerSignals()).toEqual([]);
    });

    it.each(['daemon', 'terminal'] as const)(
      'refuses without a restart when the native session is not reachable from the group home (startedBy=%s)',
      async (startedBy) => {
        const { result, daemon, persistSessionBindings } = await runAdoption({ nativeSessionFileExists: false, startedBy });

        // The resume proof ran against the group target and missed; it was not skipped for absent inputs.
        expect(result).toMatchObject({
          ok: false,
          errorCode: 'provider_session_state_unavailable_for_resume',
          diagnostics: {
            failurePhase: 'continuity',
            continuity: { reachabilityMissReason: 'claude_session_not_in_native_store' },
          },
        });
        expect(daemon.restartSession).not.toHaveBeenCalled();
        expect(daemon.runnerSignals()).toEqual([]);
        expect(persistSessionBindings).not.toHaveBeenCalled();
      },
    );

    it('converges a real adoption with a stale expected generation onto the current group generation', async () => {
      const { result, daemon } = await runAdoption({ nativeSessionFileExists: true, expectedGroupGeneration: 1 });

      expect(result).toMatchObject({
        ok: true,
        action: 'restart_requested',
        continuityByServiceId: { 'claude-subscription': 'restart_rematerialize' },
      });
      expect(daemon.restartSession).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(daemon.spawnSession).toHaveBeenCalledOnce());
      expect(daemon.spawnSession.mock.calls[0]?.[0]).toMatchObject({
        existingSessionId: happierSessionId,
        resume: vendorResumeId,
      });
    });

    it('rejects a dry-run adoption preflight whose expected generation is stale, without effects', async () => {
      const { result, daemon, persistSessionBindings } = await runAdoption({
        nativeSessionFileExists: true,
        expectedGroupGeneration: 1,
        dryRun: true,
      });

      expect(result).toMatchObject({ ok: false, errorCode: 'group_generation_conflict' });
      expect(daemon.restartSession).not.toHaveBeenCalled();
      expect(persistSessionBindings).not.toHaveBeenCalled();
    });
  });
});
