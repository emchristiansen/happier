import type { ApiClient } from '@/api/api';
import { materializeConnectedServiceRuntimeAuthSelectionThroughCatalog } from '@/backends/catalog';
import { resolveConnectedServiceCredentialsWithRevisions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  ConnectedServiceCredentialRevisionV1Schema,
  type AccountSettings,
} from '@happier-dev/protocol';

import { createConnectedServiceAuthGenerationApplyFailureError } from '../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function materializeSessionConnectedServiceRuntimeAuthSelection(params: Readonly<{
  credentials: Credentials;
  api: ApiClient;
  activeServerDir?: string;
  input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
  accountSettings?: AccountSettings | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<unknown | null> {
  if (params.input.next.source !== 'connected') return null;
  const binding = params.input.normalizedBindings.bindingsByServiceId[params.input.serviceId];
  if (!binding || binding.source !== 'connected') return null;

  const previousSelection = findConnectedServiceChildSelection(
    params.input.tracked?.spawnOptions?.environmentVariables ?? {},
    params.input.serviceId,
  );
  const previousGroupSelection =
    binding.selection === 'group'
    && previousSelection?.kind === 'group'
    && previousSelection.groupId === binding.groupId
      ? previousSelection
      : null;
  const groupMetadata =
    binding.selection === 'group'
    && params.input.groupMetadata?.groupId === binding.groupId
      ? params.input.groupMetadata
      : null;
  const profileId = binding.selection === 'group'
    ? readNonEmptyString(params.input.next.profileId)
      || readNonEmptyString(groupMetadata?.activeProfileId)
      || readNonEmptyString(previousGroupSelection?.activeProfileId)
      || readNonEmptyString(binding.profileId)
    : readNonEmptyString(binding.profileId);
  if (!profileId) return null;

  const credentialsByServiceId = await resolveConnectedServiceCredentialsWithRevisions({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.input.serviceId, profileId }],
  });
  const resolvedCredential = credentialsByServiceId.get(params.input.serviceId);
  if (!resolvedCredential) return null;
  if (params.input.expectedCredentialRevision !== undefined) {
    const actualCredentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
      resolvedCredential.credentialRevision,
    );
    if (!actualCredentialRevision.success) {
      throw createConnectedServiceAuthGenerationApplyFailureError({
        errorCode: 'credential_revision_missing',
      });
    }
    if (actualCredentialRevision.data !== params.input.expectedCredentialRevision) {
      throw createConnectedServiceAuthGenerationApplyFailureError({
        errorCode: 'credential_revision_superseded',
      });
    }
  }

  const baseSelection = {
    serviceId: params.input.serviceId,
    binding,
    profileId,
    credentialRevision: resolvedCredential.credentialRevision,
    ...(binding.selection === 'group'
      ? {
          groupId: binding.groupId,
          activeProfileId: profileId,
          fallbackProfileId: readNonEmptyString(groupMetadata?.fallbackProfileId)
            || readNonEmptyString(previousGroupSelection?.fallbackProfileId)
            || profileId,
          generation: typeof groupMetadata?.generation === 'number'
            ? groupMetadata.generation
            : typeof previousGroupSelection?.generation === 'number'
              ? previousGroupSelection.generation
              : 0,
        }
      : {}),
    record: resolvedCredential.record,
  };

  return await materializeConnectedServiceRuntimeAuthSelectionThroughCatalog(params.input.agentId, {
    ...params,
    baseSelection,
  }) ?? baseSelection;
}
