import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import {
    LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
    readNewestMetadataAliasValue,
    resolveMetadataStringOverrideStateV1FromAliases,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODE_OVERRIDE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
    type MetadataStringOverrideStateV1,
} from '@happier-dev/agents';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    parseSessionConfigOptionOverridesState,
    parseSessionConfigOptionsState,
    parseSessionModelsState,
    parseSessionModesState,
} from './schema';

type SessionModesState = NonNullable<Metadata['sessionModesV1'] | Metadata['acpSessionModesV1']>;
type SessionModelsState = NonNullable<Metadata['sessionModelsV1'] | Metadata['acpSessionModelsV1']>;
type SessionConfigOptionsState = NonNullable<Metadata['sessionConfigOptionsV1'] | Metadata['acpConfigOptionsV1']>;
type SessionConfigOptionOverridesState = NonNullable<Metadata['sessionConfigOptionOverridesV1'] | Metadata['acpConfigOptionOverridesV1']>;

function readMetadata(metadata: Metadata | null | undefined): Record<string, unknown> {
    return ((metadata as unknown) ?? {}) as Record<string, unknown>;
}

export function readSessionModesState(metadata: Metadata | null | undefined): SessionModesState | null {
    return readNewestMetadataAliasValue({
        metadata: readMetadata(metadata),
        keys: [SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY],
        parse: parseSessionModesState,
    }) ?? null;
}

export function readSessionModeOverrideState(
    metadata: Metadata | null | undefined,
): MetadataStringOverrideStateV1 | null {
    return resolveMetadataStringOverrideStateV1FromAliases(
        readMetadata(metadata),
        [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
        'modeId',
    );
}

export function readSessionModelsState(metadata: Metadata | null | undefined): SessionModelsState | null {
    return readNewestMetadataAliasValue({
        metadata: readMetadata(metadata),
        keys: [SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY],
        parse: parseSessionModelsState,
    }) ?? null;
}

export function readSessionConfigOptionsState(metadata: Metadata | null | undefined): SessionConfigOptionsState | null {
    return readNewestMetadataAliasValue({
        metadata: readMetadata(metadata),
        keys: [SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY],
        parse: parseSessionConfigOptionsState,
    }) ?? null;
}

export function readSessionConfigOptionOverridesState(
    metadata: Metadata | null | undefined,
): SessionConfigOptionOverridesState | null {
    return readNewestMetadataAliasValue({
        metadata: readMetadata(metadata),
        keys: [SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY],
        parse: parseSessionConfigOptionOverridesState,
    }) ?? null;
}

/** Match control metadata to the session's backend, preserving configured ACP identity. */
export function matchesSessionControlProvider(params: Readonly<{
    agentId: AgentId;
    metadata: Metadata | null | undefined;
    provider: string | null | undefined;
}>): boolean {
    const configuredBackend = readAcpConfiguredBackendV1FromMetadata(params.metadata);
    const expectedProvider = configuredBackend
        ? `acp:${configuredBackend.backendId}`
        : params.agentId;
    return params.provider === expectedProvider;
}
