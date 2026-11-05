import { resolveConnectedServiceCredentialLifecycleDescriptor } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceCredentialStorageCleanupKind } from './lifecycleTypes';

/** Home disposal revokes credentials; transcripts and native resume state remain on disk. */
export async function deleteConnectedServiceHomeCredentials(input: Readonly<{
  agentId: CatalogAgentId;
  rootDir: string;
  kind: ConnectedServiceCredentialStorageCleanupKind;
}>): Promise<void> {
  const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(input.agentId);
  await descriptor.credentialStorageCleanup?.deleteCredentialStorageForHomeRoot(input);
}
