import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { isPerSessionOwnedGroupSelection, parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

export type RuntimeRecoverySelection =
  | Readonly<{
      kind: 'profile';
      serviceId: string;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: string;
      groupId: string;
      activeProfileId?: string;
      fallbackProfileId?: string;
    }>;

export type ConnectedServiceRuntimeAuthRecoverySelectionSource =
  | 'child_env'
  | 'tracked_spawn_options'
  | 'session_metadata'
  | 'classification';

type ResolvedRuntimeRecoverySelection = Readonly<{
  selection: RuntimeRecoverySelection | null;
  source: ConnectedServiceRuntimeAuthRecoverySelectionSource | null;
}>;

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapParsedBindingSelectionToRuntimeRecoverySelection(
  selection: RuntimeRecoverySelection | null,
  failedProfileId?: string,
): RuntimeRecoverySelection | null {
  if (selection?.kind === 'group' && failedProfileId) {
    return {
      ...selection,
      fallbackProfileId: failedProfileId,
    };
  }
  return selection;
}

function matchesReportedGroupId(
  selection: RuntimeRecoverySelection | null,
  reportedGroupId: string,
): boolean {
  return selection?.kind === 'group' && selection.groupId === reportedGroupId;
}

function shouldUseDurableSelection<TSelection extends RuntimeRecoverySelection>(
  selection: TSelection | null,
  reportedGroupId: string,
  preferDurableGroup: boolean,
): selection is TSelection {
  if (!selection) return false;
  if (selection.kind === 'profile') return true;
  return !preferDurableGroup
    || !reportedGroupId
    || matchesReportedGroupId(selection, reportedGroupId);
}

export function isGroupRuntimeRecoverySelection(
  selection: RuntimeRecoverySelection,
): selection is Extract<RuntimeRecoverySelection, Readonly<{ kind: 'group' }>> {
  return selection.kind === 'group';
}

export function resolveConnectedServiceRuntimeAuthRecoverySelection(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  trackedConnectedServices?: unknown;
  sessionMetadataConnectedServices?: unknown;
  environmentVariables?: Readonly<Record<string, string | undefined>> | null;
}>): ResolvedRuntimeRecoverySelection {
  const serviceId = normalizeNonEmptyString(input.classification.serviceId);
  if (!serviceId) return { selection: null, source: null };

  const reportedProfileId = normalizeNonEmptyString(input.classification.profileId);
  const reportedGroupId = normalizeNonEmptyString(input.classification.groupId);
  const preferDurableGroup = Boolean(reportedProfileId);

  const childEnvSelection = readConnectedServiceChildSelectionsFromEnv(
    input.environmentVariables ?? {},
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  // A per-session-owned session runs in its member's own home, so its child selection is
  // profile-kind; its logical owner is still the group binding (spec A.4/A.5). Recovery follows the
  // durable group binding, with the physical member as the failed/fallback account.
  if (childEnvSelection?.kind === 'profile') {
    const ownedGroup = [input.trackedConnectedServices, input.sessionMetadataConnectedServices]
      .map((raw) => parseConnectedServiceBindingSelections(raw).find((candidate) => candidate.serviceId === serviceId) ?? null)
      .find((candidate) => candidate !== null && isPerSessionOwnedGroupSelection(candidate)) ?? null;
    if (ownedGroup?.kind === 'group' && (!reportedGroupId || ownedGroup.groupId === reportedGroupId)) {
      return {
        selection: {
          kind: 'group',
          serviceId: ownedGroup.serviceId,
          groupId: ownedGroup.groupId,
          // The physical member this runner serves on is the session's active account.
          activeProfileId: childEnvSelection.profileId,
          fallbackProfileId: reportedProfileId || childEnvSelection.profileId,
        },
        source: 'tracked_spawn_options',
      };
    }
  }
  if (shouldUseDurableSelection(childEnvSelection, reportedGroupId, preferDurableGroup)) {
    if (childEnvSelection.kind === 'profile') {
      return {
        selection: {
          kind: 'profile',
          serviceId: childEnvSelection.serviceId,
          profileId: childEnvSelection.profileId,
        },
        source: 'child_env',
      };
    }
    return {
      selection: {
        kind: 'group',
        serviceId: childEnvSelection.serviceId,
        groupId: childEnvSelection.groupId,
        activeProfileId: childEnvSelection.activeProfileId,
        fallbackProfileId: reportedProfileId || childEnvSelection.fallbackProfileId,
      },
      source: 'child_env',
    };
  }

  const trackedSelection = parseConnectedServiceBindingSelections(
    input.trackedConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (shouldUseDurableSelection(trackedSelection, reportedGroupId, preferDurableGroup)) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(trackedSelection, reportedProfileId),
      source: 'tracked_spawn_options',
    };
  }

  const metadataSelection = parseConnectedServiceBindingSelections(
    input.sessionMetadataConnectedServices,
  ).find((candidate) => candidate.serviceId === serviceId) ?? null;
  if (shouldUseDurableSelection(metadataSelection, reportedGroupId, preferDurableGroup)) {
    return {
      selection: mapParsedBindingSelectionToRuntimeRecoverySelection(metadataSelection, reportedProfileId),
      source: 'session_metadata',
    };
  }
  if (reportedProfileId) {
    if (reportedGroupId) {
      return {
        selection: {
          kind: 'group',
          serviceId,
          groupId: reportedGroupId,
          fallbackProfileId: reportedProfileId,
        },
        source: 'classification',
      };
    }
    return {
      selection: {
        kind: 'profile',
        serviceId,
        profileId: reportedProfileId,
      },
      source: 'classification',
    };
  }
  return { selection: null, source: null };
}
