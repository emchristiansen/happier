import type { ConnectedServiceId } from '@happier-dev/agents';
import type { AccountProfile, ConnectedServiceBindingsV1, ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import { readConnectedServicesDefaultAuthSettings, type ConnectedServicesDefaultAuthSettings } from '@happier-dev/protocol';
import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId as buildCoreConnectedServiceProfileOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceAccountGroupViableProfileId,
  type ConnectedServiceSessionProjection,
  type ConnectedServicesAccountGroupOption,
  type ConnectedServicesAccountGroupOptionsByServiceId,
  type ConnectedServicesAccountGroupReadiness,
  type ConnectedServicesProfileOption as CoreConnectedServicesProfileOption,
  type ConnectedServicesProfileOptionsByServiceId as CoreConnectedServicesProfileOptionsByServiceId,
  type ConnectedServicesSessionAgentCore,
} from '@happier-dev/agents';

import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
  CONNECTED_SERVICES_BINDINGS_KEY,
  parseConnectedServicesBindingsByServiceIdFromAgentOptionState,
  type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

export {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServicesBindingsPayload,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceAccountGroupViableProfileId,
};

export type ConnectedServicesProfileOption = CoreConnectedServicesProfileOption & Readonly<{
  unsupportedSubtitleKey?:
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle';
}>;

export type ConnectedServicesProfileOptionsByServiceId = Readonly<Record<string, ConnectedServicesProfileOption[]>>;
export type {
  ConnectedServicesAccountGroupOption,
  ConnectedServicesAccountGroupOptionsByServiceId,
  ConnectedServicesAccountGroupReadiness,
};

export type NewSessionConnectedServicesAgentCore = ConnectedServicesSessionAgentCore;
export type NewSessionConnectedServiceProjection = ConnectedServiceSessionProjection;

const EMPTY_DEFAULT_AUTH_SETTINGS: ConnectedServicesDefaultAuthByAgentIdV1 = {
  v: 1,
  bindingsByAgentId: {},
};

function parseConnectedServicesDefaultAuthSettings(settings: ConnectedServicesDefaultAuthSettings): ConnectedServicesDefaultAuthByAgentIdV1 {
  try {
    return readConnectedServicesDefaultAuthSettings(settings);
  } catch {
    return EMPTY_DEFAULT_AUTH_SETTINGS;
  }
}

function resolveUnsupportedProfileSubtitleKey(serviceId: ConnectedServiceId):
  | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
  | 'connectedServices.detail.connectSetupTokenSubtitle' {
  const entry = getConnectedServiceRegistryEntry(serviceId);
  return entry.supportsToken && entry.tokenKind === 'setup-token'
    ? 'connectedServices.detail.connectSetupTokenSubtitle'
    : 'connectedServices.defaultAuth.warning.connected_service_unsupported';
}

export function buildConnectedServiceProfileOptionsByServiceId(
  params: Parameters<typeof buildCoreConnectedServiceProfileOptionsByServiceId>[0],
): ConnectedServicesProfileOptionsByServiceId {
  const coreOptions = buildCoreConnectedServiceProfileOptionsByServiceId(params) as CoreConnectedServicesProfileOptionsByServiceId;
  const out: Record<string, ConnectedServicesProfileOption[]> = {};

  for (const [serviceId, options] of Object.entries(coreOptions)) {
    out[serviceId] = options.map((option) => option.status === 'unsupported_kind'
      ? {
          ...option,
          unsupportedSubtitleKey: resolveUnsupportedProfileSubtitleKey(serviceId as ConnectedServiceId),
        }
      : option);
  }

  return out;
}

export type NewSessionConnectedServicesBindingsResolution = Readonly<{
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServiceAccountGroupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  connectedServicesBindingsPayload: ConnectedServiceBindingsV1 | null;
  accountGroupsFeatureEnabled: boolean;
  accountGroupSwitchingEnabled: boolean;
}>;

export function resolveNewSessionConnectedServicesBindingsForAgent(params: Readonly<{
  agentId: string;
  agentCore: NewSessionConnectedServicesAgentCore;
  agentOptionState: Record<string, unknown> | null | undefined;
  accountProfileConnectedServicesV2: AccountProfile['connectedServicesV2'];
  settings: {
    connectedServicesProfileLabelByKey: Record<string, string | undefined>;
    connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    connectedServicesDefaultAuthByAgentIdV1?: unknown;
    connectedServicesAdditionalDefaultAuthByAgentIdV1?: unknown;
  };
  connectedServicesFeatureEnabled: boolean;
  accountGroupsFeatureEnabled: boolean;
  connectedServicesBindingsByServiceIdOverride?: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> | null;
}>): NewSessionConnectedServicesBindingsResolution {
  const supportedConnectedServiceIds = resolveAgentSupportedConnectedServiceIds({
    connectedServicesFeatureEnabled: params.connectedServicesFeatureEnabled,
    agentCore: params.agentCore,
  });
  const connectedServiceProfileOptionsByServiceId = buildConnectedServiceProfileOptionsByServiceId({
    accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2,
    agentCore: params.agentCore,
    supportedConnectedServiceIds,
    labelsByKey: params.settings.connectedServicesProfileLabelByKey,
  });
  const connectedServiceAccountGroupOptionsByServiceId = buildConnectedServiceAccountGroupOptionsByServiceId({
    accountGroupsFeatureEnabled: params.accountGroupsFeatureEnabled,
    accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2,
    supportedConnectedServiceIds,
  });
  const explicitConnectedServicesBindingsByServiceId = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
    agentOptionState: params.agentOptionState,
  });
  const hasExplicitConnectedServicesBindings = Boolean(
    params.agentOptionState
    && Object.prototype.hasOwnProperty.call(params.agentOptionState, CONNECTED_SERVICES_BINDINGS_KEY),
  );
  const connectedServicesDefaultAuthSettings = parseConnectedServicesDefaultAuthSettings(
    params.settings,
  );
  const normalizedAgentId = params.agentId.trim();
  const connectedServicesBindingsByServiceId = params.connectedServicesBindingsByServiceIdOverride
    ?? (
      hasExplicitConnectedServicesBindings || !normalizedAgentId
        ? explicitConnectedServicesBindingsByServiceId
        : connectedServicesDefaultAuthSettings.bindingsByAgentId[normalizedAgentId]?.bindingsByServiceId
          ?? explicitConnectedServicesBindingsByServiceId
    );
  const accountGroupSwitchingEnabled = Boolean(params.agentCore.connectedServices?.sessionAuthSwitch);
  const connectedServicesBindingsPayload = buildConnectedServicesBindingsPayload({
    supportedConnectedServiceIds,
    connectedServiceProfileOptionsByServiceId,
    accountGroupsFeatureEnabled: params.accountGroupsFeatureEnabled,
    accountGroupSwitchingEnabled,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServicesBindingsByServiceId,
    defaultProfileByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
  });

  return {
    supportedConnectedServiceIds,
    connectedServiceProfileOptionsByServiceId,
    connectedServiceAccountGroupOptionsByServiceId,
    connectedServicesBindingsByServiceId,
    connectedServicesBindingsPayload,
    accountGroupsFeatureEnabled: params.accountGroupsFeatureEnabled,
    accountGroupSwitchingEnabled,
  };
}
