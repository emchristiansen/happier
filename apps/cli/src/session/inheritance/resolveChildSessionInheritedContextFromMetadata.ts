import { isPermissionMode, type Metadata, type PermissionMode } from '@/api/types';
import {
  AcpConfigOptionOverridesV1Schema,
  AcpSessionModeOverrideV1Schema,
  ConnectedServiceBindingsV1Schema,
  ModelOverrideV1Schema,
  readSessionMcpSelectionV1FromMetadata,
  stripConnectedServicePerSessionAssignmentFields,
  type ConnectedServiceBindingsV1,
  type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import {
  readSessionMetadataConnectedServiceBindings,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
} from '@happier-dev/agents';

export const CHILD_SESSION_INHERITANCE_FIELDS = {
  permission: 'permission',
  model: 'model',
  mode: 'mode',
  config: 'config',
  connectedServices: 'connectedServices',
  mcpSelection: 'mcpSelection',
  profileId: 'profileId',
} as const;

export type ChildSessionInheritanceField =
  (typeof CHILD_SESSION_INHERITANCE_FIELDS)[keyof typeof CHILD_SESSION_INHERITANCE_FIELDS];

export const CHILD_SESSION_INHERITANCE_FIELD_SETS = {
  fork: [
    CHILD_SESSION_INHERITANCE_FIELDS.permission,
    CHILD_SESSION_INHERITANCE_FIELDS.model,
    CHILD_SESSION_INHERITANCE_FIELDS.mode,
    CHILD_SESSION_INHERITANCE_FIELDS.config,
    CHILD_SESSION_INHERITANCE_FIELDS.connectedServices,
  ],
  sessionAgentSpawn: [
    CHILD_SESSION_INHERITANCE_FIELDS.permission,
    CHILD_SESSION_INHERITANCE_FIELDS.model,
    CHILD_SESSION_INHERITANCE_FIELDS.mode,
    CHILD_SESSION_INHERITANCE_FIELDS.config,
    CHILD_SESSION_INHERITANCE_FIELDS.connectedServices,
    CHILD_SESSION_INHERITANCE_FIELDS.mcpSelection,
    CHILD_SESSION_INHERITANCE_FIELDS.profileId,
  ],
} as const satisfies Record<string, readonly ChildSessionInheritanceField[]>;

export type ChildSessionInheritedSpawnOverrides = {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  mcpSelection?: SessionMcpSelectionV1;
  profileId?: string;
};

export type ChildSessionInheritedMetadataOverrides = Pick<
  Metadata,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'modelOverrideV1'
  | 'sessionModesV1'
  | 'sessionModelsV1'
  | 'sessionConfigOptionsV1'
  | 'sessionModeOverrideV1'
  | 'sessionConfigOptionOverridesV1'
  | 'acpSessionModesV1'
  | 'acpSessionModelsV1'
  | 'acpConfigOptionsV1'
  | 'acpSessionModeOverrideV1'
  | 'acpConfigOptionOverridesV1'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
  | 'profileId'
> & {
  mcpSelectionV1?: SessionMcpSelectionV1;
};

export type ChildSessionInheritedSource =
  | Readonly<{ kind: 'metadata'; key: string }>
  | Readonly<{ kind: 'runtimeDescriptorMetadata'; key: string }>;

export type ChildSessionInheritedSources = Partial<Record<
  | 'permissionMode'
  | 'modelId'
  | 'agentModeId'
  | 'sessionConfigOptionOverrides'
  | 'connectedServices'
  | 'mcpSelection'
  | 'profileId',
  ChildSessionInheritedSource
>>;

export type ChildSessionInheritedContext = Readonly<{
  spawn: ChildSessionInheritedSpawnOverrides;
  metadata: ChildSessionInheritedMetadataOverrides;
  sources: ChildSessionInheritedSources;
}>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasField(
  fields: ReadonlySet<ChildSessionInheritanceField>,
  field: ChildSessionInheritanceField,
): boolean {
  return fields.has(field);
}

function cloneSessionModesState(
  value: unknown,
): Metadata['sessionModesV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionModesV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModeId) ||
    !Array.isArray(state.availableModes)
  ) {
    return undefined;
  }
  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    currentModeId: state.currentModeId,
    availableModes: state.availableModes
      .filter((mode) => mode && isNonEmptyString(mode.id) && isNonEmptyString(mode.name))
      .map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(isNonEmptyString(mode.description) ? { description: mode.description } : {}),
      })),
  };
}

function cloneSessionModelsState(
  value: unknown,
): Metadata['sessionModelsV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionModelsV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModelId) ||
    !Array.isArray(state.availableModels)
  ) {
    return undefined;
  }
  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    currentModelId: state.currentModelId,
    availableModels: state.availableModels
      .filter((model) => model && isNonEmptyString(model.id) && isNonEmptyString(model.name))
      .map((model) => {
        const modelOptions = Array.isArray(model.modelOptions)
          ? cloneProviderOptionEntries(model.modelOptions)
          : undefined;
        return {
          id: model.id,
          name: model.name,
          ...(isNonEmptyString(model.description) ? { description: model.description } : {}),
          ...(isFiniteNumber(model.contextWindowTokens) ? { contextWindowTokens: model.contextWindowTokens } : {}),
          ...(modelOptions ? { modelOptions } : {}),
        };
      }),
  };
}

function isAllowedConfigValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

type ProviderOptionEntry = NonNullable<
  NonNullable<Metadata['sessionConfigOptionsV1']>['configOptions']
>[number];

/**
 * Session model entries and config options share the same provider-option entry
 * shape. Clone it in one place so inherited copies never drift from the
 * canonical `Metadata` shape (e.g. fork inheritance dropping reasoning-effort
 * model options).
 */
function cloneProviderOptionEntries(
  entries: ReadonlyArray<unknown>,
): ProviderOptionEntry[] {
  return (entries as ReadonlyArray<ProviderOptionEntry | null | undefined>)
    .filter((option): option is ProviderOptionEntry =>
      !!option &&
      typeof option === 'object' &&
      isNonEmptyString(option.id) &&
      isNonEmptyString(option.name) &&
      isNonEmptyString(option.type) &&
      isAllowedConfigValue(option.currentValue),
    )
    .map((option) => ({
      id: option.id,
      name: option.name,
      type: option.type,
      currentValue: option.currentValue,
      ...(isNonEmptyString(option.description) ? { description: option.description } : {}),
      ...(isNonEmptyString(option.category) ? { category: option.category } : {}),
      ...(Array.isArray(option.options)
        ? {
          options: option.options
            .filter((choice) => choice && isNonEmptyString(choice.name) && isAllowedConfigValue(choice.value))
            .map((choice) => ({
              value: choice.value,
              name: choice.name,
              ...(isNonEmptyString(choice.description) ? { description: choice.description } : {}),
            })),
        }
        : {}),
    }));
}

function cloneSessionConfigOptionsState(
  value: unknown,
): Metadata['sessionConfigOptionsV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionConfigOptionsV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !Array.isArray(state.configOptions)
  ) {
    return undefined;
  }

  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    configOptions: cloneProviderOptionEntries(state.configOptions),
  };
}

function resolveInheritedConnectedServices(params: Readonly<{
  metadata: Record<string, unknown> | null | undefined;
  providerId: string | null | undefined;
}>): Readonly<{ value: ConnectedServiceBindingsV1; source: ChildSessionInheritedSource }> | null {
  // Spec A.1: a child inherits the parent's group/source, never its initialProfileId or assignment;
  // it makes its own decision and reservation.
  const explicit = ConnectedServiceBindingsV1Schema.safeParse(params.metadata?.connectedServices);
  if (explicit.success) {
    return {
      value: stripConnectedServicePerSessionAssignmentFields(explicit.data),
      source: { kind: 'metadata', key: 'connectedServices' },
    };
  }

  if (!isNonEmptyString(params.providerId)) return null;
  const derivedBindings = readSessionMetadataConnectedServiceBindings(params.metadata, params.providerId);
  if (Object.keys(derivedBindings).length === 0) return null;

  const derived = ConnectedServiceBindingsV1Schema.safeParse({
    v: 1,
    bindingsByServiceId: derivedBindings,
  });
  return derived.success
    ? {
      value: stripConnectedServicePerSessionAssignmentFields(derived.data),
      source: { kind: 'runtimeDescriptorMetadata', key: 'agentRuntimeDescriptorV1' },
    }
    : null;
}

export function resolveChildSessionInheritedContextFromMetadata(params: Readonly<{
  metadata: Record<string, unknown> | null | undefined;
  providerId?: string | null;
  fields: readonly ChildSessionInheritanceField[];
}>): ChildSessionInheritedContext {
  const fields = new Set(params.fields);
  const metadata = params.metadata;
  const spawn: ChildSessionInheritedSpawnOverrides = {};
  const metadataOverrides: ChildSessionInheritedMetadataOverrides = {};
  const sources: ChildSessionInheritedSources = {};

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.permission)) {
    const permission = resolvePermissionIntentFromSessionMetadata(metadata);
    if (permission && isPermissionMode(permission.intent)) {
      spawn.permissionMode = permission.intent;
      spawn.permissionModeUpdatedAt = permission.updatedAt;
      metadataOverrides.permissionMode = permission.intent;
      metadataOverrides.permissionModeUpdatedAt = permission.updatedAt;
      sources.permissionMode = { kind: 'metadata', key: 'permissionMode' };
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.model)) {
    const model = resolveMetadataStringOverrideV1(metadata, 'modelOverrideV1', 'modelId');
    if (model && model.value !== 'default') {
      spawn.modelId = model.value;
      spawn.modelUpdatedAt = model.updatedAt;
      sources.modelId = { kind: 'metadata', key: 'modelOverrideV1' };
    }

    const modelOverrideRaw = ModelOverrideV1Schema.safeParse(metadata?.modelOverrideV1);
    if (modelOverrideRaw.success) {
      metadataOverrides.modelOverrideV1 = modelOverrideRaw.data;
    }

    const sessionModels = cloneSessionModelsState(metadata?.sessionModelsV1);
    if (sessionModels) {
      metadataOverrides.sessionModelsV1 = sessionModels;
    }

    const acpSessionModels = cloneSessionModelsState(metadata?.acpSessionModelsV1);
    if (acpSessionModels) {
      metadataOverrides.acpSessionModelsV1 = acpSessionModels;
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.mode)) {
    const sessionModes = cloneSessionModesState(metadata?.sessionModesV1);
    if (sessionModes) {
      metadataOverrides.sessionModesV1 = sessionModes;
    }

    const sessionModeOverrideRaw = AcpSessionModeOverrideV1Schema.safeParse(metadata?.sessionModeOverrideV1);
    if (sessionModeOverrideRaw.success) {
      metadataOverrides.sessionModeOverrideV1 = sessionModeOverrideRaw.data;
      if (isNonEmptyString(sessionModeOverrideRaw.data.modeId)) {
        spawn.agentModeId = sessionModeOverrideRaw.data.modeId;
        spawn.agentModeUpdatedAt = sessionModeOverrideRaw.data.updatedAt;
        sources.agentModeId = { kind: 'metadata', key: 'sessionModeOverrideV1' };
      }
    }

    const acpSessionModes = cloneSessionModesState(metadata?.acpSessionModesV1);
    if (acpSessionModes) {
      metadataOverrides.acpSessionModesV1 = acpSessionModes;
    }

    const acpModeOverrideRaw = AcpSessionModeOverrideV1Schema.safeParse(metadata?.acpSessionModeOverrideV1);
    if (acpModeOverrideRaw.success) {
      metadataOverrides.acpSessionModeOverrideV1 = acpModeOverrideRaw.data;
      if (!spawn.agentModeId && isNonEmptyString(acpModeOverrideRaw.data.modeId)) {
        spawn.agentModeId = acpModeOverrideRaw.data.modeId;
        spawn.agentModeUpdatedAt = acpModeOverrideRaw.data.updatedAt;
        sources.agentModeId = { kind: 'metadata', key: 'acpSessionModeOverrideV1' };
      }
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.config)) {
    const configOptions = cloneSessionConfigOptionsState(metadata?.sessionConfigOptionsV1);
    if (configOptions) {
      metadataOverrides.sessionConfigOptionsV1 = configOptions;
    }

    const sessionConfigOverridesRaw = AcpConfigOptionOverridesV1Schema.safeParse(metadata?.sessionConfigOptionOverridesV1);
    if (sessionConfigOverridesRaw.success) {
      metadataOverrides.sessionConfigOptionOverridesV1 = sessionConfigOverridesRaw.data;
      sources.sessionConfigOptionOverrides = {
        kind: 'metadata',
        key: 'sessionConfigOptionOverridesV1',
      };
    }

    const acpConfigOptions = cloneSessionConfigOptionsState(metadata?.acpConfigOptionsV1);
    if (acpConfigOptions) {
      metadataOverrides.acpConfigOptionsV1 = acpConfigOptions;
    }

    const acpConfigOverridesRaw = AcpConfigOptionOverridesV1Schema.safeParse(metadata?.acpConfigOptionOverridesV1);
    if (acpConfigOverridesRaw.success) {
      metadataOverrides.acpConfigOptionOverridesV1 = acpConfigOverridesRaw.data;
      if (!sources.sessionConfigOptionOverrides) {
        sources.sessionConfigOptionOverrides = {
          kind: 'metadata',
          key: 'acpConfigOptionOverridesV1',
        };
      }
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.connectedServices)) {
    const connectedServices = resolveInheritedConnectedServices({
      metadata,
      providerId: params.providerId,
    });
    if (connectedServices) {
      spawn.connectedServices = connectedServices.value;
      metadataOverrides.connectedServices = connectedServices.value;
      sources.connectedServices = connectedServices.source;

      if (isFiniteNumber(metadata?.connectedServicesUpdatedAt)) {
        spawn.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
        metadataOverrides.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
      }
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.mcpSelection)) {
    const mcpSelection = isRecord(metadata?.mcpSelectionV1)
      ? readSessionMcpSelectionV1FromMetadata(metadata)
      : null;
    if (mcpSelection) {
      spawn.mcpSelection = mcpSelection;
      metadataOverrides.mcpSelectionV1 = mcpSelection;
      sources.mcpSelection = { kind: 'metadata', key: 'mcpSelectionV1' };
    }
  }

  if (hasField(fields, CHILD_SESSION_INHERITANCE_FIELDS.profileId)) {
    const rawProfileId = metadata?.profileId;
    if (isNonEmptyString(rawProfileId)) {
      const profileId = rawProfileId.trim();
      spawn.profileId = profileId;
      metadataOverrides.profileId = profileId;
      sources.profileId = { kind: 'metadata', key: 'profileId' };
    }
  }

  return { spawn, metadata: metadataOverrides, sources };
}
