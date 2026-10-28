import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const DROID_CORE: AgentCoreConfig = {
    id: 'droid',
    displayNameKey: 'agentInput.agent.droid',
    subtitleKey: 'profiles.aiBackend.droidSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'droid' }),
    uiConnectedService: { serviceId: null, label: 'Factory Droid', connectRoute: null },
    flavorAliases: ['factory-droid'],
    cli: buildCatalogProviderCliUiConfig('droid'),
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    sessionModes: { kind: getAgentSessionModesKind('droid') },
    model: getAgentModelConfig('droid'),
    resume: buildAgentResumeUiConfig({
        agentId: 'droid',
        uiVendorResumeIdLabelKey: 'sessionInfo.droidSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.droidSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'droid' }),
    toolRendering: { hideUnknownToolsByDefault: false },
    tools: buildAgentToolsUiConfig({ agentId: 'droid' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'droid' }),
    ui: { agentPickerIconName: 'cpu', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
};
