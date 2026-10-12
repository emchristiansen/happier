import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const DEVIN_CORE: AgentCoreConfig = {
    id: 'devin',
    displayNameKey: 'agentInput.agent.devin',
    subtitleKey: 'profiles.aiBackend.devinSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'devin' }),
    uiConnectedService: { serviceId: null, label: 'Devin', connectRoute: null },
    flavorAliases: ['devin', 'devin-cli'],
    cli: buildCatalogProviderCliUiConfig('devin'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: { kind: getAgentSessionModesKind('devin') },
    model: getAgentModelConfig('devin'),
    resume: buildAgentResumeUiConfig({
        agentId: 'devin',
        uiVendorResumeIdLabelKey: 'sessionInfo.devinSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.devinSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'devin' }),
    toolRendering: { hideUnknownToolsByDefault: false },
    tools: buildAgentToolsUiConfig({ agentId: 'devin' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'devin' }),
    ui: {
        agentPickerIconName: 'cpu',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
