import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import type { PreservedDirectoryEntries } from '@/utils/fs/replaceDirectoryAtomically';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceResolvedSelection } from './materializeConnectedServicesForSpawn';
import type { ConnectedServiceRefreshFailureCategory } from '../credentials/lifecycleTypes';
import type {
  ConnectedServiceGroupMutationTarget,
} from '../credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '../credentials/lifecycleTypes';

export type ConnectedServicesMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: CatalogAgentId;
  severity?: 'warning' | 'blocking';
  serviceId?: ConnectedServiceId;
  requestedStateMode?: string;
  effectiveStateMode?: string;
  entryName?: string;
  reason?: string;
  credentialRefreshFailure?: Readonly<{
    category: ConnectedServiceRefreshFailureCategory;
    providerStatus?: number;
    providerErrorCode?: string;
  }>;
}>;

/**
 * Who names the provider-native configuration/state source a materialization reads and links.
 *
 * - `caller_env`: the producing caller (a direct launch or a daemon spawn) admits the source named by
 *   its own environment. A target that already records a different admitted source is a conflict.
 * - `recorded`: a rematerializer that did not produce the target (the daemon's refresh/external
 *   revision distribution) may use only the source the target recorded when it was produced; its own
 *   environment never names a source.
 */
export type ConnectedServiceNativeSourceAuthority = 'caller_env' | 'recorded';

/**
 * A materialization was refused, before any source traversal or target write, because the target's
 * admitted native source is unrecorded (for a `recorded` rematerializer), conflicts with the one
 * requested, or is recorded in a manifest that cannot be read or trusted. Distinct from credential
 * failures: it says nothing about the credential's health.
 */
export class ConnectedServiceNativeSourceProvenanceError extends Error {
  constructor(
    readonly code:
      | 'connected_service_native_source_unrecorded'
      | 'connected_service_native_source_conflict'
      | 'connected_service_native_source_invalid',
    readonly targetRoot: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectedServiceNativeSourceProvenanceError';
  }
}

export const CONNECTED_SERVICE_MATERIALIZATION_REASONS = Object.freeze({
  authoritativeGroupTargetSuperseded: 'authoritative_group_target_changed_before_materialization',
} as const);

export function isAuthoritativeGroupTargetSupersededMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking'
    && diagnostic.reason === CONNECTED_SERVICE_MATERIALIZATION_REASONS.authoritativeGroupTargetSuperseded;
}

export function isBlockingConnectedServicesMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking';
}

export function collectBlockingConnectedServicesMaterializationDiagnostics(
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] | undefined,
): readonly ConnectedServicesMaterializationDiagnostic[] {
  return (diagnostics ?? []).filter(isBlockingConnectedServicesMaterializationDiagnostic);
}

export type ConnectedServicesMaterializeResult = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot?: string | null;
  preserveUnprovidedEntriesAcrossPromotion?: readonly PreservedDirectoryEntries[];
  afterPromote?: (input: Readonly<{
    env: Record<string, string>;
    targetMaterializedRoot: string | null;
    finalRootDir: string;
  }>) => Promise<void> | void;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

export type ConnectedServicesProviderMaterializerInput = Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  rootDir: string;
  previousMaterializedRoot?: string | null;
  existingSessionMetadata?: unknown;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  nativeSourceAuthority: ConnectedServiceNativeSourceAuthority;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  /** Existing-state handoff publishes credentials without copying or reconciling provider state. */
  sessionStateMode?: 'existing';
  /** Discovery owns a disposable home, never an account's durable conversation store. */
  materializationPurpose?: 'probe';
  cleanupRoot: () => void;
  /** Retain only owned filesystem work, never credential HTTP or provider callbacks. */
  writeArtifacts?: <T>(write: () => Promise<T>) => Promise<T>;
  validateGroupMutationCurrentness?: (
    input: ConnectedServiceGroupMutationTarget,
  ) => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>;

export type ConnectedServicesProviderMaterializer = (
  params: ConnectedServicesProviderMaterializerInput,
) => Promise<ConnectedServicesMaterializeResult | null>;
