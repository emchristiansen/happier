import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { ConnectedServiceCredentialRecordV1Schema, SessionConnectedServiceAuthApplyGenerationResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { join } from 'node:path';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServicePreviousStateRoot } from '@/daemon/connectedServices/materialize/resolveConnectedServicePreviousStateRoot';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { resolveConnectedServiceSelectionHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { configuration } from '@/configuration';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

import { createCodexConnectedServicesMaterializer } from './createCodexConnectedServicesMaterializer';
import { readCodexAuthStoreProviderAccountId } from './readCodexAuthStoreProviderAccountId';

const CODEX_CONNECTED_SERVICE_AUTH_APPLY_TIMEOUT_MS = 60_000;

export const materializeCodexConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (params) => {
  if (params.input.serviceId !== 'openai-codex') return params.baseSelection;

  const metadata = params.input.persistedSessionMetadata
    ?? params.input.tracked?.happySessionMetadataFromLocalWebhook ?? null;
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const codexHome = typeof runtimeDescriptor?.homePath === 'string' && runtimeDescriptor.homePath.trim().length > 0
    ? runtimeDescriptor.homePath.trim()
    : null;
  let preparedSelection: unknown = params.baseSelection;
  const record = ConnectedServiceCredentialRecordV1Schema.safeParse(params.baseSelection.record);
  if (params.activeServerDir && record.success) {
    const group = params.input.groupMetadata;
    if (params.input.next.selection === 'group' && !group) {
      throw new Error('connected_service_group_target_missing');
    }
    const selection: ConnectedServiceResolvedSelection = params.input.next.selection === 'group' && group
      ? { kind: 'group', serviceId: 'openai-codex', record: record.data, policy: null,
          groupId: group.groupId, activeProfileId: group.activeProfileId,
          fallbackProfileId: group.fallbackProfileId, generation: group.generation,
          credentialRevision: params.baseSelection.credentialRevision }
      : { kind: 'profile', serviceId: 'openai-codex', record: record.data,
          profileId: params.baseSelection.profileId, credentialRevision: params.baseSelection.credentialRevision };
    const targetRoot = resolveConnectedServiceSelectionHomeDir({
      activeServerDir: params.activeServerDir, serviceId: 'openai-codex', agentId: 'codex',
      fallbackProfileId: params.baseSelection.profileId, selection,
    });
    // Preflight reports the same next-launch home without publishing credentials or importing state.
    if (params.input.mode === 'preflight') {
      return { ...params.baseSelection, targetMaterializedRoot: targetRoot,
        targetMaterializedEnv: { CODEX_HOME: join(targetRoot, 'codex-home') } };
    }
    const previousContext = resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'codex', baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      tracked: params.input.tracked, persistedSessionMetadata: metadata,
      cwd: params.input.cwd,
    });
    const previousMaterializedRoot = await resolveConnectedServicePreviousStateRoot({
      previousRoot: previousContext.targetMaterializedRoot,
      managedRoots: [join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
        join(params.activeServerDir, 'daemon', 'connected-services', 'homes')],
    });
    // Reuse the launch materializer: it alone owns state adoption and guarded pool-file writes.
    // Preparation precedes continuity even when no process/transport is currently available.
    const materialized = await createCodexConnectedServicesMaterializer()({
      agentId: 'codex', activeServerDir: params.activeServerDir, rootDir: targetRoot,
      previousMaterializedRoot,
      existingSessionMetadata: metadata, sessionDirectory: previousContext.cwd,
      recordsByServiceId: new Map([['openai-codex', record.data]]),
      selectionsByServiceId: new Map([['openai-codex', selection]]),
      accountSettings: params.accountSettings, processEnv: params.processEnv,
      validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
        api: params.api, credentials: params.credentials,
      }),
      cleanupRoot: () => {},
    });
    preparedSelection = { ...params.baseSelection,
      targetMaterializedRoot: materialized?.targetMaterializedRoot,
      targetMaterializedEnv: materialized?.env,
      materializationDiagnostics: materialized?.diagnostics };
  }
  if (!params.input.tracked || params.input.mode === 'preflight') return preparedSelection;
  const transport = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.input.sessionId,
  });
  if (!transport.ok) return preparedSelection;
  return {
    ...params.baseSelection,
    ...(preparedSelection && typeof preparedSelection === 'object' ? preparedSelection : {}),
    applyReason: params.input.applyReason ?? 'manual',
    // K5:fsm_switch this materializer only wires the provider-owned direct-live apply callback
    // into the session-auth FSM/runtime-auth owners; restart/hot-apply policy still lives there.
    applyConnectedServiceAuthGeneration: async (request: unknown) => {
      const rawResponse = await callSessionRpc({
        token: params.credentials.token,
        sessionId: transport.sessionId,
        ctx: transport.ctx,
        mode: transport.mode,
        timeoutMs: CODEX_CONNECTED_SERVICE_AUTH_APPLY_TIMEOUT_MS,
        method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
        request,
      });
      const parsedResponse = SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse(rawResponse);
      if (!parsedResponse.success) {
        throw new Error('invalid_connected_service_auth_apply_generation_response');
      }
      return parsedResponse.data;
    },
    ...(codexHome
      ? {
          readAuthStoreProviderAccountId: async () => await readCodexAuthStoreProviderAccountId(codexHome),
        }
      : {}),
  };
};
