import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const FX_CORE: AgentCoreConfig = {
    id: 'fx',
    displayNameKey: 'agentInput.agent.fx',
    subtitleKey: 'profiles.aiBackend.fxSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'fx' }),
    uiConnectedService: { serviceId: null, label: 'FX', connectRoute: null },
    flavorAliases: [],
    cli: buildCatalogProviderCliUiConfig('fx'),
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    sessionModes: { kind: getAgentSessionModesKind('fx') },
    model: getAgentModelConfig('fx'),
    resume: buildAgentResumeUiConfig({
        agentId: 'fx',
        uiVendorResumeIdLabelKey: 'sessionInfo.fxSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.fxSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'fx' }),
    toolRendering: { hideUnknownToolsByDefault: false },
    tools: buildAgentToolsUiConfig({ agentId: 'fx' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'fx' }),
    ui: { agentPickerIconName: 'flash-outline', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
};
